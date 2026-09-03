import test from 'node:test'
import assert from 'node:assert/strict'
import {
  compareToolVersions,
  parseFfmpegVersion,
  parseSha256,
  parseYtDlpVersion
} from '../src/main/tools-version.ts'

test('ffmpeg version is read from its own banner, not from what it was built with', () => {
  const banner = [
    'ffmpeg version 7.1-essentials_build-www.gyan.dev Copyright (c) 2000-2024 the FFmpeg developers',
    'built with gcc 13.2.0 (Rev5, Built by MSYS2 project)',
    'libavutil      59. 39.100 / 59. 39.100'
  ].join('\n')
  assert.equal(parseFfmpegVersion(banner), '7.1')

  // The release channel publishes the number on its own.
  assert.equal(parseFfmpegVersion('7.1\n'), '7.1')

  // A git snapshot has no comparable version. Reporting gcc's, which is the
  // next dotted number in the banner, would offer a downgrade every startup.
  assert.equal(
    parseFfmpegVersion('ffmpeg version N-113452-g1a2b3c4\nbuilt with gcc 13.2.0'),
    null
  )
})

test('yt-dlp versions are dated releases', () => {
  assert.equal(parseYtDlpVersion('2025.08.11\n'), '2025.08.11')
  assert.equal(parseYtDlpVersion('2025.08.11.232815'), '2025.08.11.232815')
  assert.equal(parseYtDlpVersion('nightly'), null)
})

test('an unreadable version is never treated as out of date', () => {
  assert.equal(compareToolVersions('2025.08.11', '2025.09.01'), -1)
  assert.equal(compareToolVersions('2025.09.01', '2025.08.11'), 1)
  assert.equal(compareToolVersions('7.1', '7.1'), 0)
  // 7.10 is newer than 7.9; a string comparison would say the opposite.
  assert.equal(compareToolVersions('7.9', '7.10'), -1)
  // Padding does not make one side newer.
  assert.equal(compareToolVersions('7.1', '7.1.0'), 0)

  for (const pair of [[null, '7.1'], ['7.1', null], ['N-113452', '7.1'], ['', '7.1']]) {
    assert.equal(compareToolVersions(pair[0], pair[1]), null, JSON.stringify(pair))
  }
})

test('a published digest is picked out of a sums file', () => {
  const sums = [
    '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08  yt-dlp',
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  yt-dlp.exe'
  ].join('\n')
  const line = sums.split('\n').find((entry) => /\syt-dlp\.exe\s*$/i.test(entry.trim()))
  assert.equal(parseSha256(line), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(parseSha256('no digest here'), null)
})
