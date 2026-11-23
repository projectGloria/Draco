import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import type { DownloadManager } from '../engine/manager.ts'
import { mediaExtensionOf } from '../../shared/playable-media.ts'
import { handleMediaProtocolRequest, resolveWatchSession } from './watch-server.ts'
import { logger } from '../log.ts'

const log = logger('external-player')

export type ExternalPlayerKind = 'mpv' | 'vlc' | 'mpc' | 'wmplayer' | 'generic'

export interface ResolvedExternalPlayer {
  executable: string
  kind: ExternalPlayerKind
  argsFor(videoUrl: string, audioUrl: string | null, title: string): string[]
}

/**
 * Known desktop video players on Windows, ordered by their HTTP streaming and
 * dual-stream (separate video+audio) capabilities.
 */
const KNOWN_PLAYERS: Array<{ kind: ExternalPlayerKind; paths: string[] }> = [
  {
    kind: 'mpv',
    paths: [
      'mpv\\mpv.exe',
      'mpv.net\\mpvnet.exe'
    ]
  },
  {
    kind: 'vlc',
    paths: [
      'VideoLAN\\VLC\\vlc.exe'
    ]
  },
  {
    kind: 'mpc',
    paths: [
      'MPC-HC\\mpc-hc64.exe',
      'MPC-HC\\mpc-hc.exe',
      'MPC-BE x64\\mpc-be64.exe',
      'MPC-BE\\mpc-be.exe',
      'K-Lite Codec Pack\\MPC-HC64\\mpc-hc64.exe'
    ]
  },
  {
    kind: 'wmplayer',
    paths: [
      'Windows Media Player\\wmplayer.exe'
    ]
  }
]

export function classifyPlayerExecutable(exePath: string): ExternalPlayerKind {
  const lower = exePath.toLowerCase()
  if (lower.endsWith('mpv.exe') || lower.endsWith('mpvnet.exe')) return 'mpv'
  if (lower.endsWith('vlc.exe')) return 'vlc'
  if (lower.includes('mpc-hc') || lower.includes('mpc-be') || lower.includes('potplayer')) return 'mpc'
  if (lower.endsWith('wmplayer.exe')) return 'wmplayer'
  return 'generic'
}

export function buildExternalPlayerArgs(
  kind: ExternalPlayerKind,
  videoUrl: string,
  audioUrl: string | null,
  title: string
): string[] {
  switch (kind) {
    case 'mpv':
      return [
        `--force-media-title=${title}`,
        ...(audioUrl ? [`--audio-file=${audioUrl}`] : []),
        videoUrl
      ]
    case 'vlc':
      return [
        `--meta-title=${title}`,
        ...(audioUrl ? [`--input-slave=${audioUrl}`] : []),
        videoUrl
      ]
    case 'mpc':
      return [
        videoUrl,
        ...(audioUrl ? ['/dub', audioUrl] : [])
      ]
    default:
      return [videoUrl]
  }
}

function runCommandOutput(command: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false, windowsHide: true })
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.on('error', () => resolve({ code: -1, stdout: '' }))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout }))
  })
}

async function regQueryValue(key: string, valueName: string): Promise<string | null> {
  const args = ['query', key, ...(valueName ? ['/v', valueName] : ['/ve'])]
  const { code, stdout } = await runCommandOutput('reg.exe', args)
  if (code !== 0) return null
  const match = /REG_[A-Z_]+\s+(.*)$/m.exec(stdout)
  const data = match ? match[1].trim() : null
  return !data || data === '(value not set)' ? null : data
}

/**
 * Extracts an executable path from a Windows registry `shell\open\command` string
 * such as `"C:\Program Files\VideoLAN\VLC\vlc.exe" --started-from-file "%1"`.
 */
export function parseExecutableFromShellCommand(command: string): string | null {
  const trimmed = command.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('"')) {
    const endQuote = trimmed.indexOf('"', 1)
    if (endQuote > 1) {
      const candidate = trimmed.slice(1, endQuote).trim()
      return candidate.toLowerCase().endsWith('.exe') ? candidate : null
    }
  }
  const firstToken = trimmed.split(/\s+/)[0] ?? ''
  return firstToken.toLowerCase().endsWith('.exe') ? firstToken : null
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Resolves the user's preferred external video player on Windows:
 * 1. Checks the Windows file association (`UserChoiceLatest` / `UserChoice` / `Classes`)
 *    for the media extension (e.g. `.mp4`, `.mkv`) if it points to a desktop `.exe`.
 * 2. Searches standard installation folders and `PATH` for `mpv`, `VLC`, `MPC-HC/BE`,
 *    or `Windows Media Player`.
 */
export async function resolveWindowsMediaPlayer(filename: string): Promise<ResolvedExternalPlayer | null> {
  const ext = mediaExtensionOf(filename) || 'mp4'
  const dotExt = `.${ext}`

  // 1. Check user's Windows file association ProgId
  const progId =
    (await regQueryValue(`HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${dotExt}\\UserChoiceLatest`, 'ProgId')) ??
    (await regQueryValue(`HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${dotExt}\\UserChoice`, 'ProgId')) ??
    (await regQueryValue(`HKCU\\Software\\Classes\\${dotExt}`, '')) ??
    (await regQueryValue(`HKCR\\${dotExt}`, ''))

  if (progId && !progId.startsWith('AppX')) {
    const command =
      (await regQueryValue(`HKCU\\Software\\Classes\\${progId}\\shell\\open\\command`, '')) ??
      (await regQueryValue(`HKCR\\${progId}\\shell\\open\\command`, ''))
    if (command) {
      const exe = parseExecutableFromShellCommand(command)
      if (exe && (await fileExists(exe))) {
        const kind = classifyPlayerExecutable(exe)
        return {
          executable: exe,
          kind,
          argsFor: (videoUrl, audioUrl, title) => buildExternalPlayerArgs(kind, videoUrl, audioUrl, title)
        }
      }
    }
  }

  // 2. Check PATH for mpv or vlc
  for (const bin of ['mpv.exe', 'vlc.exe', 'mpc-hc64.exe', 'mpc-be64.exe']) {
    const { code, stdout } = await runCommandOutput('where.exe', [bin])
    if (code === 0) {
      const first = stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean)
      if (first && (await fileExists(first))) {
        const kind = classifyPlayerExecutable(first)
        return {
          executable: first,
          kind,
          argsFor: (videoUrl, audioUrl, title) => buildExternalPlayerArgs(kind, videoUrl, audioUrl, title)
        }
      }
    }
  }

  // 3. Scan standard installation directories
  const roots = [
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)'],
    process.env['LOCALAPPDATA'],
    process.env['LOCALAPPDATA'] ? join(process.env['LOCALAPPDATA'], 'Programs') : undefined
  ].filter((v): v is string => Boolean(v))

  for (const entry of KNOWN_PLAYERS) {
    for (const root of roots) {
      for (const rel of entry.paths) {
        const candidate = join(root, rel)
        if (await fileExists(candidate)) {
          return {
            executable: candidate,
            kind: entry.kind,
            argsFor: (videoUrl, audioUrl, title) => buildExternalPlayerArgs(entry.kind, videoUrl, audioUrl, title)
          }
        }
      }
    }
  }

  return null
}

/**
 * Loopback HTTP media server (`http://127.0.0.1:<port>/stream/<taskId>/<filename>`).
 *
 * Allows any external media player (VLC, mpv, MPC-HC, PotPlayer, Windows Media Player)
 * to stream an in-progress download with full HTTP Range seeking and demand-driven
 * segment prioritization while Draco continues downloading in the background.
 */
export class LoopbackWatchServer {
  private server: Server | null = null
  private port: number | null = null
  private startPromise: Promise<number> | null = null
  private manager: DownloadManager
  private getTempDir: () => string | undefined

  constructor(manager: DownloadManager, getTempDir: () => string | undefined) {
    this.manager = manager
    this.getTempDir = getTempDir
  }

  async ensureStarted(): Promise<number> {
    if (this.port !== null && this.server?.listening) return this.port
    if (this.startPromise) return this.startPromise

    this.startPromise = new Promise<number>((resolve, reject) => {
      const srv = createServer((req, res) => {
        void this.handleHttp(req, res)
      })
      srv.once('error', (err) => {
        this.startPromise = null
        reject(err)
      })
      srv.listen(0, '127.0.0.1', () => {
        const address = srv.address()
        const assignedPort = typeof address === 'object' && address ? address.port : 0
        this.server = srv
        this.port = assignedPort
        this.startPromise = null
        log.info(`loopback watch server listening on http://127.0.0.1:${assignedPort}`)
        resolve(assignedPort)
      })
      srv.unref()
    })

    return this.startPromise
  }

  async urlsForTask(
    taskId: string,
    torrentFilePath?: string
  ): Promise<{
    videoUrl: string
    audioUrl: string | null
    title: string
    filename: string
  }> {
    const session = await resolveWatchSession(this.manager, taskId, this.getTempDir(), torrentFilePath)
    const port = await this.ensureStarted()
    const task = this.manager.get(taskId)
    const rawName = torrentFilePath
      ? (torrentFilePath.split(/[\\/]/).pop() || task?.filename || 'video.mp4')
      : (task?.filename || 'video.mp4')
    const safeName = encodeURIComponent(rawName)
    const encodedId = encodeURIComponent(taskId)
    const fileParam = torrentFilePath ? `&file=${encodeURIComponent(torrentFilePath)}` : ''

    const videoUrl = `http://127.0.0.1:${port}/stream/${encodedId}/${safeName}?track=video${fileParam}`
    const audioUrl = session.audioStreamUrl
      ? `http://127.0.0.1:${port}/stream/${encodedId}/${safeName}.m4a?track=audio`
      : null

    return {
      videoUrl,
      audioUrl,
      title: session.title,
      filename: rawName
    }
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const urlObj = new URL(req.url ?? '/', 'http://127.0.0.1')
      const parts = urlObj.pathname.replace(/^\/+/, '').split('/')
      // Expect /stream/<taskId> or /stream/<taskId>/<filename>
      if (parts[0] !== 'stream' || !parts[1]) {
        res.writeHead(404)
        res.end('Not found')
        return
      }

      const encodedTaskId = parts[1]
      const internalUrl = `draco-media://stream/${encodedTaskId}${urlObj.search}`
      const controller = new AbortController()
      req.on('close', () => controller.abort())

      const headers = new Headers()
      if (typeof req.headers.range === 'string') {
        headers.set('range', req.headers.range)
      }

      const webReq = new Request(internalUrl, {
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        headers,
        signal: controller.signal
      })

      const webRes = await handleMediaProtocolRequest(webReq, this.manager, this.getTempDir())
      const outHeaders: Record<string, string> = {}
      webRes.headers.forEach((value, key) => {
        outHeaders[key] = value
      })
      res.writeHead(webRes.status, outHeaders)

      if (!webRes.body || req.method === 'HEAD') {
        res.end()
        return
      }

      const nodeStream = Readable.fromWeb(webRes.body as unknown as NodeReadableStream)
      nodeStream.on('error', () => {
        if (!res.destroyed) res.destroy()
      })
      res.on('close', () => {
        nodeStream.destroy()
      })
      nodeStream.pipe(res)
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500)
        res.end(err instanceof Error ? err.message : 'Internal server error')
      } else if (!res.destroyed) {
        res.destroy()
      }
    }
  }

  async close(): Promise<void> {
    const srv = this.server
    this.server = null
    this.port = null
    if (!srv) return
    await new Promise<void>((resolve) => srv.close(() => resolve()))
  }
}

/**
 * Launches the user's external media player pointed at Draco's live loopback
 * HTTP stream so they can watch an in-progress download in VLC, mpv, MPC-HC,
 * or Windows Media Player while the download continues.
 */
export async function launchExternalPlayerForTask(
  loopback: LoopbackWatchServer,
  tempDir: string,
  taskId: string,
  torrentFilePath?: string,
  openPathFallback?: (filePath: string) => Promise<string>
): Promise<boolean> {
  const { videoUrl, audioUrl, title, filename } = await loopback.urlsForTask(taskId, torrentFilePath)
  const player = await resolveWindowsMediaPlayer(filename)

  if (player) {
    const args = player.argsFor(videoUrl, audioUrl, title)
    log.info(`launching external player ${player.executable} for ${title}`)
    const child = spawn(player.executable, args, {
      detached: true,
      stdio: 'ignore',
      shell: false,
      windowsHide: false
    })
    child.unref()
    return true
  }

  // Fallback for UWP / Movies & TV when no Win32 executable was resolved:
  // write a temporary .m3u8 playlist pointing to the loopback HTTP stream and open it via the shell.
  if (openPathFallback) {
    const m3uPath = join(tempDir, `draco-watch-${taskId.replace(/[^a-z0-9_-]/gi, '')}.m3u8`)
    const m3uContent = `#EXTM3U\n#EXTINF:-1,${title}\n${videoUrl}\n`
    await writeFile(m3uPath, m3uContent, 'utf8')
    const err = await openPathFallback(m3uPath)
    return err === ''
  }

  return false
}
