import { deepStrictEqual, rejects, strictEqual } from 'node:assert/strict'
import { test } from 'node:test'
import { buildAudioVariants, formatsFromYtDlp, selectDirectYtFormat } from '../src/main/youtube-ladder.ts'
import { loadYouTubeSessions, type YtDlpInfo } from '../src/main/youtube-sessions.ts'

const publicInfo: YtDlpInfo = { formats: [
  { format_id: '401', url: 'https://media.test/public-4k', protocol: 'https', height: 2160, vcodec: 'av01', acodec: 'none' },
  { format_id: '251', url: 'https://media.test/public-audio', protocol: 'https', vcodec: 'none', acodec: 'opus', abr: 139, ext: 'webm' }
] }

test('checks the account even with public 4K and exposes its Premium audio', async () => {
  let checked = false
  const info = await loadYouTubeSessions(async () => publicInfo, async () => {
    checked = true
    return { formats: [
      { format_id: '774', url: 'https://media.test/premium', protocol: 'https', vcodec: 'none', acodec: 'opus', abr: 256, ext: 'webm' },
      { format_id: '401', url: 'https://media.test/manifest', protocol: 'm3u8_native', height: 2160, vcodec: 'av01', acodec: 'none' }
    ] }
  })
  strictEqual(checked, true)
  strictEqual(selectDirectYtFormat(info.formats!, '401')?.url, 'https://media.test/public-4k')
  strictEqual(selectDirectYtFormat(info.formats!, '774')?.url, 'https://media.test/premium')
  const audio = buildAudioVariants(formatsFromYtDlp(info.formats!))
  strictEqual(audio[0].label, 'Music · 256 kbps')
  strictEqual(audio[0].youtube?.videoFormatId, '774')
  strictEqual(publicInfo.formats?.length, 2)
})

test('prefers the account URL for a duplicate downloadable format', async () => {
  const info = await loadYouTubeSessions(async () => publicInfo, async () => ({
    formats: [{ ...publicInfo.formats![1], url: 'https://media.test/account-audio' }]
  }))
  strictEqual(selectDirectYtFormat(info.formats!, '251')?.url, 'https://media.test/account-audio')
  strictEqual(info.formats?.length, 2)
})

test('preserves public formats on cookie failure and account formats for private videos', async () => {
  let reported: unknown
  const failure = new Error('Cookie database is locked')
  strictEqual(await loadYouTubeSessions(async () => publicInfo, async () => { throw failure },
    (error) => { reported = error }), publicInfo)
  strictEqual(reported, failure)
  strictEqual(await loadYouTubeSessions(async () => { throw new Error('Private video') },
    async () => publicInfo), publicInfo)
  await rejects(loadYouTubeSessions(async () => { throw new Error('Public failure') },
    async () => { throw failure }), /Cookie database is locked/)
})

test('runs only the public lookup when no session is provided', async () => {
  deepStrictEqual(await loadYouTubeSessions(async () => publicInfo), publicInfo)
})
