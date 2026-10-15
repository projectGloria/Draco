import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { run, sha256 } from './build-support.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const packaged = resolve(process.argv[2] ?? join(root, 'dist', 'win-unpacked'))
const resources = join(packaged, 'resources')
const runtime = join(resources, 'runtime')
const manifest = JSON.parse(await readFile(join(runtime, 'manifest.json'), 'utf8'))
for (const name of ['ffmpeg.exe', 'ffprobe.exe', 'yt-dlp.exe']) {
  if (await sha256(join(runtime, name)) !== manifest.files[name]) throw new Error(`Packaged ${name} failed its integrity check`)
}
for (const name of ['draco-host.exe', 'extension/manifest.json', 'extension-firefox/manifest.json', 'runtime/licenses']) {
  await access(join(resources, name))
}
// Only Windows system commands remain on PATH: no developer Node, Go, Python,
// ffmpeg or yt-dlp can accidentally make this smoke test pass.
const env = { ...process.env, PATH: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'), ELECTRON_RUN_AS_NODE: '1' }
delete env.NODE_PATH
delete env.NODE_OPTIONS
const work = await mkdtemp(join(tmpdir(), 'draco-package-check-'))
try {
  const script = join(work, 'check.cjs')
  await writeFile(script, `
    const { execFileSync } = require('node:child_process');
    const { join } = require('node:path');
    const { pathToFileURL } = require('node:url');
    const runtime = process.argv[2];
    for (const name of ['ffmpeg.exe', 'ffprobe.exe', 'yt-dlp.exe']) {
      const version = execFileSync(join(runtime, name), [name === 'yt-dlp.exe' ? '--version' : '-version'],
        { windowsHide: true, timeout: 30000, encoding: 'utf8' });
      console.log(name + ': ' + version.split(/\\r?\\n/)[0]);
    }
    console.log('Bundled JavaScript runtime: ' + process.version);
    const sample = join(__dirname, 'sample.mp4');
    const options = { windowsHide: true, timeout: 30000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
    execFileSync(join(runtime, 'ffmpeg.exe'), ['-v', 'error', '-f', 'lavfi', '-i',
      'color=size=16x16:duration=0.1', '-c:v', 'libx264', '-y', sample], options);
    const probe = JSON.parse(execFileSync(join(runtime, 'ffprobe.exe'), ['-v', 'error',
      '-show_entries', 'stream=codec_type', '-of', 'json', sample], options));
    if (probe.streams[0]?.codec_type !== 'video') throw new Error('Bundled media tools did not produce a video');
    const extracted = JSON.parse(execFileSync(join(runtime, 'yt-dlp.exe'), ['--ignore-config',
      '--enable-file-urls', '--no-remote-components', '--skip-download', '--dump-single-json',
      '--ffmpeg-location', runtime, '--js-runtimes', 'node:' + process.execPath,
      pathToFileURL(sample).href], options));
    if (extracted.ext !== 'mp4') throw new Error('Bundled extractor did not read the local fixture');
    console.log('Offline media encode, probe and extraction passed.');
  `)
  console.log(await run(join(packaged, 'Draco.exe'), [script, runtime], { env }))
  console.log(await run(join(packaged, 'Draco.exe'), [join(root, 'tools', 'check-native.cjs'),
    join(resources, 'app.asar', 'node_modules')], { env }))
  await run(join(resources, 'draco-host.exe'), [], { env })
  console.log('Standalone package verified without developer tools on PATH.')
} finally { await rm(work, { recursive: true, force: true }) }
