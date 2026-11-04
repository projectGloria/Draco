import { randomUUID } from 'node:crypto'
import { connect, type Socket } from 'node:net'
import { deepStrictEqual, ok } from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

// PIPE_NAME is fixed at import time. Smoke mode points it at a disposable pipe
// so this suite never collides with a Draco that is actually running.
const pipe = `\\\\.\\pipe\\draco-smoke-${randomUUID()}`
process.argv.push('--smoke-bridge')
process.env.DRACO_SMOKE_PIPE = pipe

const { PipeServer } = await import('../src/main/bridge/pipe-server.ts')
const { encodeFrame, readFrames } = await import('../src/main/bridge/protocol.ts')

const SECRET = 'a'.repeat(43)

function open(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(pipe, () => resolve(socket))
    socket.once('error', reject)
  })
}

/** Resolves with the first reply frame, or rejects if the socket closes first. */
function firstReply(socket: Socket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      const { frames } = readFrames(buffer)
      if (frames.length > 0) resolve(frames[0])
    })
    socket.once('close', () => reject(new Error('closed before replying')))
  })
}

function closed(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed) resolve()
    else socket.once('close', () => resolve())
  })
}

describe('PipeServer framing', () => {
  const server = new PipeServer({
    onMessage: async (message) => ({ ok: true, echo: message.type } as never)
  })

  before(async () => { await server.start(SECRET) })
  after(async () => { await server.stop() })

  it('handles a hello and a message that arrive in one write', async () => {
    const socket = await open()
    const reply = firstReply(socket)
    socket.write(Buffer.concat([encodeFrame({ v: 1, secret: SECRET }), encodeFrame({ type: 'ping' })]))
    deepStrictEqual(await reply, { ok: true, echo: 'ping' })
    socket.destroy()
  })

  it('reassembles frames delivered a few bytes at a time', async () => {
    const socket = await open()
    const reply = firstReply(socket)
    const bytes = Buffer.concat([encodeFrame({ v: 1, secret: SECRET }), encodeFrame({ type: 'ping' })])
    for (let i = 0; i < bytes.length; i += 3) {
      socket.write(bytes.subarray(i, i + 3))
      await new Promise((resolve) => setImmediate(resolve))
    }
    deepStrictEqual(await reply, { ok: true, echo: 'ping' })
    socket.destroy()
  })

  it('drops an unauthenticated socket on an oversized length prefix, before its body', async () => {
    const socket = await open()
    socket.on('error', () => {})
    const prefix = Buffer.alloc(4)
    // 32 MiB is legal after authentication, never before it.
    prefix.writeUInt32LE(32 * 1024 * 1024, 0)
    const started = Date.now()
    socket.write(prefix)
    await closed(socket)
    // Well inside the 5 s auth window: rejected on the prefix, not timed out.
    ok(Date.now() - started < 2000)
  })
})
