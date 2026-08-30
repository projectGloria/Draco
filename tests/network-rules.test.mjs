import test from 'node:test'
import assert from 'node:assert/strict'
import { connectionsForUrl } from '../src/main/engine/network-rules.ts'

test('the most specific host connection rule wins', () => {
  const rules = [
    { host: 'example.com', connections: 4 },
    { host: 'downloads.example.com', connections: 2 }
  ]

  assert.equal(connectionsForUrl('https://downloads.example.com/file', 8, rules), 2)
  assert.equal(connectionsForUrl('https://cdn.example.com/file', 8, rules), 4)
  assert.equal(connectionsForUrl('https://notexample.com/file', 8, rules), 8)
  assert.equal(connectionsForUrl('not a url', 8, rules), 8)
})
