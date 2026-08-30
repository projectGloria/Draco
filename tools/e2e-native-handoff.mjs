import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const fixture = JSON.parse(
  await readFile(join(process.env.TEMP ?? '', 'draco-youtube-fixture.json'), 'utf8')
)
const video = fixture.formats.find((format) => format.format_id === '399' && format.url)
const audio = fixture.formats
  .filter((format) => /^140-\d+$/.test(format.format_id ?? '') && format.url)
  .sort((a, b) => (b.language_preference ?? 0) - (a.language_preference ?? 0))[0]
if (!video || !audio) throw new Error('Live YouTube fixture formats are missing')

const message = {
  type: 'youtube',
  requestId: 'e2e-prepared-011',
  pageUrl: 'https://www.youtube.com/watch?v=vDMbFWD8cGc',
  pageTitle: 'Half-Life Oddities: Residue Processing',
  referer: 'https://www.youtube.com/watch?v=vDMbFWD8cGc',
  userAgent: 'Mozilla/5.0 Draco E2E',
  pageFormats: [
    {
      itag: 399,
      mimeType: 'video/mp4; codecs="av01.0.09M.08"',
      bitrate: 3_000_000,
      width: 1920,
      height: 1080,
      fps: 30,
      contentLength: video.filesize ?? video.filesize_approx ?? null,
      url: video.url
    },
    {
      itag: 140,
      mimeType: 'audio/mp4; codecs="mp4a.40.2"',
      bitrate: 129_000,
      width: null,
      height: null,
      fps: null,
      contentLength: audio.filesize ?? audio.filesize_approx ?? null,
      url: audio.url
    }
  ]
}

const body = Buffer.from(JSON.stringify(message))
const frame = Buffer.allocUnsafe(4 + body.length)
frame.writeUInt32LE(body.length, 0)
body.copy(frame, 4)

const host = spawn(
  join(process.cwd(), 'dist', 'win-unpacked', 'resources', 'draco-host.exe'),
  [],
  { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true }
)
let output = Buffer.alloc(0)
const reply = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    host.kill()
    reject(new Error('Native handoff timed out'))
  }, 15_000)
  host.once('error', reject)
  host.stdout.on('data', (chunk) => {
    output = Buffer.concat([output, chunk])
    if (output.length < 4) return
    const length = output.readUInt32LE(0)
    if (output.length < 4 + length) return
    clearTimeout(timer)
    resolve(JSON.parse(output.subarray(4, 4 + length).toString()))
  })
  host.stdin.end(frame)
})

console.log(JSON.stringify({ ok: reply.ok, requestId: reply.requestId }))
