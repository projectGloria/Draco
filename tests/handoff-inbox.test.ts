import { deepStrictEqual, rejects, strictEqual } from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import type { HandoffRequest } from '../src/shared/types.ts'
import { BrowserHandoffInbox } from '../src/main/bridge/handoff-inbox.ts'
import { openJson, type StringCipher } from '../src/main/sealed-json.ts'

const cipher: StringCipher = {
  seal: (plain) => Buffer.from(plain).toString('base64'),
  open: (sealed) => Buffer.from(sealed, 'base64').toString('utf8')
}

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function path(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'draco-inbox-'))
  dirs.push(dir)
  return join(dir, 'browser-handoffs.json')
}

function request(id: string, expiresAt = Date.now() + 60_000): HandoffRequest {
  return {
    id, kind: 'file', expiresAt,
    url: `https://example.com/${id}.bin`,
    headers: { referer: 'https://example.com/', cookie: 'session=1' },
    size: null, mimeType: null
  }
}

describe('durable browser confirmation inbox', () => {
  it('restores an offered request after restart and removes it durably', async () => {
    const file = await path()
    const first = new BrowserHandoffInbox(file, cipher)
    await first.offer(request('one'))
    const restored = new BrowserHandoffInbox(file, cipher)
    deepStrictEqual((await restored.load()).map((item) => item.id), ['one'])
    await restored.remove('one')
    strictEqual((await new BrowserHandoffInbox(file, cipher).load()).length, 0)
    strictEqual((await readFile(file, 'utf8')).includes('session=1'), false)
  })

  it('deduplicates identities and rejects a thirteenth pending dialog', async () => {
    const inbox = new BrowserHandoffInbox(await path(), cipher)
    await inbox.offer(request('one'))
    strictEqual((await inbox.offer(request('one'))).url, 'https://example.com/one.bin')
    for (let i = 2; i <= 12; i++) await inbox.offer(request(`item-${i}`))
    await rejects(inbox.offer(request('item-13')), /Too many pending/)
    strictEqual(inbox.list().length, 12)
  })

  it('prunes expired requests from disk on restart', async () => {
    const file = await path()
    const inbox = new BrowserHandoffInbox(file, cipher)
    await inbox.offer(request('old', Date.now() + 100))
    const loaded = new BrowserHandoffInbox(file, cipher)
    deepStrictEqual(await loaded.load(Date.now() + 200), [])
    deepStrictEqual(openJson(JSON.parse(await readFile(file, 'utf8')), cipher).value, [])
  })

  it('keeps an expiring request while acceptance is committing', async () => {
    const inbox = new BrowserHandoffInbox(await path(), cipher)
    await inbox.offer(request('committing', Date.now() + 100))
    const later = Date.now() + 200
    deepStrictEqual(await inbox.prune(later, (id) => id === 'committing'), [])
    strictEqual(inbox.list().length, 1)
    deepStrictEqual(await inbox.prune(later), ['committing'])
  })

  it('does not acknowledge a request when the inbox cannot be written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'draco-inbox-blocked-'))
    dirs.push(dir)
    const inbox = new BrowserHandoffInbox(dir, cipher)
    await rejects(inbox.offer(request('one')))
    strictEqual(inbox.list().length, 0)
  })

  it('migrates old readable inbox and backup without keeping the cookie in either', async () => {
    const file = await path()
    const legacy = JSON.stringify([request('old')])
    await writeFile(file, legacy)
    await writeFile(file + '.bak', legacy)
    const inbox = new BrowserHandoffInbox(file, cipher)
    strictEqual((await inbox.load()).length, 1)
    strictEqual((await readFile(file, 'utf8')).includes('session=1'), false)
    strictEqual((await readFile(file + '.bak', 'utf8')).includes('session=1'), false)
  })
})
