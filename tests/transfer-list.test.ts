import { strictEqual } from 'node:assert/strict'
import { it } from 'node:test'
import { createTask } from '../src/main/engine/create.ts'
import { buildTransferFile, buildUrlList, parseTransferFile } from '../src/main/transfer-list.ts'

it('imports the original file URL and description when its source is an article', () => {
  const task = createTask({ url: 'https://cdn.example.com/file.mp4', sourceUrl: 'https://example.com/article',
    dir: 'C:\\Downloads', filename: 'file.mp4', description: 'Saved lecture' })
  const [restored] = parseTransferFile(JSON.stringify(buildTransferFile([task])))
  strictEqual(restored.url, task.url)
  strictEqual(restored.description, task.description)
  strictEqual(buildUrlList([task]), task.url + '\r\n')
})

it('exports stable YouTube pages instead of temporary signed CDN URLs', () => {
  const task = createTask({ url: 'https://cdn.example.com/video.mp4?signature=temporary', dir: 'C:\\Downloads',
    youtube: { pageUrl: 'https://www.youtube.com/watch?v=abcdef12345', videoFormatId: '137' } })
  strictEqual(buildUrlList([task]), task.youtube!.pageUrl + '\r\n')
  strictEqual(parseTransferFile(JSON.stringify(buildTransferFile([task])))[0].url, task.youtube!.pageUrl)
})
