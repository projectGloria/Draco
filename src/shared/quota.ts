/**
 * How a task parked by the transfer budget identifies itself.
 *
 * A quota hold and a pause the user chose are both `paused` - correctly, since
 * both stop and both resume - so the row drew the same grey dot for each, and
 * an overnight queue held by its own budget was indistinguishable from one
 * somebody had stopped. The engine writes the reason into `detail`; this is the
 * one string both sides agree on so the list can colour it as waiting rather
 * than idle.
 *
 * A prefix rather than an exact match, because the detail carries the time the
 * window turns over after it.
 */
export const QUOTA_DETAIL_PREFIX = 'Transfer quota reached'

export function isQuotaHold(status: string, detail: string | null | undefined): boolean {
  return status === 'paused' && typeof detail === 'string' && detail.startsWith(QUOTA_DETAIL_PREFIX)
}
