import { notStrictEqual, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resourceFor, rewriteForOffline } from '../src/main/site-grabber/crawler.ts'

describe('offline site paths', () => {
  it('escapes Windows devices in every downloaded path component', () => {
    strictEqual(resourceFor(new URL('https://example.com/CON.tar/COM%C2%B9.zip'), 'asset').relativePath,
      'CON_.tar/COM¹_.zip')
  })
  it('does not introduce an invalid trailing dot by truncating a long pathname', () => {
    strictEqual(resourceFor(new URL('https://example.com/' + 'x'.repeat(179) + '.suffix'), 'asset').relativePath,
      'x'.repeat(179))
  })
  it('keeps external origins separate when they serve the same pathname', () => {
    const base = 'https://example.com'
    const own = resourceFor(new URL(base + '/image.png'), 'asset', base)
    const first = resourceFor(new URL('https://cdn.example.com/image.png'), 'asset', base)
    const second = resourceFor(new URL('https://other.example.com/image.png'), 'asset', base)
    strictEqual(own.relativePath, 'image.png')
    notStrictEqual(first.relativePath, own.relativePath)
    notStrictEqual(first.relativePath, second.relativePath)
  })

  it('preserves local and cross-page fragment navigation', () => {
    const paths = new Map([
      ['https://example.com/docs', 'docs.html'],
      ['https://example.com/guide', 'guide.html']
    ])
    strictEqual(rewriteForOffline('<a href="#intro">Intro</a><a href="/guide#install">Install</a>',
      new URL('https://example.com/docs'), 'docs.html', paths),
    '<a href="#intro">Intro</a><a href="./guide.html#install">Install</a>')
  })

  it('encodes filename URL syntax and quotes in rewritten attributes', () => {
    const url = new URL('https://example.com/a%20b%23%25%27.png')
    const resource = resourceFor(url, 'asset')
    const html = `<img src='/a%20b%23%25%27.png'>`
    strictEqual(rewriteForOffline(html, new URL('https://example.com/'), 'index.html',
      new Map([[resource.url, resource.relativePath]])),
    `<img src='./a%20b%23%25%27.png'>`)
  })
})
