import test from 'node:test'
import assert from 'node:assert/strict'
import { compareVersions } from '../src/main/update-version.ts'
import { scannerArgs } from '../src/main/security/scanner.ts'

test('update comparison uses semantic version numbers rather than string order', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1)
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
  assert.equal(compareVersions('1.2.2', '1.2.3'), -1)
})

test('scanner arguments substitute the file as one shell-free argument', () => {
  const path = 'C:\\Downloads\\file with spaces.exe'
  assert.deepEqual(scannerArgs(['--scan', '{file}'], path), ['--scan', path])
  assert.deepEqual(scannerArgs(['--scan'], path), ['--scan', path])
})
