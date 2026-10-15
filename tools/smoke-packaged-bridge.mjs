/** Relays native-messaging frames through the packaged host and desktop app. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') throw new Error('Packaged bridge smoke requires Windows')
const project = fileURLToPath(new URL('../', import.meta.url))
const appExe = join(project, 'dist', 'win-unpacked', 'Draco.exe')
const hostExe = join(project, 'dist', 'win-unpacked', 'resources', 'draco-host.exe')
const work = await mkdtemp(join(tmpdir(), 'draco-bridge-smoke-'))
const appData = join(work, 'appdata')
const profile = join(appData, 'Draco')
const pipe = String.raw`\\.\pipe\draco-smoke-${randomUUID()}`
const requestId = randomUUID()
let desktop = null

const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const appEnv = { ...process.env, DRACO_SMOKE_PROFILE_ROOT: profile, DRACO_SMOKE_PIPE: pipe }
const hostEnv = { ...appEnv, APPDATA: appData }
delete appEnv.ELECTRON_RUN_AS_NODE
delete hostEnv.ELECTRON_RUN_AS_NODE

async function stopDesktop() {
  if (!desktop || desktop.exitCode !== null) return
  const child = desktop
  desktop = null
  child.kill()
  await Promise.race([
    new Promise((done) => child.once('close', done)),
    delay(10_000).then(() => { throw new Error('Disposable Draco did not exit') })
  ])
}

async function launchDesktop(args = ['--smoke-bridge']) {
  const child = spawn(appExe, args, { env: appEnv, windowsHide: true })
  child.on('error', () => {})
  return child
}

async function nativeMessage(message) {
  return new Promise((done, reject) => {
    const child = spawn(hostExe, [], { env: hostEnv, windowsHide: true })
    let received = Buffer.alloc(0)
    let errors = ''
    let settled = false
    const finish = (error, reply) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else done(reply)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error('Native host timed out'))
    }, 15_000)
    child.stderr.on('data', (chunk) => { errors += chunk })
    child.stdout.on('data', (chunk) => {
      received = Buffer.concat([received, chunk])
      if (received.length < 4) return
      const length = received.readUInt32LE(0)
      if (length > 1024 * 1024) return finish(new Error('Native reply exceeds browser limit'))
      if (received.length >= length + 4) {
        try { finish(null, JSON.parse(received.subarray(4, length + 4).toString('utf8'))) }
        catch (error) { finish(error) }
      }
    })
    child.on('error', (error) => finish(error))
    child.on('close', (code) => {
      if (!settled) finish(new Error(`Native host exited ${code}: ${errors}`))
    })
    const body = Buffer.from(JSON.stringify(message))
    const frame = Buffer.alloc(4 + body.length)
    frame.writeUInt32LE(body.length, 0)
    body.copy(frame, 4)
    child.stdin.end(frame)
  })
}

async function waitForBridge() {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const reply = await nativeMessage({ type: 'ping', requestId: randomUUID() })
    if (reply.ok) return
    await delay(300)
  }
  throw new Error('Disposable packaged bridge did not become ready')
}

try {
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'settings.json'), JSON.stringify({
    confirmHandoff: false, takeoverEnabled: true, associateTorrents: false,
    showProgressWindow: false, watchClipboard: false, autoCheckUpdates: false,
    downloadDir: join(work, 'downloads')
  }))
  await writeFile(join(profile, 'host-config.json'), JSON.stringify({
    appPath: appExe, appArgs: ['--smoke-bridge']
  }))

  const message = {
    type: 'download', requestId,
    url: `https://example.invalid/draco-smoke.bin?run=${requestId}`,
    filename: 'draco-smoke.bin', size: 4096
  }
  for (let run = 1; run <= 2; run++) {
    desktop = await launchDesktop()
    await waitForBridge()
    const reply = await nativeMessage(message)
    if (!reply.ok || !reply.taken) {
      throw new Error(`Packaged bridge rejected run ${run}: ${JSON.stringify(reply)}`)
    }
    const keyFile = await stat(join(profile, 'Local State')).catch(() => null)
    if (!keyFile) throw new Error(`Windows encryption key was absent before handoff ${run} was acknowledged`)
    await stopDesktop()
  }

  const verifierEnv = { ...appEnv, DRACO_VERIFY_PROFILE_ROOT: profile }
  delete verifierEnv.DRACO_SMOKE_PROFILE_ROOT
  delete verifierEnv.DRACO_SMOKE_PIPE
  await new Promise((done, reject) => {
    const child = spawn(appExe, ['--verify-profile'], { env: verifierEnv, windowsHide: true })
    const timer = setTimeout(() => { child.kill(); reject(new Error('Profile verification timed out')) }, 30_000)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', async (code) => {
      clearTimeout(timer)
      if (code === 0) done()
      else {
        const report = await readFile(join(profile, 'profile-verification.json'), 'utf8').catch(() => '')
        const snapshots = await Promise.all(['tasks.json', 'tasks.json.bak'].map(async (name) => {
          const raw = await readFile(join(profile, name), 'utf8').catch(() => '')
          let shape = 'invalid JSON'
          try {
            const parsed = JSON.parse(raw)
            shape = `version=${parsed.sealedVersion}, payload=${typeof parsed.payload}:${parsed.payload?.length}`
          } catch {}
          return `${name} ${raw.length} bytes ${shape}`
        }))
        reject(new Error(`Profile verification exited ${code}: ${report}; ${snapshots.join('; ')}`))
      }
    })
  })
  const report = JSON.parse(await readFile(join(profile, 'profile-verification.json'), 'utf8'))
  if (report.error || report.tasks.length !== 1 || report.tasks[0].handoffId !== requestId) {
    throw new Error(`Replay created a duplicate or lost its receipt: ${JSON.stringify(report)}`)
  }
  console.log('Packaged native host handoff and restart replay passed on an isolated pipe.')
} finally {
  await stopDesktop()
  if (!resolve(work).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe smoke cleanup path')
  await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
}
