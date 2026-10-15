const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')
const { access, readFile } = require('node:fs/promises')
const { join } = require('node:path')
const { pipeline } = require('node:stream/promises')

async function validateBundle(context) {
  const root = context.packager.projectDir
  const runtime = join(root, 'resources', 'runtime')
  try {
    const manifest = JSON.parse(await readFile(join(runtime, 'manifest.json'), 'utf8'))
    if (manifest.platform !== 'win32-x64') throw new Error('Wrong runtime architecture')
    for (const name of ['ffmpeg.exe', 'ffprobe.exe', 'yt-dlp.exe']) {
      const hash = createHash('sha256')
      await pipeline(createReadStream(join(runtime, name)), hash)
      if (hash.digest('hex') !== manifest.files?.[name]) throw new Error(`${name} is missing or changed`)
    }
    for (const file of ['host/draco-host.exe', 'extension/manifest.json', 'extension-firefox/manifest.json', 'resources/runtime/licenses']) {
      await access(join(root, file))
    }
  } catch (error) {
    throw new Error(`Standalone bundle is incomplete. Run npm run runtime and npm run host before packaging. ${error.message}`)
  }
}

module.exports = async function checkBundle(context) {
  await validateBundle(context)
  const { execFile } = require('node:child_process')
  const { promisify } = require('node:util')
  const electron = require('electron')
  const root = context.packager.projectDir
  const { stdout } = await promisify(execFile)(electron, [join(__dirname, 'check-native.cjs'), join(root, 'node_modules')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 30000
  })
  console.log(stdout.trim())
}
module.exports.validateBundle = validateBundle
