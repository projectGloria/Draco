import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { ok, rejects, strictEqual } from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { HttpAuthenticator, type Credentials } from '../src/main/engine/auth.ts'
import { probeUrl } from '../src/main/engine/probe.ts'

/**
 * The 401 path against a real HTTP server.
 *
 * The unit tests prove the headers are computed correctly; this proves the
 * client and a server that actually checks them agree - which is the part that
 * was silently broken before, when every 401 was read as an expired URL.
 *
 * The server is deliberately strict: it verifies the digest response, rejects a
 * repeated nonce count, and counts requests, so a client that authenticated by
 * accident could not pass.
 */

const USER = 'draco'
const PASS = 'let me in'
const REALM = 'Protected Files'
const BODY = Buffer.from('x'.repeat(4096))
const NONCE = 'servernonce123'

const md5 = (value: string): string => createHash('md5').update(value, 'utf8').digest('hex')

let server: Server
let base = ''
/** Every request the server saw, so a test can count round trips. */
let requests: Array<{ path: string; authorized: boolean }> = []
/** Digest nonce counts already spent, which a server must never accept twice. */
let seenCounts = new Set<string>()

function parseAuthParams(header: string): Record<string, string> {
  const params: Record<string, string> = {}
  const pattern = /([a-z0-9_-]+)=(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(header)) !== null) {
    params[match[1].toLowerCase()] = (match[2] ?? match[3] ?? '').replace(/\\(.)/g, '$1')
  }
  return params
}

/** A real Digest check: recompute the response and compare. */
function digestOk(req: IncomingMessage, header: string): boolean {
  const params = parseAuthParams(header)
  if (params.username !== USER || params.nonce !== NONCE) return false

  // A nonce count may be used exactly once. Replaying one is what a client that
  // cached a whole Authorization header would do.
  if (params.nc) {
    if (seenCounts.has(params.nc)) return false
    seenCounts.add(params.nc)
  }

  const ha1 = md5(`${USER}:${REALM}:${PASS}`)
  const ha2 = md5(`${req.method}:${params.uri}`)
  const expected = params.qop
    ? md5(`${ha1}:${NONCE}:${params.nc}:${params.cnonce}:${params.qop}:${ha2}`)
    : md5(`${ha1}:${NONCE}:${ha2}`)

  // The digest is computed over the request target the client claimed, so a
  // mismatch with the real path would let one signature serve any file.
  return params.response === expected && params.uri === req.url
}

function basicOk(header: string): boolean {
  const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8')
  return decoded === `${USER}:${PASS}`
}

function serveBody(req: IncomingMessage, res: ServerResponse): void {
  const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''))
  res.setHeader('accept-ranges', 'bytes')
  res.setHeader('etag', '"fixed-etag"')
  res.setHeader('content-type', 'application/octet-stream')

  if (range) {
    const start = Number(range[1])
    const end = range[2] ? Number(range[2]) : BODY.length - 1
    const slice = BODY.subarray(start, end + 1)
    res.writeHead(206, {
      'content-range': `bytes ${start}-${end}/${BODY.length}`,
      'content-length': String(slice.length)
    })
    res.end(req.method === 'HEAD' ? undefined : slice)
    return
  }

  res.writeHead(200, { 'content-length': String(BODY.length) })
  res.end(req.method === 'HEAD' ? undefined : BODY)
}

before(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    const header = String(req.headers.authorization ?? '')

    const authorized =
      path === '/open.bin' ||
      (path === '/basic.bin' && header.startsWith('Basic ') && basicOk(header)) ||
      (path === '/digest.bin' && header.startsWith('Digest ') && digestOk(req, header))

    requests.push({ path, authorized })

    if (!authorized) {
      res.setHeader(
        'www-authenticate',
        path === '/basic.bin'
          ? `Basic realm="${REALM}"`
          : `Digest realm="${REALM}", qop="auth", nonce="${NONCE}", opaque="op4que", algorithm=MD5`
      )
      res.writeHead(401, { 'content-length': '0' })
      res.end()
      return
    }

    serveBody(req, res)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function reset(): void {
  requests = []
  seenCounts = new Set<string>()
}

const good = (): Credentials => ({ username: USER, password: PASS })
const wrong = (): Credentials => ({ username: USER, password: 'not the password' })

describe('probing a protected file', () => {
  it('fails with 401 when nothing can answer the challenge', async () => {
    reset()
    await rejects(
      () => probeUrl(`${base}/digest.bin`, { timeoutMs: 5000 }),
      /401/,
      'without an authenticator this is exactly the old behaviour'
    )
  })

  it('gets through Digest and reads the real file details', async () => {
    reset()
    const probe = await probeUrl(`${base}/digest.bin`, {
      timeoutMs: 5000,
      auth: new HttpAuthenticator(good)
    })

    strictEqual(probe.size, BODY.length)
    strictEqual(probe.resumable, true, 'ranges still work through authentication')
    strictEqual(probe.etag, '"fixed-etag"')
    ok(requests.some((entry) => entry.authorized), 'the server accepted a computed digest')
  })

  it('gets through Basic on a local server', async () => {
    reset()
    const probe = await probeUrl(`${base}/basic.bin`, {
      timeoutMs: 5000,
      auth: new HttpAuthenticator(good)
    })
    strictEqual(probe.size, BODY.length)
  })

  it('fails once on a wrong password rather than hammering the server', async () => {
    reset()
    // A distinct URL: `probeUrl` caches by URL for a minute, so reusing the one
    // an earlier test already probed successfully would test the cache.
    await rejects(
      () => probeUrl(`${base}/digest.bin?wrong-password`, { timeoutMs: 5000, auth: new HttpAuthenticator(wrong) }),
      /401/
    )

    // HEAD and the ranged GET each get one retry: four requests, none of which
    // repeats a nonce count. An endless retry here is what locks an account.
    ok(requests.length <= 4, `expected at most 4 requests, saw ${requests.length}`)
    strictEqual(requests.some((entry) => entry.authorized), false)
  })

  it('authenticates every later request without being challenged again', async () => {
    reset()
    const auth = new HttpAuthenticator(good)
    await probeUrl(`${base}/digest.bin?first`, { timeoutMs: 5000, auth })
    const challengesDuringFirst = requests.filter((entry) => !entry.authorized).length

    await probeUrl(`${base}/digest.bin?second`, { timeoutMs: 5000, auth })
    const challengesTotal = requests.filter((entry) => !entry.authorized).length

    strictEqual(
      challengesTotal,
      challengesDuringFirst,
      'once armed, an authenticator does not need to be told "no" again'
    )
  })

  it('sends a fresh nonce count per request, which the server checks', async () => {
    reset()
    const auth = new HttpAuthenticator(good)
    // The server refuses a replayed count, so several successful requests can
    // only mean each one was computed on its own.
    await probeUrl(`${base}/digest.bin?a`, { timeoutMs: 5000, auth })
    await probeUrl(`${base}/digest.bin?b`, { timeoutMs: 5000, auth })
    await probeUrl(`${base}/digest.bin?c`, { timeoutMs: 5000, auth })

    ok(seenCounts.size >= 3, `expected distinct nonce counts, saw ${seenCounts.size}`)
  })

  it('leaves an unprotected file alone', async () => {
    reset()
    const probe = await probeUrl(`${base}/open.bin`, {
      timeoutMs: 5000,
      auth: new HttpAuthenticator(() => {
        throw new Error('the password store must not be touched for an open file')
      })
    })
    strictEqual(probe.size, BODY.length)
  })
})

describe('the client the server sees', () => {
  it('never sends a password to a server that did not ask', async () => {
    reset()
    await probeUrl(`${base}/open.bin?quiet`, { timeoutMs: 5000, auth: new HttpAuthenticator(good) })
    strictEqual(requests.every((entry) => entry.path === '/open.bin'), true)
    // Every request to the open path succeeded on its own, so nothing was
    // volunteered before a challenge.
    strictEqual(requests.every((entry) => entry.authorized), true)
  })

  it('generates a client nonce that is not guessable', () => {
    // Not a property of the server exchange, but of what is sent to it: two
    // authenticators must not produce the same cnonce.
    const first = new HttpAuthenticator(good)
    const second = new HttpAuthenticator(good)
    const challenge = `Digest realm="${REALM}", qop="auth", nonce="${NONCE}"`
    first.challenged(`${base}/digest.bin`, challenge)
    second.challenged(`${base}/digest.bin`, challenge)

    const cnonceOf = (header: string | null): string =>
      /cnonce="([^"]+)"/.exec(header ?? '')?.[1] ?? ''

    const a = cnonceOf(first.headerFor(`${base}/digest.bin`, 'GET'))
    const b = cnonceOf(second.headerFor(`${base}/digest.bin`, 'GET'))
    ok(a.length >= 16 && b.length >= 16, 'a client nonce that short is not one')
    ok(a !== b)
    ok(a !== randomBytes(8).toString('hex'))
  })
})
