import { strictEqual, throws } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { validateHostMessage } from '../src/main/bridge/protocol.ts'

describe('confirmation status protocol', () => {
  it('accepts bounded handoff identities for status and cancellation', () => {
    const status = validateHostMessage({ type: 'handoffStatus', handoffId: 'request-123' })
    const cancel = validateHostMessage({ type: 'handoffCancel', handoffId: 'request-123' })
    strictEqual(status.type, 'handoffStatus')
    strictEqual(cancel.type, 'handoffCancel')
    if (status.type === 'handoffStatus') strictEqual(status.handoffId, 'request-123')
    if (cancel.type === 'handoffCancel') strictEqual(cancel.handoffId, 'request-123')
  })

  it('rejects malformed handoff identities', () => {
    for (const handoffId of ['', 'with space', 'a'.repeat(129), 123]) {
      throws(() => validateHostMessage({ type: 'handoffStatus', handoffId }))
    }
  })

  it('carries a bounded browser deadline into a download handoff', () => {
    const deadline = Date.now() + 60_000
    const message = validateHostMessage({
      type: 'download', requestId: 'one', url: 'https://example.com/file.bin',
      handoffExpiresAt: deadline
    })
    if (message.type === 'download') strictEqual(message.handoffExpiresAt, deadline)
    throws(() => validateHostMessage({
      type: 'download', url: 'https://example.com/file.bin',
      handoffExpiresAt: Date.now() + 60 * 60_000
    }))
  })
})
