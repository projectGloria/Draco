/** Checks the actual Electron/Windows cipher without touching Draco user data. */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') throw new Error('This smoke test requires Windows')
const root = fileURLToPath(new URL('../', import.meta.url))
const work = await mkdtemp(join(tmpdir(), 'draco-safe-storage-'))
const dataDir = join(work, 'userdata')
const script = join(work, 'check.cjs')
try {
  await mkdir(dataDir)
  await writeFile(script, `
    const { app, safeStorage } = require('electron')
    app.setPath('userData', process.argv[2])
    app.whenReady().then(() => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption unavailable')
      const plain = 'token=secret'.repeat(100000)
      const sealed = safeStorage.encryptString(plain)
      if (sealed.includes(Buffer.from('token=secret'))) throw new Error('Ciphertext includes plaintext')
      if (safeStorage.decryptString(sealed) !== plain) throw new Error('OS cipher round trip failed')
      console.log('Electron safeStorage encrypted and decrypted 1.2 MB on Windows.')
      app.exit(0)
    }).catch((error) => { console.error(error); app.exit(1) })
  `)
  const electron = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [script, dataDir], {
      windowsHide: true,
      env
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    const timer = setTimeout(() => { child.kill(); reject(new Error('Electron cipher smoke test timed out')) }, 30_000)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) { process.stdout.write(output); resolve() }
      else reject(new Error(`Electron cipher smoke test failed (${code}): ${output}`))
    })
  })
} finally {
  if (!resolve(work).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe smoke cleanup path')
  await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
}
