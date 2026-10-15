import { randomUUID } from 'node:crypto'
import { access, constants, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron'
import type {
  Category,
  ClipboardItem,
  DownloadTask,
  HandoffRequest,
  IntegrationStatus,
  MediaCandidate,
  MediaVariant,
  NewDownload,
  Queue,
  RequestHeaders,
  Settings,
  SiteGrabOptions,
  SiteGrabResult,
  TaskPatch,
  ToolId
} from '@shared/types'
import { getPaths } from './bootstrap/paths.ts'
import { checkRegistered, ensureRegistered, readExtensionId } from './bridge/integration.ts'
import type { PipeServer } from './bridge/pipe-server.ts'
import type { BrowserHandoffInbox } from './bridge/handoff-inbox.ts'
import { directoryFor } from './categories.ts'
import { normalizeDownloadDirectory } from './destination-path.ts'
import { createTask, filenameForKind, kindForUrl, validateUrl } from './engine/create.ts'
import { mapConcurrent } from './engine/concurrency.ts'
import { importTorrentFile } from './engine/torrent-store.ts'
import { findDuplicate } from './engine/duplicate.ts'
import { buildTransferFile, buildUrlList, parseTransferFile } from './transfer-list.ts'
import { publicTask, publicTasks } from './public-task.ts'
import { listCredentials, removeCredential, saveCredential } from './credentials.ts'
import { discardReservedPath, sanitizeFilename, uniquePath } from './engine/naming.ts'
import type { DownloadManager } from './engine/manager.ts'
import { probeUrl } from './engine/probe.ts'
import { resolveTorrentItemPath } from './engine/torrent-path.ts'
import { inspectHlsMedia, resolveVariants } from './hls/playlist.ts'
import { couldBeHtmlPageUrl, isSupportedMediaPageUrl } from './media-url.ts'
import { getToolStatus, updateTool } from './tools.ts'
import { checkForUpdates } from './update.ts'
import { chosenYouTubeUrls, isSupportedYouTubeUrl } from './youtube-url.ts'
import { getYouTubePrimeStatus, resolveMediaPage, resolvePlaylist, resolveYouTube } from './youtube.ts'
import { MAX_PLAYLIST_ENTRIES, isPlaylistUrl, singleVideoUrl, type PlaylistEntry } from './youtube-playlist.ts'
import { iconForExtension, iconForSite } from './icons.ts'
import { thumbnailFor } from './thumbnails.ts'
import { checkCookies } from './cookie-check.ts'
import { listBrowsers } from './browser-icons.ts'
import {
  registerShellHandlers,
  shellHandlerStatus,
  unregisterShellHandlers
} from './shell-integration.ts'
import { logger } from './log.ts'
import type { Scheduler } from './queue/scheduler.ts'
import type { SiteProjectManager } from './site-grabber/projects.ts'
import {
  getCategories,
  getSettings,
  flushTasks,
  saveCategories,
  saveClipboardItems,
  saveSettings,
  persistTasks
} from './store.ts'
import {
  broadcast,
  closeHandoffWindow,
  setHandoffEvictListener,
  createProgressWindow,
  getMainWindow,
  send,
  showMainWindow,
  syncDropzoneWindow,
  updateProgressWindow
} from './windows.ts'

const log = logger('ipc')
let clipboardSave = Promise.resolve()
/** Guards `cookies:check`, which spawns yt-dlp and owns one progress bar. */
let cookieCheckRunning = false

export interface AppContext {
  manager: DownloadManager
  scheduler: Scheduler
  siteProjects: SiteProjectManager
  pipe: PipeServer
  media: MediaCandidate[]
  /**
   * Handoffs waiting for the user to confirm. Held in main rather than pushed
   * straight at the renderer because a cold start has no window yet: the host
   * can launch the app *in order to* service a download, and that request must
   * survive until there is something to show it in.
   */
  pendingHandoffs: HandoffRequest[]
  browserInbox: BrowserHandoffInbox
  /** Accept commits still writing to disk; cancel waits before deciding ownership. */
  handoffCommits: Map<string, Promise<void>>
  /**
   * Torrents and magnet links the shell asked Draco to open, waiting for a
   * window to show them in. Held here for the same reason `pendingHandoffs`
   * is: a double-clicked `.torrent` can be what started the app, and that
   * request has to outlive a bootstrap that has not created a window yet.
   */
  pendingOpens: string[]
  clipboardItems: ClipboardItem[]
  lastHandoffAt: number | null
  quit(): void
  /**
   * Starts or stops the clipboard poller. Injected for the same reason `quit`
   * is: the watcher is owned by `index.ts`, and reaching back for it with a
   * `require` produced a specifier no bundle ever contains.
   */
  setClipboardWatch(enabled: boolean): void
}

function publishClipboard(ctx: AppContext): void {
  const snapshot = ctx.clipboardItems.map((item) => ({ ...item }))
  send('clipboard:changed', snapshot)
  clipboardSave = clipboardSave
    .then(() => saveClipboardItems(snapshot))
    .catch((error) => log.warn(`clipboard inbox save failed: ${String(error)}`))
}

export function prepareClipboardItem(ctx: AppContext, rawUrl: string, existingId?: string): void {
  let url: string
  try {
    url = validateUrl(rawUrl)
  } catch {
    return
  }

  let item = existingId ? ctx.clipboardItems.find((entry) => entry.id === existingId) : undefined
  let created = false
  if (!item) {
    item = ctx.clipboardItems.find((entry) => entry.url === url)
    if (!item) {
      const now = Date.now()
      item = {
        id: randomUUID(),
        url,
        kind: isPlaylistUrl(url)
          ? 'playlist'
          : isSupportedYouTubeUrl(url)
          ? 'youtube'
          : isSupportedMediaPageUrl(url)
            ? 'media'
            : kindForUrl(url) === 'torrent' ? 'torrent' : 'file',
        status: 'fetching',
        createdAt: now,
        updatedAt: now,
        filename: null,
        size: null,
        mimeType: null,
        error: null
      }
      created = true
      ctx.clipboardItems.push(item)
      if (ctx.clipboardItems.length > 100) ctx.clipboardItems.splice(0, ctx.clipboardItems.length - 100)
    }
  }

  if (!created && item.status === 'fetching' && !existingId) {
    // The watcher can observe the same clipboard value again while its first
    // preparation is still running. Reuse that work rather than starting a
    // duplicate extractor and racing two writes into the same inbox row.
    return
  } else {
    item.status = 'fetching'
    item.updatedAt = Date.now()
    item.error = null
  }
  publishClipboard(ctx)

  const target = item
  void (async () => {
    try {
      if (target.kind === 'playlist') {
        /*
         * A listing, not a file. Resolving it through `resolveYouTube` - which
         * is what every other YouTube link does here - runs yt-dlp with
         * `--no-playlist`, so a `/playlist?list=...` came back with no formats
         * and the inbox row showed an error about PO tokens. One flat listing
         * is cheap and tells the row what it actually is.
         */
        const listing = await resolvePlaylist(target.url)
        target.playlist = { title: listing.title, count: listing.entries.length }
        target.youtube = undefined
        target.media = undefined
        target.probe = undefined
        target.filename = listing.title
        target.size = null
        target.mimeType = null
      } else if (target.kind === 'youtube') {
        const youtube = await resolveYouTube(target.url, { referer: target.url })
        const first = youtube.variants[0]
        target.youtube = youtube
        target.probe = undefined
        target.filename = youtube.title
        target.size = first?.estimatedSize ?? null
        target.mimeType = first?.container ? `video/${first.container}` : 'video'
      } else if (target.kind === 'media') {
        const media = await resolveMediaPage(target.url, { referer: target.url })
        applyClipboardMedia(target, media)
      } else {
        const probe = await probeUrl(target.url, { timeoutMs: getSettings().timeoutMs })
        if (isHtmlPage(probe.mimeType)) {
          const media = await resolveMediaPage(target.url, { referer: target.url })
          applyClipboardMedia(target, media)
        } else {
          target.probe = probe
          target.youtube = undefined
          target.media = undefined
          target.filename = probe.filename
          target.size = probe.size
          target.mimeType = probe.mimeType
        }
      }
      target.status = 'ready'
      target.error = null
    } catch (error) {
      // Sites commonly reject HEAD or ranged GET probes with 403 even though
      // their HTML or extractor endpoint is usable. Match the Save As flow by
      // trying page-media preparation before leaving a copied page in error.
      if (target.kind === 'file' && couldBeHtmlPageUrl(target.url)) {
        try {
          const media = await resolveMediaPage(target.url, { referer: target.url })
          applyClipboardMedia(target, media)
          target.status = 'ready'
          target.error = null
          target.updatedAt = Date.now()
          publishClipboard(ctx)
          return
        } catch {}
      }
      target.status = 'error'
      target.error = error instanceof Error ? error.message : String(error)
    }
    target.updatedAt = Date.now()
    publishClipboard(ctx)
  })()
}

function isHtmlPage(mimeType: string | null): boolean {
  return Boolean(mimeType && /^(text\/html|application\/xhtml\+xml)(?:;|$)/i.test(mimeType))
}

function applyClipboardMedia(
  target: ClipboardItem,
  media: NonNullable<ClipboardItem['media']>
): void {
  const first = media.variants[0]
  target.kind = 'media'
  target.media = media
  target.youtube = undefined
  target.probe = undefined
  target.filename = media.title
  target.size = first?.estimatedSize ?? null
  target.mimeType = first?.container
    ? `${first.youtube?.role === 'audio' ? 'audio' : 'video'}/${first.container}`
    : first?.youtube?.role === 'audio' ? 'audio' : 'video'
}

/**
 * Opens whatever the shell handed us: a magnet link, or a path to a `.torrent`
 * file that was double-clicked.
 *
 * A torrent file is imported rather than used where it lies - see
 * `engine/torrent-store.ts` - so from here on both cases are a magnet URI and
 * take the ordinary Add-torrent path, file picker and all.
 *
 * Nothing is downloaded by this. Opening a torrent means showing the user what
 * is in it; starting it is still their decision, which is the whole point of
 * the dialog it lands in.
 */
export async function openShellTarget(ctx: AppContext, target: string): Promise<void> {
  try {
    const url = /^magnet:/i.test(target)
      ? validateUrl(target)
      : (await importTorrentFile(target)).magnetUri

    // The dialog is the destination, so a repeat of one already waiting would
    // only queue a second identical window behind the first.
    if (!ctx.pendingOpens.includes(url)) {
      ctx.pendingOpens.push(url)
      if (ctx.pendingOpens.length > 12) ctx.pendingOpens.shift()
    }
    log.info(`shell open: ${target}`)
    showMainWindow()
    send('shell:open', null)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn(`could not open ${target}: ${message}`)
    showMainWindow()
    send('toast', { kind: 'error', message })
  }
}

/** Admit only requests for which a confirmation window can remain available. */
export function pushPendingHandoff(ctx: AppContext, request: HandoffRequest): void {
  if (ctx.pendingHandoffs.length >= 12) throw new Error('Too many pending confirmations')
  ctx.pendingHandoffs.push(request)
}

/**
 * Builds a task from a submission, filing it into the category folder its name
 * and MIME type imply. `onProbed` runs this again once the real filename is
 * known, so a URL that gave nothing away still lands in the right place.
 */
export function placeTask(input: NewDownload): DownloadTask {
  const settings = getSettings()
  const categories = getCategories()
  const url = validateUrl(input.url)

  // The grabber says what it is; anything else - the extension, the clipboard,
  // a hand-typed URL - is inferred from the address.
  const kind = input.kind ?? kindForUrl(url)
  const chosenName = input.filename ? filenameForKind(input.filename, kind) : undefined

  const filename = chosenName ?? ''
  const { dir, categoryId } = input.dir
    ? { dir: normalizeDownloadDirectory(input.dir), categoryId: input.categoryId ?? null }
    : directoryFor(
        settings.downloadDir,
        categories,
        // A page batch is one user-visible unit and must share one physical
        // folder. Do not split its videos and images back into extension-based
        // category directories; an explicit/default/host category still wins.
        input.groupFolder ? '' : filename,
        null,
        input.categoryId ?? settings.defaultCategoryId,
        url
      )
  const groupFolder = input.groupFolder
    ? sanitizeFilename(input.groupFolder).replace(/^\.+|[. ]+$/g, '').slice(0, 120)
    : ''
  const groupedDir = groupFolder ? normalizeDownloadDirectory(join(dir, groupFolder)) : dir

  return createTask({
    url,
    sourceUrl: input.sourceUrl,
    thumbnailUrl: input.thumbnailUrl,
    groupId: input.groupId?.slice(0, 128),
    groupName: input.groupName?.trim().slice(0, 160),
    groupFolder: groupFolder || undefined,
    dir: groupedDir,
    dirLocked: Boolean(input.dir),
    audioUrl: input.audioUrl,
    audioTracks: input.audioTracks,
    youtube: input.youtube ? { ...input.youtube } : undefined,
    filename: chosenName,
    categoryId,
    queueId: input.queueId ?? null,
    expectedSize: input.expectedSize,
    headers: input.headers,
    subtitles: input.subtitles,
    description: input.description,
    expectedChecksum: input.expectedChecksum,
    postProcess: input.postProcess,
    selectedFiles: input.selectedFiles,
    torrentFiles: input.torrentFiles,
    kind
  })
}

/** Resolve page inputs before treating them as downloadable file bytes. */
export async function prepareTaskInput(input: NewDownload): Promise<NewDownload> {
  const url = validateUrl(input.url)
  if (input.youtube || input.kind === 'torrent') return { ...input, url }
  if (isPlaylistUrl(url)) throw new Error('Choose videos from the playlist dialog before adding this link')
  if (!isSupportedYouTubeUrl(url)) return { ...input, url }

  const resolved = await resolveYouTube(url, { ...input.headers, referer: input.headers?.referer ?? url })
  const variant = pickPlaylistVariant(resolved.variants, null, false)
  if (!variant?.youtube) throw new Error('No downloadable YouTube video format was found')
  return {
    ...input,
    url: variant.url || url,
    sourceUrl: url,
    thumbnailUrl: input.thumbnailUrl ?? resolved.thumbnailUrl,
    filename: input.filename ?? `${resolved.title}.${variant.container ?? 'mp4'}`,
    audioUrl: variant.audioUrl ?? null,
    audioTracks: variant.audioTracks,
    expectedSize: variant.estimatedSize ?? input.expectedSize,
    youtube: {
      pageUrl: url,
      videoFormatId: variant.youtube.videoFormatId,
      audioFormatId: variant.youtube.audioFormatId ?? null,
      height: variant.height,
      role: variant.youtube.role ?? 'video'
    }
  }
}

/** Re-files a task after the probe, unless the caller pinned a destination. */
export function refileTask(task: DownloadTask): void {
  if (task.dirLocked) return
  if (task.groupFolder) return
  if (task.filenameLocked && task.categoryId) return

  const settings = getSettings()
  const { dir, categoryId } = directoryFor(
    settings.downloadDir,
    getCategories(),
    task.filename,
    task.mimeType,
    task.categoryId ?? settings.defaultCategoryId,
    task.url
  )

  task.dir = task.groupFolder
    ? normalizeDownloadDirectory(join(dir, task.groupFolder))
    : dir
  task.categoryId = categoryId
}

/**
 * Opens the per-download window for a download the user just started.
 *
 * Only for downloads someone actually asked for: a queue draining overnight, or
 * the restore pass at startup, must not paper the desktop with windows nobody
 * pressed a button for.
 */
export function announce(task: DownloadTask): void {
  if (task.kind === 'torrent') return
  if (!getSettings().showProgressWindow) return
  log.info(`progress window for ${task.filename || task.url}`)
  createProgressWindow(task.id)
  updateProgressWindow(task)
}

export function registerIpc(ctx: AppContext): void {
  // When the handoff-window cap evicts a window, its pending request must go
  // with it, or the request lingers until the list cap evicts it instead.
  setHandoffEvictListener((requestId) => {
    const at = ctx.pendingHandoffs.findIndex((request) => request.id === requestId)
    if (at >= 0) ctx.pendingHandoffs.splice(at, 1)
    void ctx.browserInbox.remove(requestId).catch((error) =>
      log.error(`could not remove evicted browser confirmation ${requestId}: ${String(error)}`)
    )
  })

  const handle = <T extends unknown[], R>(
    channel: string,
    fn: (...args: T) => R | Promise<R>
  ): void => {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return await fn(...(args as T))
      } catch (err) {
        log.error(`${channel} failed`, err)
        throw err instanceof Error ? err : new Error(String(err))
      }
    })
  }

  /* tasks */

  handle('tasks:list', () => publicTasks(ctx.manager.list()))

  handle('tasks:add', async (input: NewDownload) => {
    const task = placeTask(await prepareTaskInput(input))
    ctx.manager.add(task, input.autoStart !== false)
    if (input.autoStart !== false && input.suppressProgressWindow !== true) announce(task)
    return publicTask(task)
  })

  // One round-trip for a batch of URLs (a link drop, a pasted list) instead of
  // N `tasks:add` calls that each open a progress window - dropping 40 links
  // must not open 40 Chromium renderer processes.
  handle('tasks:addMany', async (inputs: NewDownload[]) => {
    // Validate the complete batch before admitting any rows. Retrying a batch
    // with an invalid later URL must not duplicate its successful prefix.
    const prepared = await mapConcurrent(inputs, 3, prepareTaskInput)
    const tasks = prepared.map((input) => placeTask(input))
    tasks.forEach((task, index) => ctx.manager.add(task, inputs[index].autoStart !== false))
    if (
      tasks.length === 1 &&
      inputs[0].autoStart !== false &&
      inputs[0].suppressProgressWindow !== true
    ) announce(tasks[0])
    return publicTasks(tasks)
  })

  handle('tasks:get', (id: string) => {
    const task = ctx.manager.get(id)
    return task ? publicTask(task) : null
  })

  /**
   * Connection and peer diagnostics for one task.
   *
   * Pulled rather than pushed: these used to ride the 4 Hz progress feed for
   * every task at once, so every window deserialised a torrent's entire file
   * and peer list four times a second whether or not anything was drawing it.
   * Asking also marks the task as watched, which is what tells the torrent
   * runner to keep the panel fresh.
   */
  handle('tasks:detail', (id: string) =>
    typeof id === 'string' ? ctx.manager.detail(id) : null
  )

  /**
   * Whether this download has been had before. Reported, never enforced: asking
   * for it again is a legitimate request, and a downloader that argues about it
   * is worse than one that stays quiet.
   */
  handle('tasks:findDuplicate', (input: { url: string; pageUrl?: string | null; filename?: string; dir?: string }) => {
    if (typeof input?.url !== 'string') return null
    return findDuplicate(ctx.manager.list(), {
      url: input.url,
      pageUrl: typeof input.pageUrl === 'string' ? input.pageUrl : null,
      filename: typeof input.filename === 'string' ? input.filename : undefined,
      dir: typeof input.dir === 'string' ? input.dir : undefined
    })
  })

  /** Writes the list somewhere it can be read on another machine. */
  handle('tasks:export', async (ids: string[] | null): Promise<number> => {
    const all = ctx.manager.list()
    const chosen = Array.isArray(ids) && ids.length > 0
      ? all.filter((task) => ids.includes(task.id))
      : all
    if (chosen.length === 0) throw new Error('There is nothing to export')

    const window = getMainWindow()
    const result = await dialog.showSaveDialog(window ?? new BrowserWindow({ show: false }), {
      title: 'Export downloads',
      defaultPath: `draco-downloads-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [
        { name: 'Draco download list', extensions: ['json'] },
        { name: 'Plain URL list', extensions: ['txt'] }
      ]
    })
    if (result.canceled || !result.filePath) return 0

    // The extension chooses the format, because that is what the user just
    // told the save dialog they wanted.
    const asText = /\.txt$/i.test(result.filePath)
    await writeFile(
      result.filePath,
      asText ? buildUrlList(chosen) : JSON.stringify(buildTransferFile(chosen), null, 2),
      'utf8'
    )
    log.info(`exported ${chosen.length} download(s) to ${result.filePath}`)
    return chosen.length
  })

  /** Reads either format back. Imported rows are never started by themselves. */
  handle('tasks:import', async (): Promise<number> => {
    const window = getMainWindow()
    const result = await dialog.showOpenDialog(window ?? new BrowserWindow({ show: false }), {
      title: 'Import downloads',
      properties: ['openFile'],
      filters: [
        { name: 'Download lists', extensions: ['json', 'txt'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePaths[0]) return 0

    const text = await readFile(result.filePaths[0], 'utf8')
    if (text.length > 8 * 1024 * 1024) throw new Error('That file is too large to be a download list')

    const items = parseTransferFile(text)
    if (items.length === 0) throw new Error('No downloadable links were found in that file')

    let added = 0
    const queueIds = new Set(ctx.scheduler.list().map((queue) => queue.id))
    for (const item of items) {
      try {
        const task = placeTask(await prepareTaskInput({ ...item, queueId: item.queueId && queueIds.has(item.queueId) ? item.queueId : null }))
        ctx.manager.add(task, false)
        added++
      } catch {
        // One malformed row must not cost the rest of the file.
      }
    }
    persistTaskSnapshot(ctx)
    log.info(`imported ${added} download(s) from ${result.filePaths[0]}`)
    return added
  })

  handle('tasks:probe', (url: string, headers: RequestHeaders | undefined) =>
    probeUrl(validateUrl(url), { headers, timeoutMs: getSettings().timeoutMs })
  )

  handle('youtube:resolve', (url: string) => {
    const pageUrl = validateUrl(url)
    if (!isSupportedYouTubeUrl(pageUrl)) throw new Error('Not a supported YouTube URL')
    return resolveYouTube(pageUrl, { referer: pageUrl })
  })

  /** What one playlist or channel link stands for, without resolving any of it. */
  handle('youtube:playlist', async (url: string) => {
    const pageUrl = validateUrl(url)
    if (!isPlaylistUrl(pageUrl)) throw new Error('That is not a YouTube playlist or channel')
    const listing = await resolvePlaylist(pageUrl)
    return { ...listing, singleVideoUrl: singleVideoUrl(pageUrl) }
  })

  /**
   * Turns a listing into downloads.
   *
   * Entries are resolved one at a time in the background rather than up front:
   * a hundred videos would be a hundred yt-dlp runs before the first byte
   * moved, and YouTube's signed URLs would have started expiring before the
   * last of them was even queued. Rows appear as each entry resolves, so the
   * list fills in while the earlier ones are already downloading.
   */
  handle('youtube:addPlaylist', (input: {
    entries: PlaylistEntry[]
    title: string
    height: number | null
    audioOnly: boolean
    queueId: string | null
    dir?: string
  }) => {
    const entries = (Array.isArray(input?.entries) ? input.entries : [])
      .filter((entry): entry is PlaylistEntry => typeof entry?.url === 'string')
      .slice(0, MAX_PLAYLIST_ENTRIES)
    if (entries.length === 0) throw new Error('Nothing in that listing to download')

    const groupId = randomUUID()
    const groupName = String(input.title || 'Playlist').slice(0, 200)

    void expandPlaylist(ctx, entries, {
      groupId,
      groupName,
      height: typeof input.height === 'number' ? input.height : null,
      audioOnly: input.audioOnly === true,
      queueId: typeof input.queueId === 'string' ? input.queueId : null,
      dir: typeof input.dir === 'string' ? input.dir : undefined
    })

    return { accepted: entries.length, groupId }
  })

  /**
   * Calls off an expansion that is still resolving.
   *
   * There used to be no way to do this short of deleting the rows that had
   * already appeared and hoping the loop noticed - which it only did between
   * entries, and only once at least one had been added.
   */
  handle('youtube:cancelPlaylist', (groupId: string) =>
    typeof groupId === 'string' ? cancelPlaylistExpansion(groupId) : false
  )

  handle('media:resolvePage', (url: string, headers?: RequestHeaders) => {
    const pageUrl = validateUrl(url)
    if (!/^https?:/i.test(pageUrl)) throw new Error('Media pages must use HTTP or HTTPS')
    return resolveMediaPage(pageUrl, { ...headers, referer: headers?.referer ?? pageUrl })
  })

  handle('clipboard:list', () => ctx.clipboardItems.map((item) => ({ ...item })))
  handle('clipboard:retry', (id: string) => {
    const item = ctx.clipboardItems.find((entry) => entry.id === id)
    if (item && item.status !== 'fetching') prepareClipboardItem(ctx, item.url, id)
  })
  handle('clipboard:remove', (id: string) => {
    ctx.clipboardItems = ctx.clipboardItems.filter((item) => item.id !== id)
    publishClipboard(ctx)
  })

  handle('tasks:start', async (ids: string[]) => {
    const queues = new Set(ids.map((id) => ctx.manager.get(id)?.queueId).filter((id): id is string => Boolean(id)))
    for (const id of queues) await ctx.scheduler.startQueue(id)
    ctx.manager.start(ids)
  })
  handle('tasks:pause', (ids: string[]) => ctx.manager.pause(ids, true))
  handle('tasks:pauseAll', () => ctx.manager.pauseAll(true))
  handle('tasks:remove', (ids: string[], deleteFiles: boolean) =>
    ctx.manager.remove(ids, deleteFiles)
  )
  handle('tasks:removeCompleted', () => ctx.manager.removeCompleted())

  handle('tasks:update', async (id: string, patch: TaskPatch) => {
    const task = ctx.manager.get(id)
    if (!task) return null
    const nextFilename = typeof patch.filename === 'string' && patch.filename.trim()
      ? sanitizeFilename(patch.filename.trim(), task.filename || 'download') : task.filename
    const filenameChanged = nextFilename !== task.filename
    if (task.kind === 'torrent' && filenameChanged) {
      throw new Error('Torrent filenames are fixed by their metadata and cannot be renamed')
    }
    if (filenameChanged && task.status !== 'done') {
      throw new Error(task.status === 'downloading' || task.status === 'probing' || task.status === 'queued'
        ? 'Pause the download before changing its filename'
        : 'Resume or redownload this task before changing its filename')
    }
    if (typeof patch.queueId === 'string' && !ctx.scheduler.list().some((queue) => queue.id === patch.queueId)) {
      throw new Error('That queue no longer exists')
    }
    if (filenameChanged) {
      const currentPath = join(task.dir, task.filename)
      let targetPath: string | null = null
      try {
        await access(currentPath, constants.F_OK)
        targetPath = await uniquePath(task.dir, nextFilename)
        await rename(currentPath, targetPath)
        task.filename = targetPath.split(/[\\/]/).pop() || nextFilename
      } catch (err) {
        if (targetPath) await discardReservedPath(targetPath)
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
        task.filename = nextFilename
        task.status = 'missing'
      }
      task.filenameLocked = true
    }

    // Only fields the UI is allowed to edit. Letting a renderer patch `segments`
    // or `received` would let it corrupt the engine's own bookkeeping.
    if (typeof patch.description === 'string') task.description = patch.description.slice(0, 500)
    if (typeof patch.queueId === 'string' || patch.queueId === null) {
      const previousQueueId = task.queueId
      const wasActive = task.status === 'downloading' || task.status === 'probing' || task.status === 'queued'
      if (patch.queueId !== previousQueueId && wasActive) await ctx.manager.pause([id])
      await ctx.scheduler.syncTaskQueue(task.id, previousQueueId, patch.queueId)
      task.queueId = patch.queueId
      if (wasActive && patch.queueId === null) ctx.manager.start([id])
      ctx.scheduler.refresh()
    }
    // Clearing a group membership detaches the row from its batch; the files
    // stay where they are, group folder included.
    if (patch.groupId === null) {
      task.groupId = undefined
      task.groupName = undefined
    } else if (typeof patch.groupId === 'string') {
      task.groupId = patch.groupId
      if (typeof patch.groupName === 'string') task.groupName = patch.groupName
    }
    // UI-only task metadata should be persisted immediately enough that a clean
    // restart does not lose a rename/description/queue move.
    persistTaskSnapshot(ctx)
    ctx.manager.emitTasks()
    return publicTask(task)
  })

  handle('tasks:redownload', async (id: string) => {
    const task = ctx.manager.get(id)
    if (!task) return
    // Everything the original carried, not a subset of it. Dropping `dir` sent
    // a download the user had deliberately filed elsewhere back to the default
    // tree; dropping the group fields split a page batch out of its folder; and
    // dropping the torrent selection re-downloaded files they had deselected.
    const fresh = placeTask({
      url: task.url,
      sourceUrl: task.sourceUrl,
      // Preserve the original destination even if settings/categories changed.
      // placeTask appends groupFolder, which task.dir already contains.
      dir: task.groupFolder ? dirname(task.dir) : task.dir,
      thumbnailUrl: task.thumbnailUrl,
      categoryId: task.categoryId ?? undefined,
      groupId: task.groupId,
      groupName: task.groupName,
      groupFolder: task.groupFolder,
      filename: task.filenameLocked ? task.filename : undefined,
      headers: task.headers,
      subtitles: task.subtitles,
      description: task.description,
      expectedChecksum: task.expectedChecksum,
      postProcess: task.postProcess,
      queueId: task.queueId,
      kind: task.kind,
      audioUrl: task.audioUrl,
      audioTracks: task.audioTracks,
      selectedFiles: task.selectedFiles,
      torrentFiles: task.torrentFiles,
      youtube: task.youtube ? { pageUrl: task.youtube.pageUrl, videoFormatId: task.youtube.videoFormatId, audioFormatId: task.youtube.audioFormatId ?? null, height: task.youtube.height ?? null, role: task.youtube.role } : undefined
    })
    await ctx.manager.remove([id], false)
    ctx.manager.add(fresh, true)
    announce(fresh)
  })

  /*
   * Both of these answer whether the file was actually handed to the shell.
   * The progress window closes itself on a true - that is what finishing a
   * download and pressing Open means - and stays put on a false, because the
   * window has just become the only place the "missing" state is visible.
   */
  handle('tasks:open', async (id: string) => {
    const target = await openable(ctx, id)
    if (!target) return false
    // openPath resolves to an error string rather than rejecting; an empty one
    // is the only success.
    return (await shell.openPath(target)) === ''
  })

  handle('tasks:reveal', async (id: string) => {
    const target = await openable(ctx, id)
    if (!target) return false
    shell.showItemInFolder(target)
    return true
  })

  /**
   * Stops a finished torrent from seeding. Reported back so the caller can say
   * something when the row was not seeding in the first place.
   */
  handle('tasks:stopSeeding', (ids: string[]) => {
    const list = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
    return ctx.manager.stopSeeding(list)
  })

  handle('tasks:seeding', () => ctx.manager.seedingIds())

  /** Changes which files inside a torrent are wanted, running or not. */
  handle('tasks:setTorrentFiles', (id: string, paths: string[]) => {
    if (typeof id !== 'string' || !Array.isArray(paths)) return false
    const wanted = paths.filter((path): path is string => typeof path === 'string')
    const changed = ctx.manager.setTorrentFiles(id, wanted)
    if (changed) persistTaskSnapshot(ctx)
    return changed
  })

  handle('tasks:openTorrentItem', async (id: string, itemPath: string) => {
    const target = await openableTorrentItem(ctx, id, itemPath)
    return target ? (await shell.openPath(target)) === '' : false
  })

  handle('tasks:revealTorrentItem', async (id: string, itemPath: string) => {
    const target = await openableTorrentItem(ctx, id, itemPath)
    if (!target) return false
    shell.showItemInFolder(target)
    return true
  })

  /* the confirm window */

  const takeHandoff = (id: string): HandoffRequest => {
    const index = ctx.pendingHandoffs.findIndex((h) => h.id === id)
    if (index < 0) throw new Error('That download request has expired')
    return ctx.pendingHandoffs.splice(index, 1)[0]
  }

  handle('handoff:get', (id: string) => ctx.pendingHandoffs.find((h) => h.id === id) ?? null)

  handle('handoff:accept', async (id: string, input: NewDownload) => {
    if (ctx.handoffCommits.has(id)) throw new Error('That download is already being saved')
    const request = ctx.pendingHandoffs.find((h) => h.id === id)
    if (!request) throw new Error('That download request has expired')
    if (request.expiresAt && request.expiresAt <= Date.now()) throw new Error('That download request has expired')

    // The URL and the captured headers come from the request, not from the
    // window: the renderer is allowed to choose a name and a folder, not to
    // rewrite where the bytes are fetched from or what credentials go with them.
    const task = placeTask({
      ...input,
      url: request.url,
      sourceUrl: request.pageUrl ?? request.headers.referer,
      headers: request.headers
    })
    if (request.kind === 'file') task.handoffId = id
    ctx.manager.add(task, false)
    const commit = (async () => {
      try {
        await flushTasks()
      } catch (error) {
        await ctx.manager.remove([task.id], false)
        throw error
      }
    })()
    ctx.handoffCommits.set(id, commit)
    try {
      await commit
    } finally {
      ctx.handoffCommits.delete(id)
    }
    if (request.kind === 'file') {
      await ctx.browserInbox.remove(id).catch((error) =>
        log.error(`could not remove accepted browser confirmation ${id}: ${String(error)}`)
      )
    }
    takeHandoff(id)
    if (input.autoStart !== false) ctx.manager.start([task.id])
    if (input.autoStart !== false) announce(task)
    closeHandoffWindow(id)
    return publicTask(task)
  })

  handle('handoff:resolveMedia', async (id: string) => {
    const request = ctx.pendingHandoffs.find((h) => h.id === id)
    if (!request?.mediaId) throw new Error('That media request has expired')
    return resolveCandidate(ctx, request.mediaId)
  })

  // Lets the handoff popup show honest status ("still preparing the direct
  // link") instead of silently freezing on Start Download if the page-load
  // priming has not finished yet. Cheap synchronous lookup, safe to poll.
  handle('youtube:primeStatus', async (pageUrl: string) => getYouTubePrimeStatus(pageUrl))

  handle('handoff:acceptMedia', async (
    id: string,
    opts: { variantUrl: string; filename: string; dir?: string; categoryId?: string; queueId?: string; audioUrl?: string | null; audioTracks?: MediaVariant['audioTracks']; youtube?: { videoFormatId: string; audioFormatId?: string | null; role?: 'video' | 'audio' } }
  ) => {
    // Validate the media entry before consuming the pending handoff. A media
    // list can be cleared concurrently from another window; in that case the
    // request should remain recoverable rather than disappearing on failure.
    const request = ctx.pendingHandoffs.find((h) => h.id === id)
    if (!request) throw new Error('That download request has expired')
    const candidate = ctx.media.find((m) => m.id === request.mediaId)
    if (!candidate) throw new Error('That media entry is gone')
    // Metadata-only YouTube choices intentionally keep the watch page as a
    // placeholder. The engine resolves those itags after this window closes,
    // so an unavoidable player challenge never traps the user in a modal.
    const urls = resolveChosenUrls(candidate, opts)
    // The rung behind the chosen itag, kept so a refresh can still find this
    // quality if yt-dlp turns out not to list that itag at all.
    const chosenFormatId = opts.youtube?.videoFormatId
    const chosen = chosenFormatId
      ? candidate.variants.find((v) => v.youtube?.videoFormatId === chosenFormatId)
      : undefined
    const selectedVariant = candidate.variants.find((variant) => variant.url === opts.variantUrl)

    const task = placeTask({
      url: urls.url,
      sourceUrl: candidate.pageUrl,
      audioUrl: urls.audioUrl,
      audioTracks: opts.youtube ? undefined : opts.audioTracks,
      youtube: opts.youtube
        ? {
            pageUrl: candidate.pageUrl,
            videoFormatId: opts.youtube.videoFormatId,
            audioFormatId: opts.youtube.audioFormatId ?? null,
            role: opts.youtube.role ?? 'video',
            height: chosen?.height ?? null
          }
        : undefined,
      filename: opts.filename,
      dir: opts.dir,
      categoryId: opts.categoryId,
      queueId: opts.queueId,
      headers: candidate.headers,
      subtitles: candidate.subtitles,
      description: candidate.pageTitle,
      kind: candidate.type
    })
    // Carry the same estimate shown in the confirmation window into the
    // progress window. The HLS runner may refine it later, but must not start
    // from an unrelated average of whichever track happened to download first.
    task.size = selectedVariant?.estimatedSize ?? null

    ctx.manager.add(task, true)
    takeHandoff(id)
    announce(task)
    closeHandoffWindow(id)
    return publicTask(task)
  })

  handle('handoff:dismiss', async (id: string) => {
    if (ctx.handoffCommits.has(id)) return
    await ctx.browserInbox.remove(id)
    const index = ctx.pendingHandoffs.findIndex((h) => h.id === id)
    if (index >= 0) ctx.pendingHandoffs.splice(index, 1)
    closeHandoffWindow(id)
  })

  /* categories */

  handle('categories:list', () => getCategories())
  handle('categories:save', (categories: Category[]) => saveCategories(categories))

  /* queues */

  handle('queues:list', () => ctx.scheduler.list())
  handle('queues:save', (queue: Queue) => ctx.scheduler.save(queue))
  handle('queues:reorder', (id: string, ids: string[]) => ctx.scheduler.reorder(id, ids))
  handle('queues:remove', async (id: string) => {
    await ctx.scheduler.remove(id)
    // Queue removal clears task.queueId in memory; persist that mutation too,
    // otherwise a restart resurrects references to a queue that no longer exists.
    persistTasks(ctx.manager.list())
  })
  handle('queues:start', (id: string) => ctx.scheduler.startQueue(id))
  handle('queues:stop', (id: string) => ctx.scheduler.stopQueue(id))
  handle('queues:cancelPending', () => ctx.scheduler.cancelPending())

  /* settings and integration */

  handle('settings:get', () => getSettings())

  handle('settings:save', async (patch: Partial<Settings>) => {
    if (patch.downloadDir !== undefined) {
      patch = { ...patch, downloadDir: normalizeDownloadDirectory(patch.downloadDir) }
    }
    const next = await saveSettings(patch)
    ctx.manager.applySettings()
    if (patch.watchClipboard !== undefined) ctx.setClipboardWatch(patch.watchClipboard === true)
    if (patch.showDropzone !== undefined) syncDropzoneWindow(patch.showDropzone === true)
    if (patch.associateTorrents !== undefined) {
      // Registry work, so it is done off the settings round trip: the toggle
      // must not sit there waiting on reg.exe, and Options re-reads the real
      // state from `integration:get` anyway.
      void (next.associateTorrents ? registerShellHandlers() : unregisterShellHandlers())
        .catch((error) => log.warn(`shell handler update failed: ${String(error)}`))
    }
    return next
  })

  handle('settings:chooseDirectory', async (current?: string) => {
    const window = getMainWindow()
    const result = await dialog.showOpenDialog(window ?? new BrowserWindow({ show: false }), {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: current || getSettings().downloadDir
    })
    return result.canceled ? null : normalizeDownloadDirectory(result.filePaths[0])
  })

  handle('integration:get', async (): Promise<IntegrationStatus> => {
    return {
      extensionPath: getPaths().extensionDir,
      firefoxExtensionPath: getPaths().firefoxExtensionDir,
      extensionId: await readExtensionId(),
      registered: await checkRegistered(),
      shellHandlers: await shellHandlerStatus(),
      bridgeListening: ctx.pipe.listening,
      lastHandoffAt: ctx.lastHandoffAt
    }
  })

  handle('integration:register', async (): Promise<IntegrationStatus> => {
    const registered = await ensureRegistered()
    // One button, both integrations: someone pressing "Register" after
    // installing the extension expects the file association it was told about
    // in the same panel to be retried too.
    const shellHandlers = getSettings().associateTorrents
      ? await registerShellHandlers()
      : await shellHandlerStatus()
    return {
      extensionPath: getPaths().extensionDir,
      firefoxExtensionPath: getPaths().firefoxExtensionDir,
      extensionId: await readExtensionId(),
      registered,
      shellHandlers,
      bridgeListening: ctx.pipe.listening,
      lastHandoffAt: ctx.lastHandoffAt
    }
  })

  /* torrents opened from the shell */

  handle('shell:takePending', () => ctx.pendingOpens.splice(0, ctx.pendingOpens.length))

  handle('torrent:chooseFile', async (): Promise<string | null> => {
    const window = getMainWindow()
    const result = await dialog.showOpenDialog(window ?? new BrowserWindow({ show: false }), {
      title: 'Open torrent file',
      properties: ['openFile'],
      filters: [
        { name: 'Torrent files', extensions: ['torrent'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (result.canceled || !result.filePaths[0]) return null
    return (await importTorrentFile(result.filePaths[0])).magnetUri
  })

  /**
   * Torrent files dropped on a window. They take the same road as a
   * double-clicked one - imported into the store, then queued as pending opens
   * - so a drop of five files behaves exactly like selecting five in Explorer
   * and pressing Enter: one dialog, then the next.
   *
   * The renderer sends paths, never contents, and only a `.torrent` is acted
   * on; anything else in the drop is reported back as ignored.
   */
  handle('shell:openFiles', async (paths: string[]): Promise<number> => {
    const torrents = (Array.isArray(paths) ? paths : [])
      .filter((path) => typeof path === 'string' && path.toLowerCase().endsWith('.torrent'))
      // A dropped folder can be thousands of files; a drop is never worth that
      // many dialogs.
      .slice(0, 24)
    for (const path of torrents) await openShellTarget(ctx, path)
    return torrents.length
  })

  /**
   * Dragging a finished download out of the list and onto another application.
   *
   * `startDrag` is only valid while the renderer's `dragstart` is still being
   * handled, which is why this is a `send` and not an `invoke` - there is
   * nothing to wait for and no time to wait in. For the same reason the file
   * check here is synchronous: an `await` would land after the drag is gone.
   *
   * The renderer names task ids; every path is resolved here, so the worst a
   * compromised renderer can offer another app is a file Draco downloaded.
   */
  ipcMain.on('tasks:startDrag', (event, rawIds: unknown) => {
    const ids = Array.isArray(rawIds) ? rawIds.filter((id): id is string => typeof id === 'string') : []
    const files = ids
      .slice(0, 100)
      .map((id) => ctx.manager.get(id))
      .filter((task): task is DownloadTask => task?.status === 'done')
      .map((task) => join(task.dir, task.filename))
      .filter((path) => existsSync(path))
    if (files.length === 0) return

    try {
      event.sender.startDrag({ file: files[0], files, icon: dragIcon() })
    } catch (error) {
      log.warn(`could not start drag: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  /* saved site passwords - the secrets never cross this boundary */

  handle('credentials:list', () => listCredentials())
  handle('credentials:save', (input: { host: string; realm?: string; username: string; password: string }) =>
    saveCredential({
      host: String(input?.host ?? ''),
      realm: String(input?.realm ?? ''),
      username: String(input?.username ?? ''),
      password: String(input?.password ?? '')
    })
  )
  handle('credentials:remove', (id: string) => removeCredential(String(id)))

  handle('tools:status', (checkLatest: boolean) => getToolStatus(checkLatest === true))
  handle('tools:update', (id: ToolId) => updateTool(id))

  handle('clipboard:read', () => clipboard.readText().trim())
  handle('clipboard:write', (text: string) => clipboard.writeText(String(text)))
  handle('updates:check', () => checkForUpdates(getSettings().updateFeedUrl))
  handle('updates:open', async (raw: string) => {
    const url = validateUrl(raw)
    if (!url.startsWith('https://')) throw new Error('Update links must use HTTPS')
    await shell.openExternal(url)
  })
  handle('siteGrabber:start', async (input: SiteGrabOptions): Promise<SiteGrabResult> => {
    return ctx.siteProjects.create(input)
  })
  handle('siteGrabber:list', () => ctx.siteProjects.list())
  handle('siteGrabber:run', (id: string) => ctx.siteProjects.run(String(id)))
  handle('siteGrabber:remove', (id: string) => ctx.siteProjects.remove(String(id)))

  /* icons - the shell's, and the source site's */

  /**
   * Tries a browser's cookies and reports what YouTube made of them.
   *
   * One at a time: the run copies a cookie database and starts a yt-dlp, and a
   * user clicking through the browser buttons would otherwise have four of them
   * racing, all writing into the same progress bar.
   */
  handle('cookies:browsers', () => listBrowsers())
  handle('cookies:check', async (browser: string) => {
    if (cookieCheckRunning) throw new Error('A cookie check is already running')
    cookieCheckRunning = true
    try {
      return await checkCookies(String(browser), (progress) => send('cookies:progress', progress))
    } finally {
      cookieCheckRunning = false
    }
  })

  handle('icons:file', (extension: string) => iconForExtension(String(extension)))
  handle('icons:site', (url: string) => iconForSite(String(url)))
  handle('icons:thumbnail', (url: string) => thumbnailFor(String(url)))

  /* window controls - the frame is custom, so these are the buttons */

  handle('window:minimize', () => getMainWindow()?.minimize())
  handle('window:toggleMaximize', () => {
    const window = getMainWindow()
    if (!window) return
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })
  handle('window:close', () => {
    const window = getMainWindow()
    if (getSettings().closeToTray) window?.hide()
    else ctx.quit()
  })

  // The progress windows each need to work their own frame, and only their own.
  // Registered raw rather than through `handle` because the sender is the whole
  // point: a window may not name another window to act on.
  ipcMain.handle('window:minimizeSelf', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })

  ipcMain.handle('window:closeSelf', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
}

/**
 * The path to hand the shell, or null when there is nothing to hand it.
 *
 * openPath and showItemInFolder both fail silently on a file that is no longer
 * there, which reads as a broken button. Checking first turns that into the
 * `missing` state the list and the progress window already know how to show.
 */
/**
 * The cursor image for a drag out of the list. Windows refuses a drag with an
 * empty icon, so a flat square stands in when the app icon cannot be read -
 * a dull cursor is better than a drag that throws.
 */
let cachedDragIcon: Electron.NativeImage | null = null
function dragIcon(): Electron.NativeImage {
  if (cachedDragIcon) return cachedDragIcon

  const packaged = join(process.resourcesPath, 'icon.ico')
  const dev = join(app.getAppPath(), 'resources', 'icon.ico')
  const image = nativeImage.createFromPath(existsSync(packaged) ? packaged : dev)
  cachedDragIcon = image.isEmpty()
    ? nativeImage.createFromBitmap(Buffer.alloc(32 * 32 * 4, 0x60), { width: 32, height: 32 })
    : image.resize({ width: 32, height: 32 })
  return cachedDragIcon
}

async function openable(ctx: AppContext, id: string): Promise<string | null> {
  const task = ctx.manager.get(id)
  if (!task) return null

  const target = join(task.dir, task.filename)
  try {
    await access(target, constants.F_OK)
  } catch {
    task.status = 'missing'
    broadcast('tasks:changed', publicTasks(ctx.manager.list()))
    return null
  }
  return target
}

async function openableTorrentItem(
  ctx: AppContext,
  id: string,
  itemPath: string
): Promise<string | null> {
  const task = ctx.manager.get(id)
  if (task?.kind !== 'torrent' || typeof itemPath !== 'string') return null
  if (!task.torrentInfo?.files.some((file) => file.path === itemPath)) return null

  const target = resolveTorrentItemPath(
    task.dir,
    itemPath,
    task.torrentInfo.files.map((file) => file.path)
  )
  if (!target) return null

  try {
    await access(target, constants.F_OK)
    return target
  } catch {
    return null
  }
}

/**
 * How many playlist entries are resolved at once.
 *
 * This used to be strictly one. yt-dlp is a whole process per lookup at roughly
 * six seconds each, so a four-hundred-entry channel was up to forty minutes of
 * silence - and the comment defending it was only half right. YouTube does
 * rate-limit a burst, but three is not a burst; eight would be. Entries are
 * resolved a window at a time and added in listing order, so the rows still
 * appear in the order the playlist has them.
 */
const PLAYLIST_RESOLVE_CONCURRENCY = 3

/** Live playlist expansions, so one can be called off while it is running. */
const playlistRuns = new Map<string, AbortController>()

export function cancelPlaylistExpansion(groupId: string): boolean {
  const controller = playlistRuns.get(groupId)
  if (!controller) return false
  controller.abort()
  playlistRuns.delete(groupId)
  return true
}

/**
 * Resolves playlist entries and adds each as a download.
 *
 * Resolution is the slow part and happens a few at a time; the adds stay
 * strictly in listing order, because a playlist that arrives shuffled is not
 * the playlist the user asked for.
 *
 * One entry failing is not the batch failing: a private or region-blocked video
 * in the middle of a playlist must not cost the other ninety-nine.
 */
async function expandPlaylist(
  ctx: AppContext,
  entries: PlaylistEntry[],
  options: {
    groupId: string
    groupName: string
    height: number | null
    audioOnly: boolean
    queueId: string | null
    dir?: string
  }
): Promise<void> {
  let added = 0
  /** Why the run ended early, when it did: the user, or the rows going away. */
  let stopped: 'cancelled' | 'removed' | null = null
  const failures: string[] = []
  const controller = new AbortController()
  playlistRuns.set(options.groupId, controller)

  const publish = (): void => {
    send('playlist:progress', {
      groupId: options.groupId,
      groupName: options.groupName,
      done: added + failures.length,
      total: entries.length,
      failed: failures.length
    })
  }
  publish()

  try {
    for (let index = 0; index < entries.length; index += PLAYLIST_RESOLVE_CONCURRENCY) {
      if (controller.signal.aborted) {
        log.info(`playlist ${options.groupName} cancelled after ${added} entries`)
        stopped = 'cancelled'
        break
      }
      // Deleting the rows is also how the user calls off a listing that is
      // still filling in. Once something has been added, the group going empty
      // can only mean it was removed - so stop, rather than adding the other
      // ninety videos back one by one.
      if (added > 0 && !ctx.manager.list().some((task) => task.groupId === options.groupId)) {
        log.info(`playlist ${options.groupName} removed after ${added} entries`)
        stopped = 'removed'
        break
      }

      const window = entries.slice(index, index + PLAYLIST_RESOLVE_CONCURRENCY)
      const resolutions = await Promise.all(
        window.map((entry) =>
          resolveYouTube(entry.url, { referer: entry.url })
            .then((resolved) => ({ entry, resolved, error: null as unknown }))
            .catch((error: unknown) => ({ entry, resolved: null, error }))
        )
      )

      for (const { entry, resolved, error } of resolutions) {
        // Cancellation can arrive while this window of extractors is in
        // flight. Do not admit their results after the user stopped the run.
        if (controller.signal.aborted) { stopped = 'cancelled'; break }
        if (added > 0 && !ctx.manager.list().some((task) => task.groupId === options.groupId)) {
          stopped = 'removed'
          break
        }
        if (!resolved) {
          failures.push(entry.title)
          log.warn(`playlist entry failed (${entry.title}): ${error instanceof Error ? error.message : String(error)}`)
          continue
        }

        const variant = pickPlaylistVariant(resolved.variants, options.height, options.audioOnly)
        if (!variant) {
          failures.push(entry.title)
          continue
        }

        const task = placeTask({
          url: variant.url,
          sourceUrl: entry.url,
          thumbnailUrl: resolved.thumbnailUrl ?? entry.thumbnailUrl,
          groupId: options.groupId,
          groupName: options.groupName,
          groupFolder: options.groupName,
          audioUrl: variant.audioUrl ?? null,
          audioTracks: variant.audioTracks,
          youtube: variant.youtube
            ? {
                pageUrl: entry.url,
                videoFormatId: variant.youtube.videoFormatId,
                audioFormatId: variant.youtube.audioFormatId ?? null,
                height: variant.height,
                role: variant.youtube.role ?? 'video'
              }
            : undefined,
          filename: resolved.title,
          dir: options.dir,
          queueId: options.queueId,
          // A queued task is started by the scheduler, not by the add.
          autoStart: options.queueId === null,
          suppressProgressWindow: true
        })
        ctx.manager.add(task, options.queueId === null)
        added++
      }

      publish()
    }
  } finally {
    playlistRuns.delete(options.groupId)
    // Zero total is how the renderer knows to take the line down, whether this
    // finished, failed or was called off part-way.
    send('playlist:progress', {
      groupId: options.groupId,
      groupName: options.groupName,
      done: added + failures.length,
      total: 0,
      failed: failures.length
    })
    persistTaskSnapshot(ctx)
  }

  // A run the user called off still says what it managed; one whose rows were
  // deleted says nothing, because the deletion was the feedback.
  if (stopped === 'removed') return

  send('toast', {
    kind: stopped === 'cancelled' ? 'info' : failures.length === 0 ? 'success' : 'info',
    message: stopped === 'cancelled'
      ? `Stopped after adding ${added} of ${entries.length} from ${options.groupName}`
      : failures.length === 0
        ? `Added ${added} video(s) from ${options.groupName}`
        : `Added ${added} of ${entries.length} from ${options.groupName}; ${failures.length} could not be resolved`
  })
}

/**
 * The variant closest to what the user asked for.
 *
 * Never a rung above the request unless there is nothing below it - the same
 * rule the format substitution follows, and for the same reason: quietly
 * fetching 4K for someone who chose 720p is its own kind of wrong.
 */
export function pickPlaylistVariant(
  variants: MediaVariant[],
  height: number | null,
  audioOnly: boolean
): MediaVariant | null {
  const audio = variants.filter((variant) => variant.youtube?.role === 'audio')
  if (audioOnly) {
    return audio.length > 0
      ? audio.reduce((best, variant) => ((variant.bandwidth ?? 0) > (best.bandwidth ?? 0) ? variant : best))
      : null
  }

  const video = variants.filter((variant) => variant.youtube?.role !== 'audio')
  if (video.length === 0) return audio[0] ?? null
  if (height === null) {
    // "Best" means the tallest rung on offer for this particular video, which
    // differs from video to video in the same playlist.
    return video.reduce((best, variant) => ((variant.height ?? 0) > (best.height ?? 0) ? variant : best))
  }

  const atOrBelow = video.filter((variant) => (variant.height ?? 0) <= height)
  const pool = atOrBelow.length > 0 ? atOrBelow : video
  return pool.reduce((best, variant) => {
    const distance = Math.abs((variant.height ?? 0) - height)
    const bestDistance = Math.abs((best.height ?? 0) - height)
    return distance < bestDistance ? variant : best
  })
}

function persistTaskSnapshot(ctx: AppContext): void {
  // `persistTasks` is coalesced, so metadata edits remain cheap even when the
  // user is rapidly editing several rows.
  persistTasks(ctx.manager.list())
}

/**
 * Works out what qualities a candidate offers. Shared by the grabber panel and
 * by the confirm window, which must not disagree about what is downloadable.
 */
export async function resolveCandidate(
  ctx: AppContext,
  id: string
): Promise<MediaCandidate> {
  const candidate = ctx.media.find((m) => m.id === id)
  if (!candidate) throw new Error('That media entry is gone')

  if (candidate.variants && candidate.variants.length > 0) {
    return candidate
  }

  if (candidate.type === 'file') {
    const probe = await probeUrl(candidate.mediaUrl, { headers: candidate.headers })
    const audio = probe.mimeType?.toLowerCase().startsWith('audio/') ||
      /\.(?:mp3|m4a|aac|flac|ogg|opus|wav)(?:[?#]|$)/i.test(candidate.mediaUrl)
    const audioContainer = audioContainerFor(candidate.mediaUrl, probe.mimeType)
    candidate.variants = [
      {
        url: candidate.mediaUrl,
        label: audio ? `${audioContainer.toUpperCase()} audio` : candidate.height ? `${candidate.height}p` : probe.filename,
        height: candidate.height ?? null,
        bandwidth: null,
        codecs: audio ? 'audio' : null,
        estimatedSize: probe.size,
        container: audio ? audioContainer : null
      }
    ]
  } else if (candidate.type === 'hls') {
    // If the primary URL is a master playlist, resolveVariants already parses its ladder and renditions.
    const primaryVariants = await resolveVariants(candidate.mediaUrl, candidate.headers).catch(() => [])
    const hasMasterLadder = primaryVariants.length > 1 || primaryVariants.some((v) => v.height || v.bandwidth)

    if (hasMasterLadder) {
      candidate.variants = primaryVariants
    } else {
      const knownUrls = new Set<string>()
      for (const v of primaryVariants) {
        knownUrls.add(v.url)
        if (v.audioUrl) knownUrls.add(v.audioUrl)
        for (const t of v.audioTracks ?? []) knownUrls.add(t.url)
      }

      const rawUrls = [...new Set([candidate.mediaUrl, ...(candidate.relatedMediaUrls ?? [])])]
      const uninspectedUrls = rawUrls.filter((url) => !knownUrls.has(url))

      const inspected = await Promise.all(uninspectedUrls.map(async (url) => ({
        url,
        media: await inspectHlsMedia(url, candidate.headers).catch(() => null)
      })))
      const videoUrls = inspected.filter((item) => item.media?.hasVideo).map((item) => item.url)
      const audioUrls = inspected
        .filter((item) => item.media?.hasAudio && !item.media.hasVideo)
        .map((item) => item.url)

      if (videoUrls.length > 0) {
        const ladders = await Promise.all(videoUrls.map((url) => resolveVariants(url, candidate.headers)))
        const hasQualityLadder = ladders.some((ladder) =>
          ladder.length > 1 || ladder.some((variant) => variant.height || variant.bandwidth)
        )
        // Once a master playlist supplied a real ladder, an independently
        // observed anonymous child playlist is only a duplicate of the quality
        // currently playing. Do not expose it as a misleading extra "stream".
        const variants = ladders.flat().filter((variant) =>
          !hasQualityLadder || variant.height || variant.bandwidth || variant.label !== 'stream'
        )
        for (const variant of variants) {
          const height = variant.height ?? hlsUrlHeight(variant.url)
          if (height && !variant.height) {
            variant.height = height
            variant.label = `${height}p`
          }
          if ((!variant.audioTracks || variant.audioTracks.length === 0) && audioUrls.length > 0) {
            variant.audioUrl = audioUrls[0]
            variant.audioTracks = audioUrls.map((url, index) => ({
              url,
              label: `Audio ${index + 1}`,
              language: null,
              isDefault: index === 0
            }))
            if (audioUrls.length > 1) variant.container = 'mkv'
          }
        }
        candidate.variants = [...new Map(variants.map((variant) => [variant.url, variant])).values()]
          .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0))
        if (audioUrls.length > 0) {
          log.info(`paired ${audioUrls.length} split HLS audio rendition(s) with ${videoUrls.length} video playlist(s)`)
        }
      } else if (audioUrls.length > 0) {
        candidate.variants = audioUrls.map((url, index) => ({
          url,
          label: audioUrls.length > 1 ? `Audio ${index + 1}` : 'Audio stream',
          height: null,
          bandwidth: null,
          codecs: 'audio',
          estimatedSize: null,
          container: 'm4a'
        }))
      } else {
        candidate.variants = primaryVariants.length > 0
          ? primaryVariants
          : await resolveVariants(candidate.mediaUrl, candidate.headers)
      }
    }
  } else {
    const { resolveMpd } = await import('./dash/manifest.ts')
    candidate.variants = (await resolveMpd(candidate.mediaUrl, candidate.headers)).variants
  }

  return candidate
}

function hlsUrlHeight(url: string): number | null {
  const match = /q(144|240|360|480|540|720|1080|1440|2160)(?:\D|$)/i.exec(url)
  return match ? Number(match[1]) : null
}

function audioContainerFor(url: string, mimeType: string | null): string {
  const fromUrl = /\.(mp3|m4a|aac|flac|ogg|opus|wav)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase()
  if (fromUrl) return fromUrl
  const mime = mimeType?.toLowerCase() ?? ''
  if (mime.includes('mpeg')) return 'mp3'
  if (mime.includes('flac')) return 'flac'
  if (mime.includes('ogg')) return 'ogg'
  if (mime.includes('wav')) return 'wav'
  return 'm4a'
}

/**
 * Turns a chosen quality into the URLs the task will carry.
 *
 * A YouTube final confirmation is offered only for variants whose URLs were
 * already prepared. The engine starts with those signed resources immediately;
 * stable page/itag identity remains attached so an expired URL can be refreshed
 * after a 401/403/410 without making every normal start pay that cost.
 *
 * The page URL fallback is retained for old persisted requests and extensions;
 * current handoffs should always take the prepared branch above.
 */
function resolveChosenUrls(
  candidate: MediaCandidate,
  opts: {
    variantUrl: string
    audioUrl?: string | null
    youtube?: { videoFormatId: string; audioFormatId?: string | null; role?: 'video' | 'audio' }
  }
): { url: string; audioUrl: string | null } {
  if (!opts.youtube) {
    return { url: opts.variantUrl, audioUrl: opts.audioUrl ?? null }
  }

  const youtube = opts.youtube
  return chosenYouTubeUrls(candidate.variants, candidate.pageUrl, youtube)
}

/** Turns an extension handoff into a queued download. */
export function handoffToTask(
  ctx: AppContext,
  message: {
    url: string
    filename?: string
    referer?: string
    cookie?: string
    userAgent?: string
    bulk?: boolean
  },
  autoStart = true
): DownloadTask {
  const task = placeTask({
    url: message.url,
    sourceUrl: message.referer,
    filename: message.filename,
    headers: {
      referer: message.referer,
      cookie: message.cookie,
      userAgent: message.userAgent
    }
  })

  ctx.manager.add(task, autoStart)
  // With the confirm window turned off this is the only thing the user sees of
  // a download they started, so it matters most here. A bulk action still gets
  // nothing: forty windows is the problem the confirm window already avoids.
  if (autoStart && !message.bulk) announce(task)
  return task
}

function mediaExtraHeaders(
  captured: Record<string, string> | undefined,
  origin: string | undefined
): Record<string, string> | undefined {
  const extra = { ...(captured ?? {}) }
  delete extra.cookie
  delete extra.referer
  delete extra['user-agent']
  delete extra.authorization
  if (origin && !extra.origin) extra.origin = origin
  return Object.keys(extra).length > 0 ? extra : undefined
}

function logMediaCapture(candidate: MediaCandidate): void {
  const host = new URL(candidate.mediaUrl).hostname
  const names = Object.keys(candidate.headers.extra ?? {}).sort()
  if (candidate.headers.authorization) names.push('authorization')
  log.info(
    `captured ${candidate.type} media from ${host}` +
      `${candidate.height ? ` (${candidate.height}p)` : ''}; ` +
      `cookies=${candidate.headers.cookie ? 'yes' : 'no'}, headers=${names.join(',') || 'none'}`
  )
}

export function recordMedia(
  ctx: AppContext,
  message: {
    pageUrl: string
    pageTitle: string
    mediaUrl: string
    relatedMediaUrls?: string[]
    audioUrl?: string | null
    variants?: any[]
    subtitles?: Array<{ url: string; label: string; language: string | null; format: 'vtt' | 'srt' | 'ttml' }>
    kind: 'hls' | 'dash' | 'file'
    width?: number | null
    height?: number | null
    referer?: string
    origin?: string
    cookie?: string
    userAgent?: string
    extraHeaders?: Record<string, string>
  }
): MediaCandidate {
  const existing = ctx.media.find((m) => m.mediaUrl === message.mediaUrl)
  if (existing) {
    // The same signed manifest is often sent again after an extension reload.
    // Refresh its browser context even when the message carries no prebuilt
    // quality ladder; otherwise a candidate that first arrived with the wrong
    // top-page referer remains permanently stuck on 403.
    existing.pageUrl = message.pageUrl
    existing.pageTitle = message.pageTitle
    existing.type = message.kind
    existing.relatedMediaUrls = message.relatedMediaUrls ?? existing.relatedMediaUrls ?? []
    existing.width = message.width ?? existing.width ?? null
    existing.height = message.height ?? existing.height ?? null
    // A new page inventory may contain qualities/audio that were not present
    // when this URL was first resolved. Rebuild the ladder on every handoff.
    existing.variants = message.variants && message.variants.length > 0 ? message.variants : []
    existing.headers = {
      referer: message.referer,
      cookie: message.cookie,
      userAgent: message.userAgent,
      authorization: message.extraHeaders?.authorization,
      extra: mediaExtraHeaders(message.extraHeaders, message.origin)
    }
    existing.subtitles = message.subtitles ?? existing.subtitles
    existing.discoveredAt = Date.now()
    logMediaCapture(existing)
    return existing
  }

  const candidate: MediaCandidate = {
    id: randomUUID(),
    pageUrl: message.pageUrl,
    pageTitle: message.pageTitle,
    mediaUrl: message.mediaUrl,
    relatedMediaUrls: message.relatedMediaUrls ?? [],
    type: message.kind,
    width: message.width ?? null,
    height: message.height ?? null,
    variants: message.variants || [],
    headers: {
      referer: message.referer,
      cookie: message.cookie,
      userAgent: message.userAgent,
      authorization: message.extraHeaders?.authorization,
      extra: mediaExtraHeaders(message.extraHeaders, message.origin)
    },
    subtitles: message.subtitles ?? [],
    discoveredAt: Date.now()
  }

  ctx.media.unshift(candidate)
  // Bounded: a long browsing session would otherwise accumulate every stream
  // the user ever scrolled past.
  if (ctx.media.length > 100) ctx.media.length = 100

  logMediaCapture(candidate)

  return candidate
}
