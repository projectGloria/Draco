import test from 'node:test'
import assert from 'node:assert/strict'
import { directoryFor } from '../src/main/categories.ts'

test('site category rules take precedence over extension categories', () => {
  const categories = [
    { id: 'site', name: 'Portal', folder: 'Portal', builtin: false, extensions: [], hosts: ['example.com'] },
    { id: 'docs', name: 'Documents', folder: 'Documents', builtin: true, extensions: ['pdf'], hosts: [] }
  ]
  assert.deepEqual(
    directoryFor('C:/Downloads', categories, 'manual.pdf', 'application/pdf', null, 'https://cdn.example.com/manual.pdf'),
    { dir: 'C:\\Downloads\\Portal', categoryId: 'site' }
  )
})
