import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
const source = join(root, 'extension')
const target = join(root, 'extension-firefox')

await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
for (const name of ['background.js', 'content.js', 'popup.html', 'popup.js', 'icon.png']) {
  await cp(join(source, name), join(target, name))
}

const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'))
delete manifest.key
delete manifest.minimum_chrome_version
manifest.background = { scripts: ['background.js'] }
manifest.browser_specific_settings = {
  gecko: { id: 'draco@nihil.local', strict_min_version: '128.0' }
}
await writeFile(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
console.log(`built ${target}`)
