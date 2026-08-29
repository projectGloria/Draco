import { randomUUID } from 'node:crypto'
import { access, constants } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import type {
  Category,
  DownloadTask,
  HandoffRequest,
  IntegrationStatus,
  MediaCandidate,
  NewDownload,
  Queue,
  RequestHeaders,
  Settings
} from '@shared/types'
import { getPaths } from './bootstrap/paths.ts'
import { checkRegistered, ensureRegistered, readExtensionId } from './bridge/integration.ts'
import type { PipeServer } from './bridge/pipe-server.ts'
import { directoryFor } from './categories.ts'
import { createTask, filenameForKind, kindForUrl, validateUrl } from './engine/create.ts'
import type { DownloadManager } from './engine/manager.ts'
import { probeUrl } from './engine/probe.ts'
import { resolveVariants } from './hls/playlist.ts'
import { logger } from './log.ts'
import type { Scheduler } from './queue/scheduler.ts'
import {
  getCategories,
  getSettings,
  saveCategories,
  saveMedia,
  saveSettings
} from './store.ts'
import { closeHandoffWindow, getMainWindow, send } from './windows.ts'

const log = logger('ipc')

export interface AppContext {
  manager: DownloadManager
  scheduler: Scheduler
  pipe: PipeServer
  media: MediaCandidate[]
  /**
   * Handoffs waiting for the user to confirm. Held in main rather than pushed
   * straight at the renderer because a cold start has no window yet: the host
   * can launch the app *in order to* service a download, and that request must
   * survive until there is something to show it in.
   */
  pendingHandoffs: HandoffRequest[]
  lastHandoffAt: number | null
  quit(): void
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
    ? { dir: input.dir, categoryId: input.categoryId ?? null }
    : directoryFor(
        settings.downloadDir,
        categories,
        filename,
        null,
        input.categoryId ?? settings.defaultCategoryId
      )

  return createTask({
    url,
    dir,
    filename: chosenName,
    categoryId,
    queueId: input.queueId ?? null,
    headers: input.headers,
    description: input.description,
    kind
  })
}

/** Re-files a task after the probe, unless the caller pinned a destination. */
export function refileTask(task: DownloadTask): void {
  if (task.filenameLocked && task.categoryId) return

  const settings = getSettings()
  const { dir, categoryId } = directoryFor(
    settings.downloadDir,
    getCategories(),
    task.filename,
    task.mimeType,
    task.categoryId ?? settings.defaultCategoryId
  )

  task.dir = dir
  task.categoryId = categoryId
}

export function registerIpc(ctx: AppContext): void {
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

  handle('tasks:list', () => ctx.manager.list())

  handle('tasks:add', async (input: NewDownload) => {
    const task = placeTask(input)
    ctx.manager.add(task, input.autoStart !== false)
    return task
  })

  handle('tasks:probe', (url: string, headers: RequestHeaders | undefined) =>
    probeUrl(validateUrl(url), { headers, timeoutMs: getSettings().timeoutMs })
  )

  handle('tasks:start', (ids: string[]) => ctx.manager.start(ids))
  handle('tasks:pause', (ids: string[]) => ctx.manager.pause(ids))
  handle('tasks:pauseAll', () => ctx.manager.pauseAll())
  handle('tasks:remove', (ids: string[], deleteFiles: boolean) =>
    ctx.manager.remove(ids, deleteFiles)
  )
  handle('tasks:removeCompleted', () => ctx.manager.removeCompleted())

  handle('tasks:update', (id: string, patch: Partial<DownloadTask>) => {
    const task = ctx.manager.get(id)
    if (!task) return null

    // Only fields the UI is allowed to edit. Letting a renderer patch `segments`
    // or `received` would let it corrupt the engine's own bookkeeping.
    if (typeof patch.description === 'string') task.description = patch.description.slice(0, 500)
    if (typeof patch.queueId === 'string' || patch.queueId === null) task.queueId = patch.queueId
    if (typeof patch.filename === 'string' && patch.filename.trim()) {
      task.filename = patch.filename.trim()
      task.filenameLocked = true
    }

    return task
  })

  handle('tasks:redownload', async (id: string) => {
    const task = ctx.manager.get(id)
    if (!task) return
    await ctx.manager.remove([id], false)

    const fresh = placeTask({
      url: task.url,
      filename: task.filenameLocked ? task.filename : undefined,
      headers: task.headers,
      description: task.description,
      queueId: task.queueId,
      kind: task.kind
    })
    ctx.manager.add(fresh, true)
  })

  handle('tasks:open', async (id: string) => {
    const task = ctx.manager.get(id)
    if (!task) return
    const target = join(task.dir, task.filename)
    // openPath on a missing file silently does nothing, which reads as a broken
    // button; surfacing the state is better.
    try {
      await access(target, constants.F_OK)
    } catch {
      task.status = 'missing'
      send('tasks:changed', ctx.manager.list())
      return
    }
    await shell.openPath(target)
  })

  handle('tasks:reveal', (id: string) => {
    const task = ctx.manager.get(id)
    if (!task) return
    shell.showItemInFolder(join(task.dir, task.filename))
  })

  /* the confirm window */

  const takeHandoff = (id: string): HandoffRequest => {
    const index = ctx.pendingHandoffs.findIndex((h) => h.id === id)
    if (index < 0) throw new Error('That download request has expired')
    return ctx.pendingHandoffs.splice(index, 1)[0]
  }

  handle('handoff:get', (id: string) => ctx.pendingHandoffs.find((h) => h.id === id) ?? null)

  handle('handoff:accept', (id: string, input: NewDownload) => {
    const request = takeHandoff(id)

    // The URL and the captured headers come from the request, not from the
    // window: the renderer is allowed to choose a name and a folder, not to
    // rewrite where the bytes are fetched from or what credentials go with them.
    const task = placeTask({
      ...input,
      url: request.url,
      headers: request.headers
    })

    ctx.manager.add(task, input.autoStart !== false)
    closeHandoffWindow(id)
    return task
  })

  handle('handoff:resolveMedia', async (id: string) => {
    const request = ctx.pendingHandoffs.find((h) => h.id === id)
    if (!request?.mediaId) throw new Error('That media request has expired')
    return resolveCandidate(ctx, request.mediaId)
  })

  handle('handoff:acceptMedia', (
    id: string,
    opts: { variantUrl: string; filename: string; dir?: string; categoryId?: string; queueId?: string; audioUrl?: string | null }
  ) => {
    const request = takeHandoff(id)
    const candidate = ctx.media.find((m) => m.id === request.mediaId)
    if (!candidate) throw new Error('That media entry is gone')

    const task = placeTask({
      url: opts.variantUrl,
      audioUrl: opts.audioUrl,
      filename: opts.filename,
      dir: opts.dir,
      categoryId: opts.categoryId,
      queueId: opts.queueId,
      headers: candidate.headers,
      description: candidate.pageTitle,
      kind: candidate.type === 'file' ? 'file' : 'hls'
    })

    ctx.manager.add(task, true)
    closeHandoffWindow(id)
    return task
  })

  handle('handoff:dismiss', (id: string) => {
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
  handle('queues:remove', (id: string) => ctx.scheduler.remove(id))
  handle('queues:start', (id: string) => ctx.scheduler.startQueue(id))
  handle('queues:stop', (id: string) => ctx.scheduler.stopQueue(id))
  handle('queues:cancelPending', () => ctx.scheduler.cancelPending())

  /* media grabber */

  handle('media:list', () => ctx.media)

  handle('media:resolve', (id: string) => resolveCandidate(ctx, id))

  handle('media:download', async (
    id: string,
    opts: { variantUrl: string; filename: string; audioUrl?: string | null }
  ) => {
    const candidate = ctx.media.find((m) => m.id === id)
    if (!candidate) throw new Error('That media entry is gone')

    const task = placeTask({
      url: opts.variantUrl,
      audioUrl: opts.audioUrl,
      filename: opts.filename,
      headers: candidate.headers,
      description: candidate.pageTitle,
      kind: candidate.type === 'file' ? 'file' : 'hls'
    })

    ctx.manager.add(task, true)
    return task
  })

  handle('media:clear', async () => {
    ctx.media.length = 0
    await saveMedia(ctx.media)
    send('media:changed', ctx.media)
  })

  /* settings and integration */

  handle('settings:get', () => getSettings())

  handle('settings:save', async (patch: Partial<Settings>) => {
    const next = await saveSettings(patch)
    ctx.manager.applySettings()
    return next
  })

  handle('settings:chooseDirectory', async (current?: string) => {
    const window = getMainWindow()
    const result = await dialog.showOpenDialog(window ?? new BrowserWindow({ show: false }), {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: current || getSettings().downloadDir
    })
    return result.canceled ? null : result.filePaths[0]
  })

  handle('integration:get', async (): Promise<IntegrationStatus> => {
    return {
      extensionPath: getPaths().extensionDir,
      extensionId: await readExtensionId(),
      registered: await checkRegistered(),
      bridgeListening: ctx.pipe.listening,
      lastHandoffAt: ctx.lastHandoffAt
    }
  })

  handle('integration:register', async (): Promise<IntegrationStatus> => {
    const registered = await ensureRegistered()
    return {
      extensionPath: getPaths().extensionDir,
      extensionId: await readExtensionId(),
      registered,
      bridgeListening: ctx.pipe.listening,
      lastHandoffAt: ctx.lastHandoffAt
    }
  })

  handle('clipboard:write', (text: string) => clipboard.writeText(String(text)))

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

  // The extension spots MPEG-DASH so the page's streams are all visible, but
  // only HLS can be downloaded. Refusing here is far clearer than letting the
  // .mpd be parsed as a playlist and fail with "no media segments".
  if (candidate.type === 'dash') {
    throw new Error('MPEG-DASH streams are not supported yet - only HLS')
  }

  if (candidate.type === 'file') {
    const probe = await probeUrl(candidate.mediaUrl, { headers: candidate.headers })
    candidate.variants = [
      {
        url: candidate.mediaUrl,
        label: probe.filename,
        height: null,
        bandwidth: null,
        codecs: null,
        estimatedSize: probe.size
      }
    ]
  } else {
    candidate.variants = await resolveVariants(candidate.mediaUrl, candidate.headers)
  }

  await saveMedia(ctx.media)
  send('media:changed', ctx.media)
  return candidate
}

/** Turns an extension handoff into a queued download. */
export function handoffToTask(
  ctx: AppContext,
  message: { url: string; filename?: string; referer?: string; cookie?: string; userAgent?: string }
): DownloadTask {
  const task = placeTask({
    url: message.url,
    filename: message.filename,
    headers: {
      referer: message.referer,
      cookie: message.cookie,
      userAgent: message.userAgent
    }
  })

  ctx.manager.add(task, true)
  return task
}

export function recordMedia(
  ctx: AppContext,
  message: {
    pageUrl: string
    pageTitle: string
    mediaUrl: string
    audioUrl?: string | null
    variants?: any[]
    kind: 'hls' | 'dash' | 'file'
    referer?: string
    cookie?: string
    userAgent?: string
  }
): MediaCandidate {
  const existing = ctx.media.find((m) => m.mediaUrl === message.mediaUrl)
  if (existing) return existing

  const candidate: MediaCandidate = {
    id: randomUUID(),
    pageUrl: message.pageUrl,
    pageTitle: message.pageTitle,
    mediaUrl: message.mediaUrl,
    type: message.kind,
    variants: message.variants || [],
    headers: {
      referer: message.referer,
      cookie: message.cookie,
      userAgent: message.userAgent
    },
    discoveredAt: Date.now()
  }

  ctx.media.unshift(candidate)
  // Bounded: a long browsing session would otherwise accumulate every stream
  // the user ever scrolled past.
  if (ctx.media.length > 100) ctx.media.length = 100

  void saveMedia(ctx.media)
  send('media:changed', ctx.media)
  return candidate
}
