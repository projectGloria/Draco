import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import type { SiteGrabOptions, SiteGrabProject, SiteGrabResult } from '../../shared/types.ts'
import { createTask, validateUrl } from '../engine/create.ts'
import type { DownloadManager } from '../engine/manager.ts'
import { sanitizeFilename } from '../engine/naming.ts'
import { crawlSite } from './crawler.ts'

const SCHEDULE_TICK_MS = 5 * 60_000

export interface SiteProjectDeps {
  manager: DownloadManager
  downloadDir(): string
  load(): Promise<SiteGrabProject[]>
  save(projects: SiteGrabProject[]): Promise<void>
}

export class SiteProjectManager {
  private projects: SiteGrabProject[] = []
  private running = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private deps: SiteProjectDeps

  constructor(deps: SiteProjectDeps) {
    this.deps = deps
  }

  async start(): Promise<void> {
    this.projects = await this.deps.load()
    if (!this.timer) {
      this.timer = setInterval(() => void this.runDue(), SCHEDULE_TICK_MS)
      this.timer.unref?.()
    }
    void this.runDue()
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  list(): SiteGrabProject[] {
    return this.projects.map((project) => ({ ...project, options: { ...project.options }, knownUrls: [...project.knownUrls] }))
  }

  async create(options: SiteGrabOptions): Promise<SiteGrabResult> {
    const startUrl = validateUrl(options.startUrl)
    const parsed = new URL(startUrl)
    const project: SiteGrabProject = {
      id: randomUUID(),
      name: parsed.hostname,
      options: normalizeOptions({ ...options, startUrl }),
      rootDir: join(this.deps.downloadDir(), sanitizeFilename(parsed.hostname, 'site')),
      knownUrls: [],
      createdAt: Date.now(),
      lastRunAt: null,
      lastError: null
    }
    this.projects.push(project)
    await this.persist()
    return this.run(project.id)
  }

  async run(id: string): Promise<SiteGrabResult> {
    const project = this.projects.find((candidate) => candidate.id === id)
    if (!project) throw new Error('That site project no longer exists')
    if (this.running.has(id)) throw new Error('That site project is already running')
    this.running.add(id)

    try {
      const resources = await crawlSite(project.options)
      const known = new Set(project.knownUrls)
      const fresh = resources.filter((resource) => !known.has(resource.url))
      const ids: string[] = []
      // Pages were already fetched for discovery. Write those bytes directly
      // after the crawler rewrites known links to local relative paths; fetching
      // them again as ordinary tasks would waste bandwidth and leave an online-
      // only copy whose links still point back at the site.
      for (const resource of resources.filter((candidate) => candidate.kind === 'page')) {
        const target = join(project.rootDir, resource.relativePath)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, resource.content ?? '', 'utf8')
      }

      for (const resource of fresh.filter((candidate) => candidate.kind === 'asset')) {
        const task = createTask({
          url: resource.url,
          dir: join(project.rootDir, dirname(resource.relativePath)),
          filename: basename(resource.relativePath),
          description: `Site project: ${project.name}`
        })
        this.deps.manager.add(task, false)
        ids.push(task.id)
      }
      for (const resource of fresh) known.add(resource.url)
      project.knownUrls = [...known].slice(-10_000)
      project.lastRunAt = Date.now()
      project.lastError = null
      await this.persist()
      if (project.options.autoStart && ids.length > 0) this.deps.manager.start(ids)
      return { discovered: resources.length, added: fresh.length, rootDir: project.rootDir, projectId: project.id }
    } catch (error) {
      project.lastRunAt = Date.now()
      project.lastError = error instanceof Error ? error.message : String(error)
      await this.persist()
      throw error
    } finally {
      this.running.delete(id)
    }
  }

  async remove(id: string): Promise<void> {
    if (this.running.has(id)) throw new Error('Wait for the site project to finish crawling')
    this.projects = this.projects.filter((project) => project.id !== id)
    await this.persist()
  }

  private async runDue(): Promise<void> {
    const now = Date.now()
    for (const project of this.projects) {
      const hours = project.options.scheduleHours
      if (!hours || this.running.has(project.id)) continue
      if (project.lastRunAt !== null && now - project.lastRunAt < hours * 3_600_000) continue
      void this.run(project.id).catch(() => {})
    }
  }

  private persist(): Promise<void> {
    return this.deps.save(this.projects)
  }
}

function normalizeOptions(options: SiteGrabOptions): SiteGrabOptions {
  return {
    startUrl: options.startUrl,
    maxDepth: Math.min(5, Math.max(0, Math.round(Number(options.maxDepth)) || 0)),
    maxPages: Math.min(1000, Math.max(1, Math.round(Number(options.maxPages)) || 100)),
    includeAssets: options.includeAssets !== false,
    stayOnHost: options.stayOnHost !== false,
    respectRobots: options.respectRobots !== false,
    autoStart: options.autoStart === true,
    scheduleHours: typeof options.scheduleHours === 'number' && Number.isFinite(options.scheduleHours) && options.scheduleHours >= 1
      ? Math.min(24 * 30, Math.round(options.scheduleHours))
      : null
  }
}
