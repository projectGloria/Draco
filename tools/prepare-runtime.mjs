import { access, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { download, fetchText, run, sha256 } from './build-support.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const target = join(root, 'resources', 'runtime')
const cache = join(root, '.build-cache')
const required = ['ffmpeg.exe', 'ffprobe.exe', 'yt-dlp.exe']

async function validateBundle() {
  try {
    const manifest = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'))
    if (manifest.platform !== 'win32-x64') return false
    await access(join(target, 'licenses'))
    for (const name of required) {
      if (!manifest.files?.[name] || await sha256(join(target, name)) !== manifest.files[name]) return false
      await run(join(target, name), [name === 'yt-dlp.exe' ? '--version' : '-version'])
    }
    return true
  } catch { return false }
}

async function prepare() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build the Windows x64 runtime on Windows x64')
  if (!process.argv.includes('--refresh') && await validateBundle()) {
    console.log('Verified bundled runtime; use npm run runtime -- --refresh to fetch new releases.')
    return
  }
  await mkdir(cache, { recursive: true })
  const stage = await mkdtemp(join(root, 'resources', '.runtime-'))
  const work = await mkdtemp(join(cache, 'runtime-'))
  let preserveWork = false
  try {
    const release = JSON.parse(await fetchText('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest'))
    const asset = release.assets.find((entry) => entry.name === 'yt-dlp.exe')
    const sumsAsset = release.assets.find((entry) => entry.name === 'SHA2-256SUMS')
    if (!asset || !sumsAsset || !/^[\w.-]+$/.test(release.tag_name)) throw new Error('Invalid yt-dlp release metadata')
    const sums = await fetchText(sumsAsset.browser_download_url)
    const ytHash = /^([a-f0-9]{64})\s+\*?yt-dlp\.exe\s*$/im.exec(sums)?.[1]?.toLowerCase()
    if (!ytHash) throw new Error('yt-dlp release has no SHA-256 for its Windows executable')
    await download(asset.browser_download_url, join(cache, `yt-dlp-${ytHash}.exe`), ytHash)
    await copyFile(join(cache, `yt-dlp-${ytHash}.exe`), join(stage, 'yt-dlp.exe'))
    const licenses = join(stage, 'licenses')
    await mkdir(licenses)
    for (const name of ['LICENSE', 'THIRD_PARTY_LICENSES.txt']) {
      await writeFile(join(licenses, `yt-dlp-${name}.txt`), await fetchText(
        `https://raw.githubusercontent.com/yt-dlp/yt-dlp/${release.tag_name}/${name}`))
    }

    let ffUrl = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
    let ffHash
    let archive
    try {
      if (process.argv.includes('--ffmpeg-source=btbn')) throw new Error('BtbN source selected')
      ffHash = /\b[a-f0-9]{64}\b/i.exec(await fetchText(`${ffUrl}.sha256`))?.[0]?.toLowerCase()
      if (!ffHash) throw new Error('ffmpeg publisher did not supply a SHA-256 digest')
      archive = await download(ffUrl, join(cache, `ffmpeg-${ffHash}.zip`), ffHash)
    } catch (error) {
      console.warn(`Primary ffmpeg source failed: ${error.message}. Trying BtbN.`)
      const fallback = JSON.parse(await fetchText('https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest'))
      const asset = fallback.assets.find((entry) => entry.name === 'ffmpeg-master-latest-win64-gpl.zip')
      if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) throw new Error('Fallback ffmpeg release has no verified Windows archive')
      ffUrl = asset.browser_download_url
      ffHash = asset.digest.slice(7)
      archive = await download(ffUrl, join(cache, `ffmpeg-${ffHash}.zip`), ffHash)
    }
    await run('tar.exe', ['-xf', relative(work, archive)], { cwd: work })
    const folder = (await readdir(work, { withFileTypes: true })).find((entry) => entry.isDirectory())
    if (!folder) throw new Error('ffmpeg archive has no distribution folder')
    const distribution = join(work, folder.name)
    for (const name of ['ffmpeg.exe', 'ffprobe.exe']) await copyFile(join(distribution, 'bin', name), join(stage, name))
    for (const entry of await readdir(distribution, { withFileTypes: true })) {
      if (entry.name !== 'bin') await cp(join(distribution, entry.name), join(licenses, 'ffmpeg', entry.name), { recursive: true })
    }
    const files = {}
    const versions = {}
    for (const name of required) {
      files[name] = await sha256(join(stage, name))
      versions[name] = (await run(join(stage, name), [name === 'yt-dlp.exe' ? '--version' : '-version'])).split(/\r?\n/)[0]
    }
    await writeFile(join(stage, 'manifest.json'), JSON.stringify({
      platform: 'win32-x64', preparedAt: new Date().toISOString(), files, versions,
      sources: { ytDlp: asset.browser_download_url, ytDlpSha256: ytHash, ffmpeg: ffUrl, ffmpegArchiveSha256: ffHash }
    }, null, 2))
    // All downloads and executable checks finish before replacing a working bundle.
    const backup = resolve(work, 'previous-runtime')
    const hadPrevious = await rename(target, backup).then(() => true, (error) => {
      if (error.code === 'ENOENT') return false
      throw error
    })
    try { await rename(stage, target) } catch (error) {
      if (hadPrevious) {
        try { await rename(backup, target) } catch (rollbackError) {
          // The backup is the last working bundle. Never delete it when a
          // locked path or disk failure also prevents restoring its old name.
          preserveWork = true
          throw new AggregateError([error, rollbackError], `Runtime replacement failed; recover the previous bundle from ${backup}`)
        }
      }
      throw error
    }
    console.log('Prepared standalone runtime:', versions)
  } finally {
    await rm(stage, { recursive: true, force: true })
    if (!preserveWork) await rm(work, { recursive: true, force: true })
  }
}

await prepare()
