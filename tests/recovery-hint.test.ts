import { strictEqual } from 'node:assert/strict'
import { it } from 'node:test'
import { recoveryHint } from '../src/shared/recovery.ts'

it('offers the action that matches a recoverable task failure', () => {
  strictEqual(recoveryHint({ status: 'missing', error: null }), 'recoveryMissing')
  strictEqual(recoveryHint({ status: 'error', error: 'ENOSPC: no space left on device' }), 'recoveryDiskFull')
  strictEqual(recoveryHint({ status: 'error', error: 'EACCES: permission denied' }), 'recoveryPermission')
  strictEqual(recoveryHint({ status: 'error', error: 'HTTP 401 Unauthorized' }), 'recoveryAccess')
  strictEqual(recoveryHint({ status: 'error', error: 'example.test rejected the saved username and password' }), 'recoveryCredentials')
  strictEqual(recoveryHint({ status: 'error', error: 'Checksum mismatch' }), 'recoveryChecksum')
  strictEqual(recoveryHint({ status: 'error', error: 'Connection reset' }), 'recoveryRetry')
  strictEqual(recoveryHint({ status: 'paused', error: null }), null)
})
