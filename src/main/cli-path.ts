import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from './log.ts'

const log = logger('cli-path')

/**
 * Puts the folder holding `draco.cmd` on the user's PATH, so `draco <url>`
 * works from any new terminal.
 *
 * Done by the app at runtime rather than by the NSIS installer on purpose. The
 * installer's string buffer is a fixed size, and a user PATH longer than it is
 * silently truncated on the way back in - the classic way installers wipe
 * half of someone's PATH. Node has no such limit, and the same code then also
 * serves a reinstall into another folder, which the setting re-syncs on start.
 *
 * Per-user (HKCU\Environment) only: no elevation, no machine-wide state.
 * Electron-free; the caller works out which folder applies.
 */

const ENV_KEY = 'HKCU\\Environment'

export interface CliPathStatus {
  /** Folder that holds draco.cmd, or null when this copy cannot offer one. */
  dir: string | null
  /** Why `dir` is null, for the Options panel. */
  unavailableReason: string | null
  /** Whether the user PATH currently contains `dir`. */
  onPath: boolean
}

/* ------------------------------------------------------------------ */
/* Pure helpers - the part worth testing                               */
/* ------------------------------------------------------------------ */

/** Case- and trailing-slash-insensitive, as Windows itself compares them. */
function sameDir(a: string, b: string): boolean {
  const norm = (value: string): string => value.trim().replace(/^"|"$/g, '').replace(/[\\/]+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

export function hasPathEntry(pathValue: string, dir: string): boolean {
  return pathValue.split(';').some((entry) => sameDir(entry, dir))
}

/**
 * Appends `dir`, leaving every other entry byte-for-byte as it was.
 *
 * Unexpanded `%VARS%` survive because nothing here expands them - which is
 * also why the value is read with reg.exe rather than `process.env.Path`: that
 * is the *expanded*, machine+user merged value, and writing it back would
 * flatten every `%USERPROFILE%` and copy the system PATH into the user's.
 */
export function addPathEntry(pathValue: string, dir: string): string {
  if (hasPathEntry(pathValue, dir)) return pathValue
  const trimmed = pathValue.replace(/;+$/, '')
  return trimmed ? `${trimmed};${dir}` : dir
}

/** Removes every spelling of `dir` and nothing else. */
export function removePathEntry(pathValue: string, dir: string): string {
  return pathValue.split(';').filter((entry) => !sameDir(entry, dir)).join(';')
}

/**
 * The raw value and type from `reg query HKCU\Environment /v Path`.
 *
 * Output looks like `    Path    REG_EXPAND_SZ    C:\a;%X%\b`. The name and
 * type tokens are not localised, and the value is everything after the type.
 */
export function parseRegQuery(stdout: string): { type: string; value: string } | null {
  const match = /^\s*Path\s+(REG_(?:EXPAND_)?SZ)\s+(.*?)\s*$/im.exec(stdout)
  if (match) return { type: match[1], value: match[2] }
  // A Path that exists but is empty prints the type and nothing after it.
  const empty = /^\s*Path\s+(REG_(?:EXPAND_)?SZ)\s*$/im.exec(stdout)
  return empty ? { type: empty[1], value: '' } : null
}

/* ------------------------------------------------------------------ */
/* Registry I/O                                                        */
/* ------------------------------------------------------------------ */

function run(command: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    // Argument array with shell:false, as in `shell-integration.ts`: the value
    // is the user's whole PATH, and a shell would have opinions about `%` and `&`.
    const child = spawn(command, args, { shell: false, windowsHide: true })
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.on('error', () => resolve({ code: -1, stdout: '' }))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout }))
  })
}

async function readUserPath(): Promise<{ type: string; value: string }> {
  const { code, stdout } = await run('reg', ['query', ENV_KEY, '/v', 'Path'])
  const parsed = code === 0 ? parseRegQuery(stdout) : null
  if (parsed) return parsed

  // `reg query /v` exits 1 both when Path is absent and when the query itself
  // failed, and the two must not be confused: treating a failed read as an
  // empty PATH would make the next write replace the user's whole PATH with
  // our one folder. Only a key that demonstrably exists without a Path value
  // counts as "empty".
  const key = await run('reg', ['query', ENV_KEY])
  if (key.code === 0 && !/^\s*Path\s+REG_/im.test(key.stdout)) {
    // REG_EXPAND_SZ is what Windows itself creates for a user Path.
    return { type: 'REG_EXPAND_SZ', value: '' }
  }
  throw new Error('Could not read the user PATH; it was left unchanged')
}

async function writeUserPath(type: string, value: string): Promise<void> {
  const { code } = await run('reg', ['add', ENV_KEY, '/v', 'Path', '/t', type, '/d', value, '/f'])
  if (code !== 0) throw new Error(`reg add exited with ${code}`)
  await broadcastEnvironmentChange()
}

/**
 * Tells Explorer (and so every terminal opened after this) that the
 * environment changed. Without it the new PATH only appears after signing out.
 *
 * .NET's SetEnvironmentVariable broadcasts WM_SETTINGCHANGE after any write to
 * the User scope; deleting a variable that does not exist is a harmless write
 * that buys the broadcast without touching anything real. Best-effort: failing
 * here costs a sign-out, not the PATH change.
 */
async function broadcastEnvironmentChange(): Promise<void> {
  const { code } = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    "[Environment]::SetEnvironmentVariable('DRACO_ENV_REFRESH', $null, 'User')"
  ])
  if (code !== 0) log.warn('could not broadcast the environment change; new terminals may need a sign-out to see it')
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * The folder this copy would put on PATH.
 *
 * Only an installed copy has a stable one. A portable build unpacks itself
 * into a fresh temp folder every launch, so any entry it wrote would point
 * nowhere by the next run; a dev checkout has `npm link` for this instead.
 */
export function cliDirFor(input: {
  isPackaged: boolean
  resourcesPath: string
  portable: boolean
}): { dir: string | null; reason: string | null } {
  if (!input.isPackaged) return { dir: null, reason: 'Development copy: run npm link in the repository instead.' }
  if (input.portable) return { dir: null, reason: 'Portable copies move every launch; use the installer to get the draco command.' }
  const dir = join(input.resourcesPath, 'bin')
  if (!existsSync(join(dir, 'draco.cmd'))) return { dir: null, reason: 'draco.cmd is missing from this installation.' }
  return { dir, reason: null }
}

export async function cliPathStatus(dir: string | null, reason: string | null): Promise<CliPathStatus> {
  if (!dir) return { dir: null, unavailableReason: reason, onPath: false }
  const { value } = await readUserPath()
  return { dir, unavailableReason: null, onPath: hasPathEntry(value, dir) }
}

/** True when PATH was changed, false when the entry was already there. */
export async function addCliToPath(dir: string): Promise<boolean> {
  const { type, value } = await readUserPath()
  const next = addPathEntry(value, dir)
  if (next === value) return false
  await writeUserPath(type, next)
  log.info(`added ${dir} to the user PATH`)
  return true
}

/** True when PATH was changed, false when the entry was not there. */
export async function removeCliFromPath(dir: string): Promise<boolean> {
  const { type, value } = await readUserPath()
  const next = removePathEntry(value, dir)
  if (next === value) return false
  await writeUserPath(type, next)
  log.info(`removed ${dir} from the user PATH`)
  return true
}
