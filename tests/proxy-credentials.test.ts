import { strictEqual, deepStrictEqual } from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { writeJsonAtomic } from '../src/main/json-file.ts'
import {
  assembleProxyUrl,
  backupHasProxyCredentials,
  hasProxyCredentials,
  sanitizeAndStoreProxyUrl,
  splitProxyUrl,
  type ProxyCredentialSink
} from '../src/main/proxy-credentials.ts'

describe('proxy credential isolation and migration (F-08 / D3)', () => {
  it('strips user:pass from proxyUrl and reassembles only when building the dispatcher', () => {
    const split = splitProxyUrl('http://alice:Secret%40Pass123@proxy.corp.example:8080')
    strictEqual(split.sanitizedUrl, 'http://proxy.corp.example:8080')
    strictEqual(split.host, 'proxy.corp.example:8080')
    strictEqual(split.username, 'alice')
    strictEqual(split.password, 'Secret@Pass123')
    strictEqual(hasProxyCredentials('http://alice:Secret@proxy.corp.example:8080'), true)
    strictEqual(hasProxyCredentials(split.sanitizedUrl), false)

    const reassembled = assembleProxyUrl(split.sanitizedUrl, {
      username: split.username!,
      password: split.password!
    })
    strictEqual(reassembled, 'http://alice:Secret%40Pass123@proxy.corp.example:8080/')
    strictEqual(assembleProxyUrl(split.sanitizedUrl, null), 'http://proxy.corp.example:8080')
  })

  it('stores credentials in the sealed sink, preserves them on sanitized saves, and clears them when proxyUrl is removed', async () => {
    const saved: Array<{ host: string; username: string; password: string }> = []
    let cleared = 0
    const sink: ProxyCredentialSink = {
      async save(host, username, password) { saved.push({ host, username, password }) },
      async clear() { cleared++ }
    }

    const r1 = await sanitizeAndStoreProxyUrl('http://bob:hunter2@proxy.local:3128', sink)
    strictEqual(r1.sanitizedUrl, 'http://proxy.local:3128')
    strictEqual(r1.extracted, true)
    deepStrictEqual(saved, [{ host: 'proxy.local:3128', username: 'bob', password: 'hunter2' }])

    // Saving an already-sanitized proxyUrl (e.g. changing another setting in Options) must NOT clear stored creds
    const r2 = await sanitizeAndStoreProxyUrl('http://proxy.local:3128', sink)
    strictEqual(r2.sanitizedUrl, 'http://proxy.local:3128')
    strictEqual(r2.extracted, false)
    strictEqual(cleared, 0)

    // Clearing proxyUrl clears stored creds
    const r3 = await sanitizeAndStoreProxyUrl(null, sink)
    strictEqual(r3.sanitizedUrl, null)
    strictEqual(cleared, 1)
  })

  it('migrates plaintext proxy credentials out of settings.json AND overwrites settings.json.bak, tolerating missing/corrupt backups', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'draco-proxy-migrate-'))
    const settingsPath = join(dir, 'settings.json')
    try {
      const legacy = { proxyUrl: 'http://alice:SuperSecret99@proxy.corp:8080', theme: 'dark' }
      await writeFile(settingsPath, JSON.stringify(legacy, null, 2), 'utf8')
      await writeFile(settingsPath + '.bak', JSON.stringify(legacy, null, 2), 'utf8')

      strictEqual(await backupHasProxyCredentials(settingsPath), true)

      const saved: Array<{ host: string; username: string; password: string }> = []
      const sink: ProxyCredentialSink = {
        async save(host, username, password) { saved.push({ host, username, password }) },
        async clear() {}
      }

      const migrated = await sanitizeAndStoreProxyUrl(legacy.proxyUrl, sink)
      const sanitizedSettings = { ...legacy, proxyUrl: migrated.sanitizedUrl }
      const bakHadCreds = await backupHasProxyCredentials(settingsPath)
      await writeJsonAtomic(settingsPath, sanitizedSettings, true, migrated.extracted || bakHadCreds ? 'replace' : 'previous')

      deepStrictEqual(saved, [{ host: 'proxy.corp:8080', username: 'alice', password: 'SuperSecret99' }])
      const diskPrimary = await readFile(settingsPath, 'utf8')
      const diskBak = await readFile(settingsPath + '.bak', 'utf8')
      strictEqual(diskPrimary.includes('SuperSecret99'), false, 'primary settings.json must not contain plaintext password')
      strictEqual(diskBak.includes('SuperSecret99'), false, 'settings.json.bak must not contain plaintext password')
      strictEqual(JSON.parse(diskPrimary).proxyUrl, 'http://proxy.corp:8080')
      strictEqual(JSON.parse(diskBak).proxyUrl, 'http://proxy.corp:8080')

      // Corrupted .bak must not throw
      await writeFile(settingsPath + '.bak', '{not valid json', 'utf8')
      strictEqual(await backupHasProxyCredentials(settingsPath), false)

      // Missing .bak must not throw
      await rm(settingsPath + '.bak', { force: true })
      strictEqual(await backupHasProxyCredentials(settingsPath), false)
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
