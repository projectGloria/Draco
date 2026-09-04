import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DownloadManager } from '../src/main/engine/manager.ts'
import { resolveYouTube, refreshYouTubeFormat } from '../src/main/youtube.ts'
import { DashRunner } from '../src/main/hls/dash.ts'
import type { DownloadTask } from '../src/shared/types.ts'
const dir = process.cwd()

const urls = [
  'https://www.youtube.com/watch?v=BaW_jenozKc',
  'https://www.youtube.com/watch?v=EngW7tLk6R8',
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://www.youtube.com/watch?v=jNQXAC9IVRw',
  'https://www.youtube.com/watch?v=kJQP7kiw5Fk'
]

async function run() {
  const manager = new DownloadManager({
    getSettings: () => ({
      maxConcurrentTasks: 3,
      maxConnectionsPerTask: 8,
      minSplitSize: 1024 * 1024,
      retryLimit: 5,
      timeoutMs: 30_000,
      speedLimit: null
    }),
    onTasks: (tasks) => {
      let done = 0, err = 0
      for (const t of tasks) {
        if (t.status === 'done') done++
        if (t.status === 'error') err++
      }
      console.log(`Progress: ${done} done, ${err} errors out of ${tasks.length} tasks`)
      if (done + err === urls.length) {
        console.log('All finished!')
        process.exit(err > 0 ? 1 : 0)
      }
    },
    onProgress: (updates) => {
      // console.log(updates.map(u => `${u.status} ${Math.round((u.received / (u.size||1))*100)}%`))
    },
    createDashRunner: (task, context) => new DashRunner(task, context),
    refreshYouTube: async (task, force) => {
      const formatId = task.youtube!.videoFormatId
      return refreshYouTubeFormat(task.youtube!.pageUrl, task.headers, formatId!, force)
    }
  })

  for (const url of urls) {
    console.log(`Resolving ${url}...`)
    try {
      const res = await resolveYouTube(url, undefined)
      // Pick best variant
      if (!res.variants || res.variants.length === 0) {
        console.error(`No variants found for ${url}`)
        continue
      }
      const best = res.variants[0]
      const task: DownloadTask = {
        id: randomUUID(),
        url: best.url,
        finalUrl: best.url,
        audioUrl: best.audioUrl,
        filename: `${res.title.replace(/[\\/:*?"<>|]/g, '')}.${best.container}`,
        dir,
        createdAt: Date.now(),
        startedAt: null,
        completedAt: null,
        status: 'queued',
        size: best.estimatedSize,
        received: 0,
        speed: 0,
        eta: null,
        segments: [],
        resumable: false,
        etag: null,
        lastModified: null,
        mimeType: null,
        filenameLocked: false,
        error: null,
        detail: null,
        categoryId: null,
        queueId: null,
        connections: 0,
        youtube: best.youtube ? {
          pageUrl: url,
          videoFormatId: best.youtube.videoFormatId,
          audioFormatId: best.youtube.audioFormatId ?? null
        } : undefined
      }
      manager.add(task)
    } catch (err) {
      console.error(`Failed to resolve ${url}:`, err)
      continue
    }
  }
}

run().catch(console.error)
