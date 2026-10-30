import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import assert from 'node:assert/strict'
import { run } from './build-support.mjs'
import { main } from '../src/cli/draco.ts'

const work = await mkdtemp(join(tmpdir(), 'draco-cli-media-'))
const previous = process.env.APPDATA
process.env.APPDATA = work
let server
try {
  const input = join(work, 'sample.mp4')
  await run(resolve('resources/runtime/ffmpeg.exe'), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:d=1', '-c:v', 'libx264', input])
  const data = await readFile(input)
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': data.length })
    res.end(req.method === 'HEAD' ? undefined : data)
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const messages = []
  const code = await main(['--ignore-config', `http://127.0.0.1:${server.address().port}/sample.mp4`,
    '-P', join(work, 'downloads'), '-S', 'res', '--embed-metadata', '--no-mtime',
    '-o', '%(title)s - %(channel,uploader)s.%(ext)s'], {
    preferences: {}, signal: new AbortController().signal, choose: async () => ({ kind: 'best' }),
    status: (kind, lines) => messages.push(...lines)
  })
  assert.equal(code, 0, messages.join('\n'))
  assert(messages.some(line => /━.*%/.test(line)), messages.join('\n'))
  assert(messages.some(line => line.startsWith('Saved: ')), messages.join('\n'))
  assert(messages.some(line => line.includes('Finishing your file')), messages.join('\n'))
  assert((await readdir(join(work, 'downloads'))).some(name => name.endsWith('.mp4')))
  console.log('Real yt-dlp download, fallback template, progress bar, metadata processing and completion passed.')
} finally {
  server?.closeAllConnections()
  if (server) await new Promise(done => server.close(done))
  if (previous === undefined) delete process.env.APPDATA
  else process.env.APPDATA = previous
  if (!resolve(work).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unexpected temporary path')
  await rm(work, { recursive: true, force: true })
}
