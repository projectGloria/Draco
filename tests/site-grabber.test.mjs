import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crawlSite, extractLinks, resourceFor } from '../src/main/site-grabber/crawler.ts'
import { closeDispatchers } from '../src/main/engine/http.ts'
import { SiteProjectManager } from '../src/main/site-grabber/projects.ts'

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

test('site link extraction resolves pages and assets without executable schemes', () => {
  const links = extractLinks(`
    <a href="guide">Guide</a><img src="/logo.png"><script src="javascript:bad"></script>
    <style>.hero{background:url('/hero.webp')}</style>
  `, new URL('https://example.test/docs/'))
  assert.deepEqual(links.map((entry) => [entry.url.toString(), entry.kind]), [
    ['https://example.test/docs/guide', 'page'],
    ['https://example.test/logo.png', 'asset'],
    ['https://example.test/hero.webp', 'asset']
  ])
})

test('site resource paths are Windows-safe and query variants do not collide', () => {
  const first = resourceFor(new URL('https://example.test/docs/?lang=en'), 'page')
  const second = resourceFor(new URL('https://example.test/docs/?lang=tr'), 'page')
  assert.match(first.relativePath, /^docs\/index-[a-f0-9]{8}\.html$/)
  assert.notEqual(first.relativePath, second.relativePath)
  assert.equal(resourceFor(new URL('https://example.test/a%3Ab.png'), 'asset').relativePath, 'a_b.png')
})

test('site crawler is depth-bounded, captures assets, and respects robots.txt', async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/robots.txt') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('User-agent: *\nDisallow: /private')
    } else if (request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<a href="/about">About</a><a href="/private">Private</a><img src="/logo.png">')
    } else if (request.url === '/about') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<a href="/too-deep">Deep</a>')
    } else if (request.url === '/logo.png') {
      response.writeHead(200, { 'content-type': 'image/png' })
      response.end('png')
    } else {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('page')
    }
  })
  const port = await listen(server)
  try {
    const resources = await crawlSite({
      startUrl: `http://127.0.0.1:${port}/`, maxDepth: 1, maxPages: 10,
      includeAssets: true, stayOnHost: true, respectRobots: true
    })
    const urls = resources.map((entry) => new URL(entry.url).pathname).sort()
    assert.deepEqual(urls, ['/', '/about', '/logo.png'])
  } finally {
    await closeDispatchers()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('saved site projects only enqueue newly discovered resources on synchronization', async () => {
  const output = await mkdtemp(join(tmpdir(), 'draco-site-project-'))
  const server = http.createServer((request, response) => {
    if (request.url === '/robots.txt') {
      response.writeHead(404); response.end(); return
    }
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<img src="/logo.png">')
  })
  const port = await listen(server)
  const tasks = []
  let persisted = []
  const projects = new SiteProjectManager({
    manager: {
      add: (task) => { tasks.push(task) },
      start: () => {}
    },
    downloadDir: () => output,
    load: async () => persisted,
    save: async (next) => { persisted = structuredClone(next) }
  })

  try {
    await projects.start()
    const first = await projects.create({
      startUrl: `http://127.0.0.1:${port}/`, maxDepth: 0, maxPages: 5,
      includeAssets: true, stayOnHost: true, respectRobots: false, autoStart: false,
      scheduleHours: null
    })
    assert.equal(first.added, 2)
    const second = await projects.run(first.projectId)
    assert.equal(second.added, 0)
    assert.equal(tasks.length, 1)
    assert.equal(persisted[0].knownUrls.length, 2)
    assert.match(await readFile(join(first.rootDir, 'index.html'), 'utf8'), /src="\.\/logo\.png"/)
  } finally {
    projects.dispose()
    await closeDispatchers()
    await new Promise((resolve) => server.close(resolve))
    await rm(output, { recursive: true, force: true })
  }
})
