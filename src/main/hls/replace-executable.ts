import { randomUUID } from 'node:crypto'
import { copyFile, rename, rm } from 'node:fs/promises'

/** Validate a same-directory staged executable before replacing the current one. */
export async function replaceVerifiedExecutable(
  source: string,
  target: string,
  isUsable: (path: string) => Promise<boolean>
): Promise<void> {
  const staged = `${target}.${randomUUID()}.exe`
  try {
    await copyFile(source, staged)
    if (!(await isUsable(staged))) throw new Error('Downloaded executable did not run after staging')
    await rename(staged, target)
  } finally {
    await rm(staged, { force: true }).catch(() => {})
  }
}
