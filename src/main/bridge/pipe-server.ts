import { createServer, type Server, type Socket } from 'node:net'
import { logger } from '../log.ts'
import { encodeFrame, readFrames, type HostMessage, type HostReply } from './protocol.ts'

const log = logger('bridge')

/**
 * The app end of the browser link.
 *
 * A Windows named pipe rather than a loopback TCP port: the default ACL scopes
 * it to the logged-in user, so there is no port for another local process to
 * find and no shared secret to keep in sync. The Go host dials it; nothing else
 * on the machine can.
 */

export const PIPE_NAME = '\\\\.\\pipe\\draco'

export interface BridgeHandlers {
  onMessage(message: HostMessage): Promise<HostReply>
}

export class PipeServer {
  private server: Server | null = null
  private sockets = new Set<Socket>()
  private handlers: BridgeHandlers

  constructor(handlers: BridgeHandlers) {
    this.handlers = handlers
  }

  get listening(): boolean {
    return this.server?.listening ?? false
  }

  async start(): Promise<void> {
    if (this.server) return

    await new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => this.attach(socket))

      server.once('error', (err: NodeJS.ErrnoException) => {
        // EADDRINUSE means another Draco already owns the pipe. That is a
        // second instance, which the single-instance lock should have stopped.
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
    // Annotated because `subarray` widens the backing store to ArrayBufferLike,
    // which no longer assigns back to the ArrayBuffer that `alloc` inferred.
    let buffer: Buffer = Buffer.alloc(0)

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])

      let frames: unknown[]
      try {
        const result = readFrames(buffer)
        frames = result.frames
        buffer = result.rest
      } catch (err) {
        // A malformed stream cannot be resynchronised - the length prefixes are
        // no longer trustworthy - so drop the connection and let it reconnect.
        log.error('dropping host connection', err)
        socket.destroy()
        return
      }

      for (const frame of frames) void this.dispatch(socket, frame)
    })

    socket.on('error', (err) => log.warn(`host socket error: ${err.message}`))
    socket.on('close', () => this.sockets.delete(socket))
  }

  private async dispatch(socket: Socket, frame: unknown): Promise<void> {
    let reply: HostReply

    try {
      // Everything arriving here originates in a web page's network activity.
      // It is data, never instructions, and the handler validates it again.
      reply = await this.handlers.onMessage(frame as HostMessage)
    } catch (err) {
      reply = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    if (!socket.destroyed) socket.write(encodeFrame(reply))
  }
}
