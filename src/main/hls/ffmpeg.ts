import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawn } from 'node:child_process'
import { getPaths } from '../bootstrap/paths.ts'
import { logger } from '../log.ts'
import { parseFfmpegVersion, parseSha256 } from '../tools-version.ts'

const log = logger('ffmpeg')

/**
 * ffmpeg is fetched on first use rather than bundled: it is 80 MB of binary
 * that most downloads never need, and shipping it would quadruple the installer
 * for a feature only the grabber uses.
 *
 * It lands in %APPDATA%/Draco/bin, so a reinstall of the app does not mean
 * fetching it again.
 */

/*
 * gyan.dev's "essentials" build is first because it is a quarter of the size and
 * still contains everything a remux needs. The full GPL build from GitHub is the
 * fallback: a stable URL worth having, but 170 MB is a lot of transfer to ask a
 * flaky connection to complete in one piece.
 */
const SOURCES: Array<{ url: string; sha256Url?: string }> = [
  {
    url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
    // Published beside the archive, so the thing we are about to run can be
    // checked against what the publisher says it should be rather than trusted
    // on the strength of the transport alone.
    sha256Url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256'
  },
  { url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip' }
]

/** Where the release channel publishes the version number on its own. */
const VERSION_URL = 'https://www.gyan.dev/ffmpeg/builds/release-version'

/** Anything smaller is a redirect stub or an error page, not a build archive. */
const MIN_ZIP_BYTES = 10_000_000

/** How long the mirror gets to answer at all. */
const CONNECT_TIMEOUT_MS = 30_000
/** How long it may then go without producing a byte. */
const STALL_TIMEOUT_MS = 60_000

export interface ProvisionProgress {
  stage: 'downloading' | 'extracting'
  percent: number | null
}

let inFlight: Promise<string> | null = null

/**
 * Returns the path to ffmpeg.exe, fetching it if this is the first time.
 *
 * Concurrent callers share one download - two HLS tasks finishing at the same
 * moment must not race to write the same file.
 */
export function ensureFfmpeg(onProgress?: (p: ProvisionProgress) => void): Promise<string> {
  if (inFlight) return inFlight

  inFlight = provision(onProgress).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function provision(onProgress?: (p: ProvisionProgress) => void): Promise<string> {
  const target = getPaths().ffmpegExe
  if (await isUsable(target)) return target

  /*
   * A copy already on PATH is worth finding before fetching a second one. Plenty
   * of machines already have ffmpeg installed, and the alternative - downloading
   * 170 MB that fails on a flaky link - leaves a finished download sitting on
   * "Muxing" with nothing to mux it.
   */
  const onPath = await findOnPath('ffmpeg.exe')
  if (onPath && (await isUsable(onPath))) {
    log.info(`using ffmpeg from PATH: ${onPath}`)
    return onPath
  }

  return installFromSources(target, onProgress)
}

/**
 * Fetches a build into `%APPDATA%/Draco/bin`, whatever is there already.
 *
 * Separate from `provision` because updating is the one caller that must not
 * take the copy in hand as an answer - that copy is the thing being replaced.
 */
export async function reinstallFfmpeg(onProgress?: (p: ProvisionProgress) => void): Promise<string> {
  if (inFlight) return inFlight
  inFlight = installFromSources(getPaths().ffmpegExe, onProgress).finally(() => {
    inFlight = null
  })
  return inFlight
}

/** Where ffmpeg would come from right now, and whether Draco owns that copy. */
export async function locateFfmpeg(): Promise<{ path: string; managed: boolean } | null> {
  const target = getPaths().ffmpegExe
  if (await isUsable(target)) return { path: target, managed: true }
  const onPath = await findOnPath('ffmpeg.exe')
  if (onPath && (await isUsable(onPath))) return { path: onPath, managed: false }
  return null
}

/** The version string of a build, e.g. `7.1` from ffmpeg's own banner. */
export async function ffmpegVersion(path: string): Promise<string | null> {
  const output = await capture(path, ['-version'])
  return parseFfmpegVersion(output)
}

/** The version the release channel is publishing, or null if it would not say. */
export async function latestFfmpegVersion(): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS)
  try {
    const res = await fetch(VERSION_URL, { redirect: 'follow', signal: controller.signal })
    if (!res.ok) return null
    return parseFfmpegVersion((await res.text()).slice(0, 200))
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function installFromSources(
  target: string,
  onProgress?: (p: ProvisionProgress) => void
): Promise<string> {
  await mkdir(dirname(target), { recursive: true })

  let lastError: Error | null = null
  for (const source of SOURCES) {
    try {
      await install(source, target, onProgress)
      log.info(`installed ffmpeg from ${source.url}`)
      return target
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      log.warn(`ffmpeg source failed (${source.url}): ${lastError.message}`)
    }
  }

  throw new Error('Could not obtain ffmpeg: ' + (lastError?.message ?? 'unknown error'))
}

async function install(
  source: { url: string; sha256Url?: string },
  target: string,
  onProgress?: (p: ProvisionProgress) => void
): Promise<void> {
  const url = source.url
  const work = await mkdtemp(join(tmpdir(), 'draco-ffmpeg-'))
  const zipPath = join(work, 'build.zip')

  try {
    // Announced before the request rather than on the first chunk: connecting to
    // a slow mirror can take many seconds, and until then the caller's own label
    // ("Muxing") is left on screen describing the wrong thing entirely.
    onProgress?.({ stage: 'downloading', percent: null })
    await download(url, zipPath, onProgress)

    if (source.sha256Url) await verifyDigest(zipPath, source.sha256Url)

    onProgress?.({ stage: 'extracting', percent: null })

    /*
     * Extraction uses Windows' own bsdtar (`tar` has shipped in Windows since
     * 10 1803 and reads zip). Pulling in a zip library for one optional binary
     * would be a dependency the other 99% of the app never touches.
     *
     * The archive is named relatively with `cwd` set rather than passed as an
     * absolute path: tar reads `host:path` as a remote spec, so a path starting
     * `C:\` comes back as "Cannot connect to C: resolve failed". A relative
     * name has no colon in it and no such ambiguity.
     *
     * It costs unpacking the whole archive to a temp folder, which is thrown
     * away immediately afterwards.
     */
    await run('tar', ['-xf', 'build.zip'], work)

    const found = await findFile(work, 'ffmpeg.exe')
    if (!found) throw new Error('The archive contained no ffmpeg.exe')

    // Rename into place last, so a failure never leaves a half-written binary
    // that later looks installed and dies at spawn time.
    await rm(target, { force: true })
    await rename(found, target).catch(async () => {
      // Across volumes rename fails; fall back to a copy.
      const { copyFile } = await import('node:fs/promises')
      await copyFile(found, target)
    })

    if (!(await isUsable(target))) throw new Error('ffmpeg.exe did not run after extraction')
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

async function download(
  url: string,
  destPath: string,
  onProgress?: (p: ProvisionProgress) => void
): Promise<void> {
  /*
   * Both timeouts matter. Without them a mirror that accepts the connection and
   * then goes quiet leaves the whole download parked on "Muxing" indefinitely -
   * fetch has no timeout of its own and pipeline waits forever on a live socket.
   */
  const controller = new AbortController()
  let stall: NodeJS.Timeout = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS)
  const resetStall = (): void => {
    clearTimeout(stall)
    stall = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS)
  }

  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'Draco' },
      signal: controller.signal
    })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`)
    resetStall()

    const lengthHeader = res.headers.get('content-length')
    const total = lengthHeader ? Number(lengthHeader) : null
    let received = 0
    let lastEmit = 0
    let lastPercent = -1

    const file = createWriteStream(destPath)
    const counter = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        received += chunk.length
        resetStall()
        const percent = total ? Math.min(100, (received / total) * 100) : null
        const now = Date.now()
        // The UI only ever shows Math.round(percent), so anything finer than
        // that or faster than 250ms is a broadcast nobody can see.
        const roundedChanged = percent !== null && Math.round(percent) !== lastPercent
        if (now - lastEmit >= 250 || roundedChanged) {
          lastEmit = now
          if (percent !== null) lastPercent = Math.round(percent)
          onProgress?.({ stage: 'downloading', percent })
        }
        file.write(chunk, () => callback())
      },
      final(callback) {
        file.end(() => callback())
      }
    })

    await pipeline(res.body as unknown as NodeJS.ReadableStream, counter)

    /*
     * A stream that ends early does not always reject: the peer can close the
     * connection cleanly mid-body and `pipeline` resolves on a partial file. That
     * is how a 170 MB archive arrived as 152 MB and reached tar as "this does not
     * look like a tar archive" - a confusing error a long way from its cause.
     * Content-Length is the only thing that catches it.
     */
    const written = await stat(destPath)
    if (total !== null && written.size !== total) {
      throw new Error(`Download ended early: got ${written.size} of ${total} bytes`)
    }
    if (written.size < MIN_ZIP_BYTES) {
      throw new Error(`Archive is only ${written.size} bytes; the source returned something else`)
    }
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`Timed out fetching ${url}`)
    throw err
  } finally {
    clearTimeout(stall)
  }
}

/**
 * Checks the archive against the digest its publisher lists beside it.
 *
 * HTTPS says the bytes came from that host unaltered; it says nothing about
 * whether the host is serving what it published. This is one extra request for
 * a file that is about to be executed on the user's machine, so it is cheap at
 * the price. A digest that cannot be fetched is not fatal - the publisher's
 * side file is not part of the contract - but one that disagrees is.
 */
async function verifyDigest(archivePath: string, sha256Url: string): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS)

  let published: string | null = null
  try {
    const res = await fetch(sha256Url, { redirect: 'follow', signal: controller.signal })
    if (res.ok) published = parseSha256(await res.text())
  } catch {
    // Fall through: unverifiable, not wrong.
  } finally {
    clearTimeout(timer)
  }

  if (!published) {
    log.warn(`no published digest for ${sha256Url}; installing unverified`)
    return
  }

  const hash = createHash('sha256')
  await pipeline(createReadStream(archivePath), hash)
  const actual = hash.digest('hex')
  if (actual !== published) {
    throw new Error(`Archive digest ${actual.slice(0, 16)}… does not match the published ${published.slice(0, 16)}…`)
  }
  log.info('ffmpeg archive matches its published sha256')
}

/** Runs a binary for its own output; used only for version banners. */
function capture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString('utf8')).slice(0, 4096)
    })
    child.on('error', () => resolve(''))
    child.on('close', () => resolve(stdout))
  })
}

/** Depth-first search for a filename inside an extracted tree. */
async function findFile(root: string, name: string): Promise<string | null> {
  const entries = await readdir(root, { withFileTypes: true })

  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      const nested = await findFile(full, name)
      if (nested) return nested
    } else if (entry.name.toLowerCase() === name) {
      return full
    }
  }
  return null
}

/** A binary that exists but will not report a version is not a binary we can use. */
async function isUsable(path: string): Promise<boolean> {
  try {
    await stat(path)
  } catch {
    return false
  }

  try {
    await run(path, ['-version'])
    return true
  } catch {
    return false
  }
}

/**
 * Locates a binary the user already has. Mirrors what `youtube.ts` does for
 * yt-dlp: an ffmpeg already on PATH is the same ffmpeg we would download.
 */
async function findOnPath(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('where.exe', [name], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })

    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString('utf8')).slice(0, 4096)
    })
    child.on('error', () => resolve(null))
    child.on('close', () => {
      const first = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean)
      resolve(first || null)
    })
  })
}

function run(command: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Argument array with shell:false throughout - none of these paths are
    // allowed anywhere near a command line the shell gets to parse.
    // stdout is discarded rather than piped: `ffmpeg -version` is verbose, and
    // an unread pipe is a buffer waiting to fill up and wedge the child.
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      cwd,
      stdio: ['ignore', 'ignore', 'pipe']
    })

    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2000)
    })

    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`))
    })
  })
}
