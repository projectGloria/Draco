import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { spawn } from 'node:child_process'

export async function sha256(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

export async function fetchText(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'Draco-build' }, signal: AbortSignal.timeout(60_000)
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`)
  return response.text()
}

/** Build inputs are cached only after their publisher's digest matches. */
export async function download(url, path, expected) {
  if (expected && await sha256(path).catch(() => null) === expected) return path
  await mkdir(dirname(path), { recursive: true })
  const partial = `${path}.partial`
  console.log(`Downloading ${url}`)
  try {
    // Windows ships curl alongside tar. Its transfer/stall deadlines also
    // cover mirrors that leave a large response body open indefinitely.
    await run(process.platform === 'win32' ? 'curl.exe' : 'curl', [
      '--fail', '--location', '--compressed', '--silent', '--show-error',
      '--connect-timeout', '30', '--speed-limit', '1024', '--speed-time', '60',
      '--max-time', '240', '--retry', '2', '--retry-max-time', '240',
      '--output', partial, url
    ])
    if (!(await stat(partial)).size) throw new Error(`Empty download: ${url}`)
    if (expected && await sha256(partial) !== expected) throw new Error(`SHA-256 mismatch: ${url}`)
    await rename(partial, path)
    return path
  } finally {
    await rm(partial, { force: true })
  }
}

export function run(command, args, options = {}) {
  const { timeoutMs = 5 * 60_000, ...spawnOptions } = options
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...spawnOptions
    })
    let output = ''
    child.stdout?.on('data', (chunk) => { output = (output + chunk).slice(-32_000) })
    child.stderr?.on('data', (chunk) => { output = (output + chunk).slice(-32_000) })
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Timed out: ${command}`)) }, timeoutMs)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(output.trim())
      else reject(new Error(`${command} exited with ${code}: ${output}`))
    })
  })
}
