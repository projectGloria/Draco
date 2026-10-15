import { strictEqual } from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { it } from 'node:test'

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8')

it('reports a declined or invalid popup URL instead of clearing it as sent', async () => {
  const fragment = source.slice(source.indexOf('async function sendUrls('), source.indexOf('chrome.contextMenus.onClicked.addListener('))
  let reply: any = { ok: true, taken: false }
  const api = runInNewContext(fragment + '\n({ sendUrls })', {
    callHost: async () => reply, cookieHeaderFor: async () => '', notify() {}, navigator: { userAgent: 'test' }, MAX_BATCH_ITEMS: 500
  })
  strictEqual((await api.sendUrls(['invalid'])).ok, false)
  strictEqual((await api.sendUrls(['https://example.com/file.bin'])).ok, false)
  reply = { ok: true, pending: true, handoffId: 'pending' }
  strictEqual((await api.sendUrls(['https://example.com/file.bin'])).ok, true)
  reply = { ok: true, queued: 0 }
  strictEqual((await api.sendUrls(['https://example.com/one', 'https://example.com/two'])).ok, false)
})

it('preserves complete captured cookie headers within the bridge limit', () => {
  const fragment = source.slice(source.indexOf('const BLOCKED_CAPTURED_HEADERS'), source.indexOf('async function remember('))
  const { capturedHeaders } = runInNewContext(fragment + '\n({ capturedHeaders })')
  const cookie = 'session=' + 'x'.repeat(20_000)
  strictEqual(capturedHeaders([{ name: 'Cookie', value: cookie }]).cookie, cookie)
})

it('recognizes YouTube privacy-enhanced embeds for the native extractor', () => {
  const fragment = source.slice(source.indexOf('function isYouTubePage('), source.indexOf('const youtubePrimeRequests'))
  const { isYouTubePage, youtubeVideoId } = runInNewContext(fragment + '\n({ isYouTubePage, youtubeVideoId })', { URL })
  const url = 'https://www.youtube-nocookie.com/embed/abcdef12345'
  strictEqual(isYouTubePage(url), true)
  strictEqual(youtubeVideoId(url), 'abcdef12345')
})
