import { deepStrictEqual, rejects, strictEqual, throws } from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { it } from 'node:test'
import { readJsonOrThrowIfPresent, writeJsonAtomic } from '../src/main/json-file.ts'
import { openJson, readSealedJsonFile, sealJson, type StringCipher } from '../src/main/sealed-json.ts'

const cipher: StringCipher = {
  seal: (plain) => Buffer.from(plain).toString('base64'),
  open: (sealed) => Buffer.from(sealed, 'base64').toString('utf8')
}

it('round trips protected JSON and rejects an unreadable payload', () => {
  const saved = sealJson([{ url: 'https://example.com/?token=secret', headers: { cookie: 'session=1' } }], cipher)
  strictEqual(JSON.stringify(saved).includes('session=1'), false)
  deepStrictEqual(openJson(saved, cipher).value,
    [{ url: 'https://example.com/?token=secret', headers: { cookie: 'session=1' } }])
  throws(() => openJson(saved, { ...cipher, open: () => { throw new Error('wrong key') } }), /Could not decrypt/)
})

it('replaces a readable legacy primary and backup during migration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'draco-sealed-state-'))
  const file = join(dir, 'tasks.json')
  try {
    const legacy = [{ url: 'https://example.com/?token=secret', headers: { cookie: 'session=1' } }]
    await writeFile(file, JSON.stringify(legacy))
    await writeFile(file + '.bak', JSON.stringify(legacy))
    const loaded = await readJsonOrThrowIfPresent(file)
    deepStrictEqual(openJson(loaded, cipher), { value: legacy, legacy: true })
    await writeJsonAtomic(file, sealJson(legacy, cipher), false, 'replace')
    for (const path of [file, file + '.bak']) {
      const text = await readFile(path, 'utf8')
      strictEqual(text.includes('session=1') || text.includes('token=secret'), false)
      deepStrictEqual(openJson(JSON.parse(text), cipher).value, legacy)
    }
    await writeFile(file + '.bak', JSON.stringify(legacy))
    strictEqual((await readSealedJsonFile(file, cipher))?.repairBackup, true)
    await writeJsonAtomic(file, sealJson(legacy, cipher), false, 'replace')
    strictEqual((await readFile(file + '.bak', 'utf8')).includes('session=1'), false)
    await writeFile(file, JSON.stringify({ sealedVersion: 1, payload: 'damaged' }))
    deepStrictEqual((await readSealedJsonFile(file, cipher))?.value, legacy)
    await rejects(writeJsonAtomic(file, undefined))
  } finally {
    if (!resolve(dir).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe test cleanup path')
    await rm(dir, { recursive: true, force: true })
  }
})
