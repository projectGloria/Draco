import { strictEqual } from 'node:assert/strict'
import { it } from 'node:test'
import { displaySource } from '../src/shared/display-source.ts'

it('does not display URL credentials, paths, or signed query values', () => {
  strictEqual(displaySource('https://user:password@example.test/private/token?sig=secret#part'), 'https://example.test')
  strictEqual(displaySource('https://example.test:8443/download?token=secret'), 'https://example.test:8443')
  strictEqual(displaySource('magnet:?xt=urn:btih:1234&tr=https://secret.test'), 'Magnet link')
  strictEqual(displaySource('broken-secret'), 'Download source')
})
