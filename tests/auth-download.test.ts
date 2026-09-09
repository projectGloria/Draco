import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ok, strictEqual } from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { DownloadManager } from '../src/main/engine/manager.ts'
import { createTask } from '../src/main/engine/create.ts'
import type { Credentials } from '../src/main/engine/auth.ts'
import type { EngineSettings } from '../src/main/engine/manager.ts'
import type { DownloadTask } from '../src/shared/types.ts'

/**
 * A whole password-protected download, start to finish, over several
 * connections.
 *
 * The unit tests cover the header maths and `auth-server.test.ts` covers the
 * probe; this covers the part in between that nothing else reaches - every
 * ranged connection authenticating itself, the file landing complete, and the
 * bytes on disk being the bytes the server had.
 */

const USER = 'draco'
const PASS = 'let me in'
const REALM = 'Protected Files'
const NONCE = 'downloadnonce'
/** Big enough that the segmenter splits it across the connection budget. */
const BODY = Buffer.from(
  Array.from({ length: 512 * 1024 }, (_, index) => index % 251).map((value) => String.fromCharCode(value)).join(''),
  'latin1'
)
const DIGEST = createHash('sha256').update(BODY).digest('hex')

const md5 = (value: string): string => createHash('md5').update(value, 'utf8').digest('hex')

let server: Server
let base = ''
let dir = ''
let rangedRequests = 0
let unauthorizedRequests = 0

function digestOk(req: IncomingMessage, header: string): boolean {
  const params: Record<string, string> = {}
  const pattern = /([a-z0-9_-]+)=(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(header)) !== null) {
    params[match[1].toLowerCase()] = match[2] ?? match[3] ?? ''
  }
  if (params.username !== USER || params.nonce !== NONCE) return false

  const ha1 = md5(`${USER}:${REALM}:${PASS}`)
  const ha2 = md5(`${req.method}:${params.uri}`)
  const expected = params.qop
    ? md5(`${ha1}:${NONCE}:${params.nc}:${params.cnonce}:${params.qop}:${ha2}`)
    : md5(`${ha1}:${NONCE}:${ha2}`)
  return params.response === expected
}

function serve(req: IncomingMessage, res: ServerResponse): void {
  const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''))
  res.setHeader('accept-ranges', 'bytes')
  res.setHeader('etag', '"download-etag"')
  res.setHeader('content-type', 'application/octet-stream')

  if (range) {
    rangedRequests++
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
  dir = await mkdtemp(join(tmpdir(), 'draco-auth-dl-'))
  server = createServer((req, res) => {
    const header = String(req.headers.authorization ?? '')
    if (!header.startsWith('Digest ') || !digestOk(req, header)) {
      unauthorizedRequests++
      res.setHeader(
        'www-authenticate',
        `Digest realm="${REALM}", qop="auth", nonce="${NONCE}", algorithm=MD5`
      )
      res.writeHead(401, { 'content-length': '0' })
      res.end()
      return
    }
    serve(req, res)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
})

function settingsFor(): EngineSettings {
  return {
    maxConcurrentTasks: 1,
    maxConnectionsPerTask: 4,
    minSplitSize: 64 * 1024,
    retryLimit: 3,
    timeoutMs: 10_000,
    speedLimit: null,
    proxyUrl: null,
    hostConnectionLimits: [],
    quotaBytes: null,
    quotaWindowMinutes: 60,
    antivirusProgram: null,
    antivirusArgs: [],
    antivirusTimeoutSeconds: 30,
    tempDir: dir
  }
}

/** Runs one task to a terminal state and resolves with it. */
function runToCompletion(
  url: string,
  resolveCredentials: ((url: string, realm: string) => Credentials | null) | undefined
): Promise<DownloadTask> {
  return new Promise((resolve, reject) => {
    const manager = new DownloadManager({
      getSettings: settingsFor,
      onTasks: (tasks) => {
        const task = tasks[0]
        if (!task) return
        if (task.status === 'done' || task.status === 'error') {
          // Let the runner finish unwinding before the manager is torn down.
          setTimeout(() => {
            void manager.shutdown().then(() => resolve(task), reject)
          }, 50)
        }
      },
      onProgress: () => {},
      resolveCredentials
    })

    const task = createTask({ url, dir })
    manager.add(task)
    void manager.start([task.id])
  })
}

describe('downloading a password-protected file', () => {
  it('fails with an actionable message when no password is saved', async () => {
    rangedRequests = 0
    unauthorizedRequests = 0

    const task = await runToCompletion(`${base}/no-password.bin`, () => null)

    strictEqual(task.status, 'error')
    // Not "HTTP 401": the message has to say which site is asking and where to
    // put the password.
    ok(/needs a username and password/i.test(task.error ?? ''), `unexpected error: ${task.error}`)
    ok(/127\.0\.0\.1/.test(task.error ?? ''), 'the message names the host')
    ok(/Protected Files/.test(task.error ?? ''), 'and the realm the server named')
  })

  it('downloads the whole file over several authenticated connections', async () => {
    rangedRequests = 0
    unauthorizedRequests = 0

    const task = await runToCompletion(`${base}/protected.bin`, () => ({
      username: USER,
      password: PASS
    }))

    strictEqual(task.status, 'done', `download failed: ${task.error}`)
    strictEqual(task.size, BODY.length)
    strictEqual(task.received, BODY.length)

    const written = await readFile(join(task.dir, task.filename))
    strictEqual(written.length, BODY.length)
    strictEqual(
      createHash('sha256').update(written).digest('hex'),
      DIGEST,
      'the bytes on disk are the bytes the server had'
    )

    ok(rangedRequests > 1, `expected several ranged connections, saw ${rangedRequests}`)
    // Every connection authenticates itself up front once the task has been
    // challenged once, so a four-connection download is not four more 401s.
    ok(
      unauthorizedRequests <= 2,
      `expected the challenge to be learned once, saw ${unauthorizedRequests} rejections`
    )
  })

  it('reports a rejected password once instead of retrying it', async () => {
    rangedRequests = 0
    unauthorizedRequests = 0

    const task = await runToCompletion(`${base}/wrong.bin`, () => ({
      username: USER,
      password: 'wrong'
    }))

    strictEqual(task.status, 'error')
    ok(/rejected the saved username and password/i.test(task.error ?? ''), `unexpected error: ${task.error}`)
    // A wrong password that is retried is how an account gets locked out.
    ok(unauthorizedRequests <= 6, `expected few attempts, saw ${unauthorizedRequests}`)
  })
})
