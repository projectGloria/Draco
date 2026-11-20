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
  proxyCredentialKey,
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
    deepStrictEqual(saved, [{ host: 'http://proxy.local:3128', username: 'bob', password: 'hunter2' }])

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

      deepStrictEqual(saved, [{ host: 'http://proxy.corp:8080', username: 'alice', password: 'SuperSecret99' }])
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

  it('saves under the same key the dispatcher looks up, including non-default ports for the scheme', async () => {
    for (const raw of [
      'http://bob:pw@proxy.local:3128',
      'http://bob:pw@proxy.local:443',
      'https://bob:pw@proxy.local:80',
      'http://bob:pw@proxy.local',
      'https://bob:pw@PROXY.local:443'
    ]) {
      const saved: string[] = []
      const sink: ProxyCredentialSink = {
        async save(key) { saved.push(key) },
        async clear() {}
      }
      const { sanitizedUrl } = await sanitizeAndStoreProxyUrl(raw, sink)
      // `resolveProxyUrl` looks the secret up by `proxyCredentialKey(sanitizedUrl)`.
      deepStrictEqual(saved, [proxyCredentialKey(sanitizedUrl!)], raw)
    }
  })

  it('keeps a username-only proxy credential instead of stripping it and saving nothing', async () => {
    const saved: Array<{ key: string; username: string; password: string }> = []
    const sink: ProxyCredentialSink = {
      async save(key, username, password) { saved.push({ key, username, password }) },
      async clear() {}
    }
    const result = await sanitizeAndStoreProxyUrl('http://token@proxy.local:3128', sink)
    strictEqual(result.sanitizedUrl, 'http://proxy.local:3128')
    strictEqual(result.extracted, true)
    deepStrictEqual(saved, [{ key: 'http://proxy.local:3128', username: 'token', password: '' }])
    strictEqual(
      assembleProxyUrl(result.sanitizedUrl, { username: 'token', password: '' }),
      'http://token@proxy.local:3128/'
    )
  })

  it('leaves the URL untouched when the credential cannot be saved', async () => {
    const sink: ProxyCredentialSink = {
      async save() { throw new Error('safeStorage unavailable') },
      async clear() {}
    }
    const result = await sanitizeAndStoreProxyUrl('http://bob:pw@proxy.local:3128', sink)
    strictEqual(result.extracted, false)
    strictEqual(result.sanitizedUrl, 'http://bob:pw@proxy.local:3128')
  })

  it('round-trips a literal % in the username and password the way undici decodes them', () => {
    for (const [username, password] of [['50%off', 'p%ss'], ['a%2Fb', '100%'], ['user name', 'p@ss:w/rd%']]) {
      const assembled = assembleProxyUrl('http://proxy.local:3128', { username, password })!
      const parsed = new URL(assembled)
      // undici's ProxyAgent builds Proxy-Authorization from these exactly so.
      strictEqual(decodeURIComponent(parsed.username), username)
      strictEqual(decodeURIComponent(parsed.password), password)
      // And the settings save path splits it back to the same pair.
      const split = splitProxyUrl(assembled)
      strictEqual(split.username, username)
      strictEqual(split.password, password)
    }
    // A stray % that was typed into the settings field rather than encoded.
    const typed = splitProxyUrl('http://bob:50%@proxy.local:3128')
    strictEqual(typed.password, '50%')
  })
})
