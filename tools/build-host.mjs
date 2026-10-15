import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { download, fetchText, run } from './build-support.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const cache = join(root, '.build-cache')
let go = 'go'
try { await run(go, ['version']) } catch {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Automatic Go setup requires Windows x64')
  go = join(cache, 'go', 'bin', 'go.exe')
  try { await run(go, ['version']) } catch {
    const releases = JSON.parse(await fetchText('https://go.dev/dl/?mode=json'))
    const release = releases.find((item) => item.stable)
    const file = release?.files.find((item) => item.os === 'windows' && item.arch === 'amd64' && item.kind === 'archive')
    if (!file || !/^go[\w.-]+\.zip$/.test(file.filename) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid Go release metadata')
    await mkdir(cache, { recursive: true })
    const archive = await download(`https://go.dev/dl/${file.filename}`, join(cache, file.filename), file.sha256)
    const work = await mkdtemp(join(cache, 'go-extract-'))
    try {
      await run('tar.exe', ['-xf', relative(work, archive)], { cwd: work })
      await rm(join(cache, 'go'), { recursive: true, force: true })
      await rename(join(work, 'go'), join(cache, 'go'))
    } finally { await rm(work, { recursive: true, force: true }) }
  }
}
const env = { ...process.env, CGO_ENABLED: '0', GOOS: 'windows', GOARCH: 'amd64' }
console.log(await run(go, ['test', './...'], { cwd: join(root, 'host'), env }))
console.log(await run(go, ['build', '-trimpath', '-ldflags', '-s -w', '-o', 'draco-host.exe', '.'], { cwd: join(root, 'host'), env }))
console.log('Built standalone browser bridge; Go is not required on the destination PC.')
