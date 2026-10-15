import { strictEqual } from 'node:assert/strict'
import { test } from 'node:test'
import { ThumbnailCache } from '../src/main/thumbnail-cache.ts'

test('thumbnail memory is bounded by bytes, including replaced and missing images', () => {
  const cache = new ThumbnailCache(600, 300)
  cache.set('a', 'x'.repeat(50))
  cache.set('b', 'x'.repeat(50))
  strictEqual(cache.get('a'), undefined, 'byte budget evicts before the entry cap')
  strictEqual(cache.get('b')?.length, 50)
  cache.set('b', null)
  cache.set('c', 'x'.repeat(50))
  strictEqual(cache.get('b'), null, 'replacement releases the previous value budget')
  strictEqual(cache.get('c')?.length, 50)
  cache.set('huge', 'x'.repeat(300))
  strictEqual(cache.get('huge'), undefined)
  strictEqual(cache.get('c')?.length, 50, 'oversized images do not empty a useful cache')
})

test('thumbnail eviction preserves recently viewed images and caps negative entries', () => {
  const cache = new ThumbnailCache(2, 10000)
  cache.set('a', null)
  cache.set('b', 'image')
  strictEqual(cache.get('a'), null)
  cache.set('c', null)
  strictEqual(cache.get('b'), undefined)
  strictEqual(cache.get('a'), null)
  strictEqual(cache.get('c'), null)
})
