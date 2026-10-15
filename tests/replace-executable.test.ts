import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rejects, strictEqual } from 'node:assert/strict'
import { it } from 'node:test'
import { replaceVerifiedExecutable } from '../src/main/hls/replace-executable.ts'

it('preserves a working executable when its staged replacement fails validation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'draco-replace-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const source = join(dir, 'new.exe')
  const target = join(dir, 'current.exe')
  await writeFile(source, 'new binary')
  await writeFile(target, 'working binary')

  await rejects(replaceVerifiedExecutable(source, target, async () => false), /did not run/)
  strictEqual(await readFile(target, 'utf8'), 'working binary')
  strictEqual((await readdir(dir)).length, 2)

  await replaceVerifiedExecutable(source, target, async (path) =>
    (await readFile(path, 'utf8')) === 'new binary'
  )
  strictEqual(await readFile(target, 'utf8'), 'new binary')
  strictEqual((await readdir(dir)).length, 2)
})
