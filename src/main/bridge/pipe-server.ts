import { createServer, type Server, type Socket } from 'node:net'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getPaths } from '../bootstrap/paths.ts'
import { logger } from '../log.ts'
import {
  encodeFrame,
  readFrames,
  validateHostMessage,
  type HostMessage,
  type HostReply
} from './protocol.ts'

const log = logger('bridge')

/**
 * The app end of the browser link.
 *
 * A Windows named pipe rather than a loopback TCP port: no port for another
 * local process to scan, and no loopback listener in the netstat sense. But the
 * pipe name is well known and Windows' default pipe DACL is not actually
 * user-scoped, so the socket itself proves nothing. Two measures close that:
 *
 *  - A per-install secret in %APPDATA%/Draco (user-only ACLs). The Go host
 *    reads it and sends it as the first frame on every connection; any socket
 *    that does not authenticate within a few seconds is destroyed, so a local
 *    process cannot inject handoffs into a running app.
 *  - The host, in turn, verifies the process serving the pipe before it sends
 *    anything, so a squatted pipe name cannot harvest the browser's frames.
 */

const smokePipe = process.argv.includes('--smoke-bridge') ? process.env.DRACO_SMOKE_PIPE : undefined
if (process.argv.includes('--smoke-bridge') &&
    !/^\\\\\.\\pipe\\draco-smoke-[a-z0-9-]{8,64}$/.test(smokePipe ?? '')) {
  throw new Error('A disposable bridge pipe is required for smoke mode')
}
export const PIPE_NAME = smokePipe ?? '\\\\.\\pipe\\draco'

/** How long a socket gets to produce a valid hello frame. */
const AUTH_TIMEOUT_MS = 5_000

/**
 * The largest frame a socket may send before it authenticates. The hello is
 * `{"v":1,"secret":"<43 chars>"}`, well under 100 bytes; this leaves room for
 * a longer secret and nothing more.
 */
const PRE_AUTH_MAX_FRAME_BYTES = 4 * 1024

export interface BridgeHandlers {
  onMessage(message: HostMessage): Promise<HostReply>
}

/** Loads the per-install pipe secret, creating it on first run. */
export async function ensurePipeSecret(): Promise<string> {
  const file = join(getPaths().root, 'pipe-secret')
  try {
    const existing = (await readFile(file, 'utf8')).trim()
    if (/^[A-Za-z0-9_-]{32,128}$/.test(existing)) return existing
  } catch {
    // First run, or the file was removed - fall through and mint a new one.
  }
  const secret = randomBytes(32).toString('base64url')
  await writeFile(file, secret + '\n', 'utf8')
  return secret
}

export class PipeServer {
  private server: Server | null = null
  private sockets = new Set<Socket>()
  private handlers: BridgeHandlers
  /** Sha256 of the install's secret: timingSafeEqual needs equal-length inputs. */
  private secretDigest: Buffer | null = null

  constructor(handlers: BridgeHandlers) {
    this.handlers = handlers
  }

  get listening(): boolean {
    return this.server?.listening ?? false
  }

  async start(secret: string): Promise<void> {
    if (this.server) return
    if (!secret) throw new Error('pipe secret is required before the bridge can listen')
    this.secretDigest = createHash('sha256').update(secret).digest()

    await new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => this.attach(socket))

      server.once('error', (err: NodeJS.ErrnoException) => {
        // EADDRINUSE means another Draco already owns the pipe. That is a
        // second instance, which the single-instance lock should have stopped -
        // or the name is being squatted, which the host's own verification
        // catches on its side.
        log.error('pipe server failed to listen', err)
        reject(err)
      })

      server.listen(PIPE_NAME, () => {
        this.server = server
        log.info(`listening on ${PIPE_NAME}`)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()

    const server = this.server
    this.server = null
    if (!server) return

    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private attach(socket: Socket): void {
    this.sockets.add(socket)
    // Chunks are collected and joined only once a whole frame can be present.
    // Concatenating on every 'data' event re-copied the growing buffer each
    // time - quadratic, about 10 s of main-thread CPU for one 64 MiB frame.
    let chunks: Buffer[] = []
    let pendingBytes = 0
    /** Bytes needed before parsing can make progress: a prefix, then its body. */
    let needBytes = 4
    let dispatchChain = Promise.resolve()
    let authenticated = false

    const authTimer = setTimeout(() => {
      if (!authenticated) {
        log.warn('host connection did not authenticate; dropping it')
        socket.destroy()
      }
    }, AUTH_TIMEOUT_MS)
    authTimer.unref?.()

    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      pendingBytes += chunk.length
      // Nothing parseable yet, so nothing is copied.
      if (pendingBytes < needBytes) return

      let buffer = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, pendingBytes)
      let frames: unknown[] = []
      try {
        if (!authenticated) {
          // One hello-sized frame only. Anything larger is refused on its
          // length prefix, so an unauthenticated peer - any local process,
          // since the pipe DACL is not user-scoped - cannot make us buffer it.
          const hello = readFrames(buffer, PRE_AUTH_MAX_FRAME_BYTES, 1)
          buffer = hello.rest
          if (hello.frames.length === 1) {
            if (!this.acceptHello(hello.frames[0])) {
              log.warn('host connection presented an invalid hello; dropping it')
              socket.destroy()
              return
            }
            clearTimeout(authTimer)
            authenticated = true
          }
        }
        if (authenticated) {
          const result = readFrames(buffer)
          frames = result.frames
          buffer = result.rest
        }
      } catch (err) {
        // A malformed stream cannot be resynchronised - the length prefixes are
        // no longer trustworthy - so drop the connection and let it reconnect.
        log.error('dropping host connection', err)
        socket.destroy()
        return
      }

      chunks = buffer.length > 0 ? [buffer] : []
      pendingBytes = buffer.length
      // The next frame's declared size says how long to wait before parsing
      // again. Its limit was already checked if the prefix is here; a prefix
      // still arriving waits for its 4 bytes.
      needBytes = pendingBytes >= 4 ? 4 + buffer.readUInt32LE(0) : 4

      for (const frame of frames) {
        dispatchChain = dispatchChain
          .then(() => this.dispatch(socket, frame))
          .catch((err) => log.error('host dispatch failed', err))
      }
    })

    socket.on('error', (err) => {
      log.warn(`host socket error: ${err.message}`)
      socket.destroy()
    })
    socket.on('close', () => {
      clearTimeout(authTimer)
      this.sockets.delete(socket)
    })
  }

  /** Constant-time check of the hello frame against the install's secret. */
  private acceptHello(frame: unknown): boolean {
    if (!this.secretDigest) return false
    const hello = frame as { v?: unknown; secret?: unknown } | null
    if (!hello || typeof hello !== 'object' || hello.v !== 1 || typeof hello.secret !== 'string') {
      return false
    }
    const presented = createHash('sha256').update(hello.secret).digest()
    return timingSafeEqual(presented, this.secretDigest)
  }

  private async dispatch(socket: Socket, frame: unknown): Promise<void> {
    let reply: HostReply

    try {
      // Everything arriving here originates in a web page's network activity.
      // It is data, never instructions, and the handler validates it again.
      reply = await this.handlers.onMessage(validateHostMessage(frame))
    } catch (err) {
      reply = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    if (!socket.destroyed) socket.write(encodeFrame(reply))
  }
}
