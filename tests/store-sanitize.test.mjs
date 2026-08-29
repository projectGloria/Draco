import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeCategories, sanitizeMedia, sanitizeQueues, sanitizeSettings, sanitizeTasks } from '../src/main/store-sanitize.ts'

function defaults() {
  return {
    downloadDir: 'C:/Downloads', maxConcurrentTasks: 3, maxConnectionsPerTask: 8,
    minSplitSize: 1024 * 1024, speedLimit: null, retryLimit: 5, timeoutMs: 30000,
    defaultCategoryId: null, confirmDelete: true, closeToTray: true, startMinimized: false,
    takeoverEnabled: true, confirmHandoff: true, takeoverMinSize: 1024 * 1024,
    takeoverExtensions: [], takeoverExcludeHosts: [], watchClipboard: false, accent: '#38bdf8',
    columns: [{id:'name',width:320,visible:true}], sortColumn:'added', sortDirection:'desc', sidebarSelection:'all'
  }
}

test('persistence sanitizers survive hostile and malformed records', () => {
  const settings = sanitizeSettings({ downloadDir: 42, maxConcurrentTasks: 999, accent: 'red', sortColumn: 'evil' }, defaults(), () => defaults().columns)
  assert.equal(settings.downloadDir, 'C:/Downloads')
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
