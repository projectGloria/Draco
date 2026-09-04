import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import {
  embeddedMediaUrls,
  extractEmbeddedPageUrls,
  extractPageMedia,
  resolveHtmlPageMedia
} from '../src/main/page-media.ts'

test('HTML media detection prefers video over page artwork', () => {
  const result = extractPageMedia(`
    <title>Example player</title>
    <meta property="og:image" content="/poster.jpg">
    <video src="/watch/video-1080.mp4" width="1920" height="1080"></video>
  `, 'https://example.test/page')

  assert.equal(result.title, 'Example player')
  assert.equal(result.variants[0].url, 'https://example.test/watch/video-1080.mp4')
  assert.equal(result.variants[0].container, 'mp4')
  assert.equal(result.variants[1].url, 'https://example.test/poster.jpg')
})

test('responsive images select the largest declared source', () => {
  const result = extractPageMedia(`
    <title>Original photograph</title>
    <img src="small.jpg" srcset="small.jpg 640w, medium.jpg 1280w, original.jpg 4096w">
  `, 'https://example.test/gallery/item')

  assert.equal(result.variants[0].url, 'https://example.test/gallery/original.jpg')
  assert.equal(result.variants[0].label, 'Image · original.jpg')
  assert.equal(result.variants[0].container, 'jpg')
})

test('site-builder lazy attributes expose direct videos and original gallery images', () => {
  const result = extractPageMedia(`
    <div data-content-video-url-mp4="https://cdn.example.test/hero-1080.mp4"></div>
    <img src="https://thumb.example.test/empty/photo.jpg"
         data-original="https://cdn.example.test/original/photo.jpg"
         data-img-zoom-url="https://cdn.example.test/original/photo.jpg">
  `, 'https://example.test/')

  assert.deepEqual(result.variants.map((variant) => variant.url), [
    'https://cdn.example.test/hero-1080.mp4',
    'https://cdn.example.test/original/photo.jpg'
  ])
})

test('Fluid Player-style inline configuration exposes escaped MP4 sources', () => {
  const html = String.raw`
    <div id="fluid_video_wrapper_flvv"><video id="flvv"></video></div>
    <script>
      const options = { sources: [{ src: "https:\/\/cdn.example.test\/films\/feature.mp4?token=abc\u0026quality=best", type: "video/mp4" }] };
      fluidPlayer('flvv', options);
    </script>
  `
  assert.deepEqual(embeddedMediaUrls(html), [
    'https://cdn.example.test/films/feature.mp4?token=abc&quality=best'
  ])
  const result = extractPageMedia(html, 'https://example.test/watch')
  assert.equal(result.variants[0].url, 'https://cdn.example.test/films/feature.mp4?token=abc&quality=best')
})

test('generic player data attributes expose media without a source element', () => {
  const result = extractPageMedia(
    '<div id="fluid_video_wrapper_flvv" data-file="/media/movie.mp4"></div>',
    'https://example.test/watch'
  )
  assert.equal(result.variants[0].url, 'https://example.test/media/movie.mp4')
})

test('player iframe URLs are distinguished from advertising frames', () => {
  const urls = extractEmbeddedPageUrls(`
    <iframe width="300" height="250" src="https://ads.example.test/smartpop/123"></iframe>
    <iframe width="560" height="350" src="//player.example.test/video/abc"></iframe>
  `, 'https://example.test/watch')
  assert.deepEqual(urls, ['https://player.example.test/video/abc'])
})

test('page inspection follows an embedded player to its declared MP4', async (t) => {
  const videoSize = 2_113_993
  const server = http.createServer((request, response) => {
    if (request.url === '/watch') {
      const html = '<title>Outer title</title><iframe src="/video/player"></iframe>'
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(html)
      return
    }
    if (request.url === '/video/player') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<video><source src="/media/1080.mp4" type="video/mp4"></video>')
      return
    }
    response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': videoSize })
    response.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const address = server.address()
  const result = await resolveHtmlPageMedia(`http://127.0.0.1:${address.port}/watch`, undefined)

  assert.equal(result.title, 'Outer title')
  assert.match(result.variants[0].url, /\/media\/1080\.mp4$/)
  assert.equal(result.variants[0].estimatedSize, videoSize)
})

test('HTML media detection falls back to an Open Graph image', () => {
  const result = extractPageMedia(
    '<meta property="og:image" content="https://cdn.example.test/full.webp">',
    'https://example.test/article'
  )
  assert.equal(result.variants[0].url, 'https://cdn.example.test/full.webp')
})

test('page assets are preflighted so their sizes are shown before selection', async (t) => {
  const image = Buffer.alloc(12_345, 7)
  const server = http.createServer((request, response) => {
    if (request.url === '/page') {
      const html = '<title>Assets</title><img src="/original.jpg">'
      response.writeHead(200, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(html) })
      response.end(html)
      return
    }
    response.writeHead(200, {
      'content-type': 'image/jpeg',
      'content-length': image.length,
      'accept-ranges': 'bytes'
    })
    response.end(request.method === 'HEAD' ? undefined : image)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const address = server.address()
  const result = await resolveHtmlPageMedia(`http://127.0.0.1:${address.port}/page`, undefined)

  assert.equal(result.variants[0].estimatedSize, image.length)
  assert.equal(result.variants[0].container, 'jpg')
})

test('page preflight preserves the player URL instead of an expiring CDN redirect', async (t) => {
  const videoSize = 98_765
  const server = http.createServer((request, response) => {
    if (request.url === '/page') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<video src="/stable/video.mp4"></video>')
      return
    }
    if (request.url === '/stable/video.mp4') {
      response.writeHead(302, { location: '/temporary/shard.mp4' })
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': videoSize })
    response.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const address = server.address()
  const pageUrl = `http://127.0.0.1:${address.port}/page`
  const result = await resolveHtmlPageMedia(pageUrl, undefined)

  assert.equal(result.variants[0].url, `http://127.0.0.1:${address.port}/stable/video.mp4`)
  assert.equal(result.variants[0].estimatedSize, videoSize)
})
