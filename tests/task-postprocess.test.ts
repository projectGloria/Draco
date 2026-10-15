import { strictEqual, rejects } from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { it } from 'node:test'
import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'
import { createTask } from '../src/main/engine/create.ts'
import { RateLimiter } from '../src/main/engine/limiter.ts'
import { runConversion } from '../src/main/engine/postprocess.ts'

async function localTaskRunner(): Promise<any> {
  const ffmpeg = resolve('resources/runtime/ffmpeg.exe')
  const bundle = await build({
    entryPoints: ['src/main/engine/task.ts'], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
    define: { 'import.meta.env': '{}' },
    plugins: [{ name: 'local-media-tool', setup(builder) {
      builder.onLoad({ filter: /[\\/]ffmpeg\.ts$/ }, () => ({
        contents: `export async function ensureFfmpeg() { return ${JSON.stringify(ffmpeg)} }`, loader: 'js'
      }))
    } }]
  })
  const module = { exports: {} as { TaskRunner: any } }
  new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
  return module.exports.TaskRunner
}

it('failed conversion preserves the complete source in its workspace and publishes no raw file', async () => {
  const TaskRunner = await localTaskRunner()
  const dir = await mkdtemp(join(tmpdir(), 'draco-conversion-'))
  try {
    const task = createTask({ url: 'https://example.test/song', dir, filename: 'song.bin', postProcess: 'mp3' })
    task.size = 4
    const runner = new TaskRunner(task, { maxConnections: 1, minSplitSize: 1024, retryLimit: 1, timeoutMs: 1000 }, {
      limiter: new RateLimiter(), onUpdate() {}, onFinished() {}
    })
    const { mkdir } = await import('node:fs/promises')
    const { dirname } = await import('node:path')
    await mkdir(dirname(runner.partPath), { recursive: true })
    await writeFile(runner.partPath, 'data')
    runner.received = 4
    await rejects(runner.finish(), /ffmpeg/)
    strictEqual((await readFile(runner.partPath)).toString(), 'data')
    strictEqual((await readdir(dir)).filter((name) => name !== '.draco-tasks').length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('publishes a playable converted file while preserving an existing destination and removing the source', async () => {
  const TaskRunner = await localTaskRunner()
  const dir = await mkdtemp(join(tmpdir(), 'draco-conversion-success-'))
  try {
    const wav = Buffer.alloc(44 + 8820)
    wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
    wav.writeUInt32LE(44100, 24); wav.writeUInt32LE(88200, 28); wav.writeUInt16LE(2, 32)
    wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(8820, 40)
    const task = createTask({ url: 'https://example.test/song', dir, filename: 'song.wav', postProcess: 'mp3' })
    task.size = wav.length
    const runner = new TaskRunner(task, { maxConnections: 1, minSplitSize: 1024, retryLimit: 1, timeoutMs: 1000 }, {
      limiter: new RateLimiter(), onUpdate() {}, onFinished() {}
    })
    const { mkdir } = await import('node:fs/promises')
    const { dirname } = await import('node:path')
    await mkdir(dirname(runner.partPath), { recursive: true })
    await writeFile(runner.partPath, wav)
    await writeFile(join(dir, 'song.mp3'), 'existing file')
    runner.received = wav.length
    await runner.finish()
    strictEqual(task.status, 'done')
    strictEqual(task.filename, 'song (1).mp3')
    strictEqual((await readFile(join(dir, 'song.mp3'))).toString(), 'existing file')
    strictEqual(await readFile(runner.partPath).then(() => true, () => false), false)
    const media = JSON.parse(execFileSync(resolve('resources/runtime/ffprobe.exe'), [
      '-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'json', join(dir, task.filename)
    ], { encoding: 'utf8', windowsHide: true }))
    strictEqual(media.streams[0].codec_name, 'mp3')
    strictEqual((await readdir(dir)).includes('song.wav'), false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('conversion abort waits for the child to exit and release its output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'draco-conversion-abort-'))
  const output = join(dir, 'held.bin')
  const controller = new AbortController()
  const script = `const fs = require('node:fs'); const fd = fs.openSync(${JSON.stringify(output)}, 'w'); fs.writeSync(fd, 'ready'); setInterval(() => fs.writeSync(fd, 'x'), 10)`
  const work = runConversion(process.execPath, ['-e', script], controller.signal)
  const checked = rejects(work, /aborted/)
  try {
    let ready = false
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await readFile(output).then((data) => data.length >= 5, () => false)) { ready = true; break }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    strictEqual(ready, true)
    controller.abort()
    await checked
    // On Windows unlink fails if the child still has the file open.
    await rm(output)
  } finally {
    controller.abort()
    await checked
    await rm(dir, { recursive: true, force: true })
  }
})
