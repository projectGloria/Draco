import { strictEqual } from 'node:assert/strict'
import { test } from 'node:test'
import { compareToolVersions, parseFfmpegVersion } from '../src/main/tools-version.ts'

test('reports the bundled FFmpeg snapshot without treating it as a numbered release', () => {
  const build = 'N-126636-g1ef0d9d701-20260918'
  strictEqual(parseFfmpegVersion(`ffmpeg version ${build} Copyright (c) 2000-2026\nbuilt with gcc 15.2.0`), build)
  strictEqual(compareToolVersions(build, '9.0.2'), null)
  strictEqual(parseFfmpegVersion('ffmpeg version 7.1.1-full_build-www.gyan.dev Copyright'), '7.1.1')
  strictEqual(parseFfmpegVersion('9.0.2'), '9.0.2')
  strictEqual(parseFfmpegVersion('unexpected output from gcc 15.2.0'), null)
})
