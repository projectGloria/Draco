/** Exercises packaged migration and restore without touching the installed profile. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') throw new Error('Packaged profile smoke test requires Windows')
const project = fileURLToPath(new URL('../', import.meta.url))
const executable = join(project, 'dist', 'win-unpacked', 'Draco.exe')
const work = await mkdtemp(join(tmpdir(), 'draco-profile-smoke-'))
const profile = join(work, 'profile')
const destination = join(work, 'downloads')
const id = 'packaged-resume-smoke'
const token = 'smoke-secret-marker'
const filename = 'resume.bin'
const part = join(profile, 'incomplete', '.draco-tasks',
  createHash('sha256').update(id).digest('hex'), filename + '.dracodl')
const legacyId = 'packaged-legacy-smoke'
const legacyFile = 'legacy.bin'
const legacyPart = join(profile, 'incomplete', legacyFile + '.dracodl')
const migratedPart = join(profile, 'incomplete', '.draco-tasks',
  createHash('sha256').update(legacyId).digest('hex'), legacyFile + '.dracodl')
const conflictPart = join(profile, 'incomplete', 'conflict.bin.dracodl')
const conflictIds = ['packaged-conflict-a', 'packaged-conflict-b']

async function launch(failFirstWrite = false) {
  const env = { ...process.env, DRACO_VERIFY_PROFILE_ROOT: profile }
  if (failFirstWrite) env.DRACO_VERIFY_FAIL_FIRST_WRITE = '1'
  delete env.ELECTRON_RUN_AS_NODE
  await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, ['--verify-profile'], { env, windowsHide: true })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Packaged profile verification timed out'))
    }, 30_000)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise()
      else reject(new Error(`Packaged profile verification failed (${code}): ${output}`))
    })
  })
  const report = JSON.parse(await readFile(join(profile, 'profile-verification.json'), 'utf8'))
  if (report.error) throw new Error(report.error)
  return report
}

function assertSealed(raw, name) {
  const envelope = JSON.parse(raw)
  if (envelope.sealedVersion !== 1 || typeof envelope.payload !== 'string') {
    throw new Error(`${name} was not migrated to a sealed envelope`)
  }
  if (raw.includes(token)) throw new Error(`${name} still exposes the secret marker`)
}

try {
  await mkdir(dirname(part), { recursive: true })
  await mkdir(destination, { recursive: true })
  await writeFile(part, Buffer.alloc(2048, 'a'))
  await writeFile(legacyPart, Buffer.alloc(512, 'b'))
  await writeFile(conflictPart, Buffer.alloc(256, 'c'))
  const url = `https://example.test/resume.bin?token=${token}`
  const task = {
    id, url, filename, dir: destination, size: 4096, received: 400,
    status: 'downloading', kind: 'file', headers: { cookie: `session=${token}` }
  }
  const journal = {
    version: 1, url, finalUrl: url, filename, size: 4096,
    etag: '"smoke-v1"', lastModified: null,
    segments: [{ start: 0, end: 4095, position: 2048, active: false }],
    updatedAt: Date.now()
  }
  const legacyUrl = 'https://example.test/legacy.bin'
  const legacyTask = {
    id: legacyId, url: legacyUrl, filename: legacyFile, dir: destination,
    size: 1024, received: 0, status: 'downloading', kind: 'file'
  }
  const legacyJournal = {
    version: 1, url: legacyUrl, finalUrl: legacyUrl, filename: legacyFile, size: 1024,
    etag: '"legacy-v1"', lastModified: null,
    segments: [{ start: 0, end: 1023, position: 512, active: false }],
    updatedAt: Date.now()
  }
  const conflictTasks = conflictIds.map((conflictId) => ({
    id: conflictId, url: 'https://example.test/conflict.bin', filename: 'conflict.bin',
    dir: destination, size: 512, received: 0, status: 'paused', kind: 'file'
  }))
  const handoff = {
    kind: 'file', id: 'smoke-handoff', url, filename, size: 4096,
    mimeType: 'application/octet-stream', headers: { cookie: `session=${token}` },
    expiresAt: Date.now() + 240_000
  }
  await writeFile(part + '.json', JSON.stringify(journal))
  await writeFile(legacyPart + '.json', JSON.stringify(legacyJournal))
  for (const name of ['tasks.json', 'tasks.json.bak']) {
    await writeFile(join(profile, name), JSON.stringify([task, legacyTask, ...conflictTasks]))
  }
  for (const name of ['browser-handoffs.json', 'browser-handoffs.json.bak']) {
    await writeFile(join(profile, name), JSON.stringify([handoff]))
  }

  for (let run = 1; run <= 2; run++) {
    const report = await launch(run === 1)
    const restored = new Map(report.tasks.map((item) => [item.id, item]))
    if (report.tasks.length !== 4 ||
        restored.get(id)?.status !== 'paused' || restored.get(id)?.received !== 2048 ||
        restored.get(legacyId)?.status !== 'paused' || restored.get(legacyId)?.received !== 512 ||
        conflictIds.some((conflictId) => restored.get(conflictId)?.received !== 0) ||
        report.handoffIds.length !== 1 || report.handoffIds[0] !== handoff.id ||
        report.writeRetryPassed !== (run === 1) || report.settingsCommitPassed !== true) {
      throw new Error(`Unexpected restore on run ${run}: ${JSON.stringify(report)}`)
    }
    if ((await stat(migratedPart)).size !== 512 ||
        await stat(legacyPart).catch(() => null) !== null ||
        await stat(legacyPart + '.json').catch(() => null) !== null ||
        (await stat(conflictPart)).size !== 256) {
      throw new Error(`Legacy or ambiguous intermediate was mishandled on run ${run}`)
    }
    for (const name of ['tasks.json', 'tasks.json.bak',
      'browser-handoffs.json', 'browser-handoffs.json.bak']) {
      assertSealed(await readFile(join(profile, name), 'utf8'), name)
    }
  }
  console.log('Packaged profile migration, write retry, and restart restore passed twice.')
} finally {
  if (!resolve(work).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe smoke cleanup path')
  await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
}
