import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
const source = join(root, 'extension')
const target = join(root, 'extension-firefox')

await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
for (const name of ['background.js', 'content.js', 'popup.html', 'popup.js', 'icon.png', 'downloadButton.png']) {
  if (name.endsWith('.js')) {
    // Firefox's browser namespace consistently returns promises. The shared
    // Chromium files use chrome.* for Chrome's MV3 API surface.
    let script = (await readFile(join(source, name), 'utf8')).replace(/\bchrome\./g, 'browser.')
    if (name === 'background.js') {
      const chromeHeaders = "['requestHeaders', 'extraHeaders']"
      if (!script.includes(chromeHeaders)) throw new Error('Chromium request-header listener changed')
      script = script.replace(chromeHeaders, "['requestHeaders']")
      // browser.contextMenus.removeAll is promise-based in Firefox.
      script = script.replace(
        'browser.contextMenus.removeAll(() => {',
        'browser.contextMenus.removeAll().then(() => {'
      )
    }
    await writeFile(join(target, name), script, 'utf8')
  } else {
    await cp(join(source, name), join(target, name))
  }
}
await cp(join(source, 'status-icons'), join(target, 'status-icons'), { recursive: true })

const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'))
delete manifest.key
delete manifest.minimum_chrome_version
manifest.permissions = manifest.permissions.filter((permission) => permission !== 'downloads.ui')
manifest.background = { scripts: ['background.js'] }
manifest.browser_specific_settings = {
  gecko: { id: 'draco@nihil.local', strict_min_version: '128.0' }
}
await writeFile(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
console.log(`built ${target}`)
