import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { rejects } from 'node:assert/strict'
import { it } from 'node:test'

const checkBundle = createRequire(import.meta.url)('../tools/check-bundle.cjs').validateBundle

it('refuses to package missing or changed standalone tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'draco-package-test-'))
  const context = { packager: { projectDir: root } }
  try {
    await rejects(checkBundle(context), /Standalone bundle is incomplete/)
    const files: Record<string, string> = {}
    for (const name of ['ffmpeg.exe', 'ffprobe.exe', 'yt-dlp.exe']) {
      const path = join(root, 'resources/runtime', name)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, name)
      files[name] = createHash('sha256').update(name).digest('hex')
    }
    await writeFile(join(root, 'resources/runtime/manifest.json'), JSON.stringify({ platform: 'win32-x64', files }))
    for (const name of ['host/draco-host.exe', 'extension/manifest.json', 'extension-firefox/manifest.json']) {
      const path = join(root, name)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, 'fixture')
    }
    await mkdir(join(root, 'resources/runtime/licenses'))
    await checkBundle(context)
    await writeFile(join(root, 'resources/runtime/yt-dlp.exe'), 'truncated')
    await rejects(checkBundle(context), /yt-dlp.exe is missing or changed/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
