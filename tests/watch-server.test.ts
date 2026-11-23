import { ok, strictEqual } from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { Segmenter } from '../src/main/engine/segmenter.ts'
import {
  contiguousWrittenBytesFromSegments,
  serveByteSourceResponse,
  type ByteSource
} from '../src/main/media/watch-server.ts'
import { isPlayableMediaTask, mimeTypeForMediaFilename } from '../src/shared/playable-media.ts'

describe('Watch while downloading (live streaming & demand prioritization)', () => {
  it('computes contiguous written bytes across adjacent segments', () => {
    const segmenter = Segmenter.restore(
      [
        { start: 0, end: 499, position: 500, active: false },
        { start: 500, end: 999, position: 750, active: true },
        { start: 1000, end: 1499, position: 1200, active: true }
      ],
      1500,
      100
    )

    strictEqual(segmenter.contiguousBytesAt(0), 750, 'merges completed first segment into active second segment')
    strictEqual(segmenter.contiguousBytesAt(600), 150, 'measures remaining written bytes inside second segment')
    strictEqual(segmenter.contiguousBytesAt(800), 0, 'unwritten gap returns 0')
    strictEqual(segmenter.contiguousBytesAt(1050), 150, 'measures written bytes in third segment')
  })

  it('splits directly at a prioritized reader offset inside an unwritten range', () => {
    const segmenter = new Segmenter(10_000, 500)
    segmenter.segments[0].active = true
    segmenter.segments[0].position = 1_000

    // Player seeks to byte 8,500 (e.g. reading MP4 moov atom near EOF)
    segmenter.prioritizeOffset(8_500)
    const prioritized = segmenter.split()

    ok(prioritized)
    strictEqual(prioritized.start, 8_500)
    strictEqual(prioritized.position, 8_500)
    strictEqual(prioritized.end, 9_999)
    strictEqual(segmenter.segments[0].end, 8_499)
  })

  it('streams partial byte ranges and waits seamlessly as missing bytes arrive', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'draco-watch-test-'))
    const filePath = join(workDir, 'video.mp4.dracodl')
    const totalPayload = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ')
    await writeFile(filePath, totalPayload)

    let writtenLimit = 10 // Only first 10 bytes ("0123456789") available initially
    const prioritizedOffsets: number[] = []

    const source: ByteSource = {
      async filePath() {
        return filePath
      },
      async totalSize() {
        return totalPayload.length
      },
      async availableBytesAt(offset, prioritize) {
        if (prioritize && offset >= writtenLimit) {
          prioritizedOffsets.push(offset)
        }
        return offset < writtenLimit ? writtenLimit - offset : 0
      },
      mimeType() {
        return 'video/mp4'
      }
    }

    // Advance download while the response stream is reading
    setTimeout(() => {
      writtenLimit = 25
    }, 150)
    setTimeout(() => {
      writtenLimit = totalPayload.length
    }, 300)

    try {
      const req = new Request('http://localhost/video', {
        headers: { Range: 'bytes=5-30' }
      })
      const res = await serveByteSourceResponse(source, req, () => true)
      strictEqual(res.status, 206)
      strictEqual(res.headers.get('Content-Range'), `bytes 5-30/${totalPayload.length}`)

      const body = Buffer.from(await res.arrayBuffer()).toString('utf8')
      strictEqual(body, '56789ABCDEFGHIJKLMNOPQRSTU')
      ok(prioritizedOffsets.includes(10), 'reader nudged segmenter when it reached the 10-byte frontier')
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('detects playable video and audio tasks accurately', () => {
    strictEqual(isPlayableMediaTask({ filename: 'movie.mp4' }), true)
    strictEqual(isPlayableMediaTask({ filename: 'clip.mkv' }), true)
    strictEqual(isPlayableMediaTask({ filename: 'archive.zip' }), false)
    strictEqual(isPlayableMediaTask({ filename: 'stream.bin', kind: 'hls' }), true)
    strictEqual(
      isPlayableMediaTask({
        filename: 'Torrent Folder',
        kind: 'torrent',
        torrentFiles: [{ path: 'Season 1/Episode 01.mp4' }]
      }),
      true
    )
    strictEqual(mimeTypeForMediaFilename('video.webm'), 'video/webm')
    strictEqual(
      contiguousWrittenBytesFromSegments([{ start: 0, end: 99, position: 45, active: true }], 100, 0),
      45
    )
  })
})
