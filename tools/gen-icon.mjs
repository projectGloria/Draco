#!/usr/bin/env node
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/*
 * Draws resources/icon.ico from the same mark the splash and title bar use.
 *
 * Written by hand rather than pulled from an image library so the repo needs no
 * extra dependency for a single asset, and so the icon can be regenerated after
 * a change to the accent colours instead of drifting out of sync with them.
 *
 * Run with: npm run icon
 */

const SIZES = [16, 24, 32, 48, 64, 128, 256]

/* The mark, in a 24x24 space - identical to BrandMark in the renderer. */
const STROKES = [
  [12, 2.4, 12, 13],
  [12, 15.6, 6.4, 9.4],
  [12, 15.6, 17.6, 9.4],
  [4.2, 18.8, 19.8, 18.8]
]

const STROKE_WIDTH = 2.1
const BG = [0x12, 0x15, 0x1f]
const FROM = [0x38, 0xbd, 0xf8]
const TO = [0x63, 0x66, 0xf1]

/** Shortest distance from a point to a line segment. */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const lengthSq = dx * dx + dy * dy
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq))
  const cx = ax + t * dx
  const cy = ay + t * dy
  return Math.hypot(px - cx, py - cy)
}

/**
 * Coverage of a rounded square, as a signed distance turned into an alpha.
 * Sampling 3x3 per pixel is cheap at these sizes and is what keeps the
 * diagonals from looking like staircases at 16px.
 */
function roundedSquareDistance(x, y, size, radius) {
  const half = size / 2
  const dx = Math.abs(x - half) - (half - radius)
  const dy = Math.abs(y - half) - (half - radius)
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  return outside + Math.min(Math.max(dx, dy), 0) - radius
}

function render(size) {
  const scale = size / 24
  const halfStroke = (STROKE_WIDTH * scale) / 2
  const radius = size * 0.22
  const pixels = Buffer.alloc(size * size * 4)
  const samples = 3
  const step = 1 / (samples + 1)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgCoverage = 0
      let markCoverage = 0

      for (let sy = 1; sy <= samples; sy++) {
        for (let sx = 1; sx <= samples; sx++) {
          const px = x + sx * step
          const py = y + sy * step

          if (roundedSquareDistance(px, py, size, radius) <= 0) bgCoverage++

          let nearest = Infinity
          for (const [ax, ay, bx, by] of STROKES) {
            nearest = Math.min(
              nearest,
              distanceToSegment(px, py, ax * scale, ay * scale, bx * scale, by * scale)
            )
          }
          if (nearest <= halfStroke) markCoverage++
        }
      }

      const total = samples * samples
      const bgAlpha = bgCoverage / total
      const markAlpha = markCoverage / total

      // The gradient runs corner to corner, the same 135° as --grad in the CSS.
      const t = Math.min(1, Math.max(0, (x + y) / (2 * size)))
      const mark = [
        Math.round(FROM[0] + (TO[0] - FROM[0]) * t),
        Math.round(FROM[1] + (TO[1] - FROM[1]) * t),
        Math.round(FROM[2] + (TO[2] - FROM[2]) * t)
      ]

      const alpha = Math.max(bgAlpha, markAlpha)
      const offset = (y * size + x) * 4

      if (alpha === 0) continue

      // Mark over background, then the whole tile against transparency.
      const blend = markAlpha
      pixels[offset] = Math.round(BG[0] * (1 - blend) + mark[0] * blend)
      pixels[offset + 1] = Math.round(BG[1] * (1 - blend) + mark[1] * blend)
      pixels[offset + 2] = Math.round(BG[2] * (1 - blend) + mark[2] * blend)
      pixels[offset + 3] = Math.round(alpha * 255)
    }
  }

  return pixels
}

/* ------------------------------------------------------------------ */
/* PNG                                                                 */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function toPng(pixels, size) {
  // One filter byte per scanline; filter 0 (none) keeps this simple and the
  // images are tiny either way.
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // truecolour with alpha
  header[10] = 0
  header[11] = 0
  header[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* ------------------------------------------------------------------ */
/* ICO                                                                 */
/* ------------------------------------------------------------------ */

function toIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // 1 = icon
  header.writeUInt16LE(images.length, 4)

  const directory = Buffer.alloc(16 * images.length)
  let offset = header.length + directory.length

  images.forEach((image, index) => {
    const entry = index * 16
    // 256 is written as 0; the field is a single byte.
    directory[entry] = image.size >= 256 ? 0 : image.size
    directory[entry + 1] = image.size >= 256 ? 0 : image.size
    directory[entry + 2] = 0 // palette
    directory[entry + 3] = 0
    directory.writeUInt16LE(1, entry + 4) // colour planes
    directory.writeUInt16LE(32, entry + 6) // bits per pixel
    directory.writeUInt32LE(image.data.length, entry + 8)
    directory.writeUInt32LE(offset, entry + 12)
    offset += image.data.length
  })

  return Buffer.concat([header, directory, ...images.map((i) => i.data)])
}

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'icon.ico')
mkdirSync(dirname(out), { recursive: true })

const images = SIZES.map((size) => ({ size, data: toPng(render(size), size) }))
writeFileSync(out, toIco(images))

console.log(`Wrote ${out} (${SIZES.join(', ')} px)`)
