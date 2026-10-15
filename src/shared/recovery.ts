import type { DownloadTask } from './types.ts'

export type RecoveryHint =
  | 'recoveryMissing'
  | 'recoveryDiskFull'
  | 'recoveryPermission'
  | 'recoveryCredentials'
  | 'recoveryAccess'
  | 'recoveryChecksum'
  | 'recoveryRetry'

/** A next step for common failures; the technical error remains available. */
export function recoveryHint(task: Pick<DownloadTask, 'status' | 'error'>): RecoveryHint | null {
  if (task.status === 'missing') return 'recoveryMissing'
  if (task.status !== 'error') return null

  const error = task.error ?? ''
  if (/ENOSPC|no space|disk full|not enough free space|insufficient disk/i.test(error)) {
    return 'recoveryDiskFull'
  }
  if (/EACCES|EPERM|permission denied|access denied|read.only/i.test(error)) {
    return 'recoveryPermission'
  }
  if (/username|password|saved credentials/i.test(error)) {
    return 'recoveryCredentials'
  }
  if (/HTTP 40[13]|unauthorized|forbidden|sign.in|expired/i.test(error)) {
    return 'recoveryAccess'
  }
  if (/checksum|hash mismatch|digest mismatch/i.test(error)) {
    return 'recoveryChecksum'
  }
  return 'recoveryRetry'
}
