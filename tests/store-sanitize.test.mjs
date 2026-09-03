import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeCategories, sanitizeMedia, sanitizeQueues, sanitizeSettings, sanitizeTasks } from '../src/main/store-sanitize.ts'

function defaults() {
  return {
    downloadDir: 'C:/Downloads', maxConcurrentTasks: 3, maxConnectionsPerTask: 8,
    minSplitSize: 1024 * 1024, speedLimit: null, retryLimit: 5, timeoutMs: 30000,
    proxyUrl: null, hostConnectionLimits: [], quotaBytes: null, quotaWindowMinutes: 60,
    defaultCategoryId: null, confirmDelete: true, closeToTray: true, startMinimized: false,
    takeoverEnabled: true, confirmHandoff: true, takeoverMinSize: 1024 * 1024,
    takeoverExtensions: [], takeoverExcludeHosts: [], watchClipboard: false, accent: '#38bdf8',
    columns: [{id:'name',width:320,visible:true}], sortColumn:'added', sortDirection:'desc', sidebarSelection:'all'
  }
}

test('persistence sanitizers survive hostile and malformed records', () => {
  const settings = sanitizeSettings({ downloadDir: 42, maxConcurrentTasks: 999, accent: 'red', sortColumn: 'evil' }, defaults(), () => defaults().columns)
  assert.equal(settings.downloadDir, 'C:\\Downloads')
  assert.equal(settings.maxConcurrentTasks, 20)
  assert.equal(settings.accent, '#38bdf8')
  assert.equal(settings.sortColumn, 'added')

  const categories = sanitizeCategories([null, 5, { id: 'x', name: 'Video', folder: 'CON', extensions: ['.MP4', 7] }], () => [{ id: 'fallback', name:'Fallback', folder:'Fallback', builtin:true, extensions:[] }])
  assert.equal(categories.length, 1)
  assert.equal(categories[0].folder, 'CON_')
  assert.deepEqual(categories[0].extensions, ['mp4'])

  const tasks = sanitizeTasks([{ id: 't', url: 'https://example.test/a', status: 'not-real', received: 500, size: 10, filename: '..\\\\secret.bin', headers: null }], 'C:/Downloads')
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].status, 'paused')
  assert.equal(tasks[0].received, 10)
  assert.ok(!tasks[0].filename.includes('\\'))
  assert.deepEqual(tasks[0].headers, {})

  const queues = sanitizeQueues([null, { id: 'q', name: null, taskIds: ['a', 3], mode: 'bad', startTime: '9:00', stopTime: '23:59', days: [0, 7, 1], maxConcurrent: 99, onComplete: 'bad', running: true }])
  assert.equal(queues[0].mode, 'manual')
  assert.deepEqual(queues[0].taskIds, ['a'])
  assert.deepEqual(queues[0].days, [0,1])
  assert.equal(queues[0].maxConcurrent, 20)
  assert.equal(queues[0].running, false)
  assert.equal(queues[0].oneTimeCompleted, false)

  const media = sanitizeMedia([null, { id:'m', pageUrl:'https://example.test', mediaUrl:'javascript:bad', variants: [{ url:'https://cdn.test/x', height:'1080' }] }])
  assert.deepEqual(media, [])
})

test('network settings reject unsafe proxies and normalize per-host limits', () => {
  const settings = sanitizeSettings({
    proxyUrl: 'http://proxy.example:8080',
    hostConnectionLimits: [
      { host: '.Example.COM.', connections: 3 },
      { host: 'example.com', connections: 5 },
      { host: 'bad host', connections: 9 }
    ],
    quotaBytes: 500_000_000,
    quotaWindowMinutes: 120
  }, defaults(), () => defaults().columns)

  assert.equal(settings.proxyUrl, 'http://proxy.example:8080/')
  assert.deepEqual(settings.hostConnectionLimits, [{ host: 'example.com', connections: 5 }])
  assert.equal(settings.quotaBytes, 500_000_000)
  assert.equal(settings.quotaWindowMinutes, 120)

  const unsafe = sanitizeSettings({ proxyUrl: 'file:///etc/passwd' }, defaults(), () => defaults().columns)
  assert.equal(unsafe.proxyUrl, null)
})

test('a YouTube quality read from the page survives a restart without a URL', () => {
  const [candidate] = sanitizeMedia([
    {
      id: 'm1',
      pageUrl: 'https://www.youtube.com/watch?v=abc',
      mediaUrl: 'https://www.youtube.com/watch?v=abc',
      type: 'file',
      variants: [
        // Page-derived: named by itag, its URL resolved when the download starts.
        { url: '', label: '1080p', height: 1080, youtube: { videoFormatId: '248', audioFormatId: '140' } },
        // No URL and no format id: nothing could ever be fetched from this.
        { url: '', label: 'junk', height: 720 },
        { url: 'not-a-url', label: 'junk2', youtube: { videoFormatId: '9' } }
      ]
    }
  ])

  assert.equal(candidate.variants.length, 1)
  assert.equal(candidate.variants[0].label, '1080p')
  assert.equal(candidate.variants[0].url, '')
  assert.equal(candidate.variants[0].youtube.videoFormatId, '248')
})

test('DASH task kind survives persistence sanitization', () => {
  const [task] = sanitizeTasks([{
    id: 'dash-task',
    url: 'https://cdn.example.test/manifest.mpd',
    filename: 'video.mp4',
    kind: 'dash',
    status: 'paused',
    subtitles: [
      { url: 'https://cdn.example.test/en.vtt', label: 'English', language: 'en', format: 'vtt' },
      { url: 'javascript:bad', label: 'Bad', language: null, format: 'srt' }
    ]
  }], 'C:/Downloads')
  assert.equal(task.kind, 'dash')
  assert.deepEqual(task.subtitles, [{
    url: 'https://cdn.example.test/en.vtt', label: 'English', language: 'en', format: 'vtt'
  }])
})

test('a restored quality still knows the container it will be saved as', () => {
  const [candidate] = sanitizeMedia([
    {
      id: 'm2',
      pageUrl: 'https://www.youtube.com/watch?v=abc',
      mediaUrl: 'https://www.youtube.com/watch?v=abc',
      type: 'file',
      variants: [
        // A page-derived variant has no URL to infer a container from, so the
        // stored one is the only thing standing between the label and a lie.
        { url: '', label: '4K', container: 'MKV', youtube: { videoFormatId: '313' } },
        { url: 'https://cdn.test/a.mp4', label: '720p', container: 'exe; rm -rf' },
        { url: 'https://cdn.test/b.mp4', label: '480p' }
      ]
    }
  ])

  assert.equal(candidate.variants[0].container, 'mkv')
  assert.equal(candidate.variants[1].container, null)
  assert.equal(candidate.variants[2].container, null)
})

test('the adaptive ceiling is off by default and only ever bounded, not second-guessed', () => {
  const base = defaults()
  const columns = () => base.columns

  // Absent, zero and nonsense all mean the same thing: stop at the configured
  // connection count.
  assert.equal(sanitizeSettings({}, base, columns).adaptiveConnectionCeiling, null)
  assert.equal(sanitizeSettings({ adaptiveConnectionCeiling: 0 }, base, columns).adaptiveConnectionCeiling, null)
  assert.equal(sanitizeSettings({ adaptiveConnectionCeiling: -4 }, base, columns).adaptiveConnectionCeiling, null)
  assert.equal(sanitizeSettings({ adaptiveConnectionCeiling: 'lots' }, base, columns).adaptiveConnectionCeiling, null)
  assert.equal(sanitizeSettings({ adaptiveConnectionCeiling: Infinity }, base, columns).adaptiveConnectionCeiling, null)

  // A deliberate opt-in is kept, including well past maxConnectionsPerTask -
  // exceeding it is the entire point of the setting.
  assert.equal(sanitizeSettings({ adaptiveConnectionCeiling: 32 }, base, columns).adaptiveConnectionCeiling, 32)
  assert.equal(sanitizeSettings({ adaptiveConnectionCeiling: 12.7 }, base, columns).adaptiveConnectionCeiling, 12)
  assert.equal(sanitizeSettings({ adaptiveConnectionCeiling: 5000 }, base, columns).adaptiveConnectionCeiling, 64)
})

test('the connection ceiling is generous because the ramp decides what is opened', () => {
  const base = defaults()
  const columns = () => base.columns

  assert.equal(sanitizeSettings({ maxConnectionsPerTask: 32 }, base, columns).maxConnectionsPerTask, 32)
  assert.equal(sanitizeSettings({ maxConnectionsPerTask: 64 }, base, columns).maxConnectionsPerTask, 64)
  // Still bounded - a number this large is a typo, not an intention.
  assert.equal(sanitizeSettings({ maxConnectionsPerTask: 5000 }, base, columns).maxConnectionsPerTask, 64)
  assert.equal(sanitizeSettings({ maxConnectionsPerTask: 0 }, base, columns).maxConnectionsPerTask, 1)
})
