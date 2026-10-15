import { rejects, strictEqual } from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
import { it } from 'node:test'
import { sanitizeCategories } from '../src/main/store-sanitize.ts'
import type { Category } from '../src/shared/types.ts'

it('changes live categories only after successful persistence, and recovers from failure', async () => {
  const source = readFileSync(new URL('../src/main/store.ts', import.meta.url), 'utf8')
  const code = stripTypeScriptTypes(source.slice(source.indexOf('let categories:'), source.indexOf('export async function loadTasks(')))
    .replace(/^export /gm, '')
  const original: Category[] = [{ id: 'one', name: 'Original', folder: 'Original', builtin: false, extensions: [], hosts: [] }]
  let fail = false
  const api = runInNewContext(code + '\n({ loadCategories, getCategories, saveCategories })', {
    getPaths: () => ({ categoriesFile: 'categories.json' }), readJsonOrThrowIfPresent: async () => original,
    defaultCategories: () => original, sanitizeCategories,
    writeJsonAtomic: async () => { if (fail) throw new Error('disk full') }
  })
  await api.loadCategories()
  fail = true
  await rejects(api.saveCategories([{ ...original[0], name: 'Failed' }]), /disk full/)
  strictEqual(api.getCategories()[0].name, 'Original')
  fail = false
  await api.saveCategories([{ ...original[0], name: 'Saved' }])
  strictEqual(api.getCategories()[0].name, 'Saved')
})
