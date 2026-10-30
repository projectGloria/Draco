import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Why a folder was picked - shown next to it, so a download never lands somewhere surprising. */
export type SaveDirSource = 'typed' | 'here' | 'config' | 'default' | 'session'

export interface SaveDir { dir: string; source: SaveDirSource }

export interface SaveDirInput {
  /** `-P` typed on the command line itself. */
  cliDir: string | null
  /** `-P` from draco.cfg. */
  cfgDir: string | null
  cwd: string
  home?: string
  /** Folders that are never "where I meant to download": Draco's own install folder. */
  ignore?: string[]
  platform?: string
  windir?: string | undefined
}

/**
 * Where downloads go, in one place so the full-screen UI and `draco URL` agree.
 *
 *   1. `-P` typed on the command line - the most explicit thing there is.
 *   2. The folder Draco was started from, when that folder means something:
 *      `cd Desktop\a; draco` downloads into `a`.
 *   3. Started from a folder that means nothing - the home folder Windows
 *      Terminal opens in, System32 (Win+R), Draco's own install folder - the
 *      cfg's `-P`, and failing that Downloads.
 *
 * The cfg's `-P` is the *default*, not an override: a cfg that always won
 * would make rule 2 impossible, and that rule is the point.
 */
export function resolveSaveDir(input: SaveDirInput): SaveDir {
  const platform = input.platform ?? process.platform
  const home = input.home ?? homedir()
  if (input.cliDir) return { dir: resolve(input.cwd, input.cliDir), source: 'typed' }
  const cwd = resolve(input.cwd)
  const windir = input.windir === undefined ? process.env.WINDIR ?? process.env.SystemRoot : input.windir
  const meaningless = [home, ...(input.ignore ?? [])]
  if (platform === 'win32' && windir) meaningless.push(windir)
  const key = (path: string): string => {
    const full = resolve(path).replace(/[\\/]+$/, '')
    return platform === 'win32' ? full.toLowerCase() : full
  }
  const here = key(cwd)
  // The Windows folder covers System32 and SysWOW64 below it; the others are exact matches only.
  const pointless = meaningless.some(path => key(path) === here) ||
    (platform === 'win32' && windir !== undefined && windir !== '' && (here + '\\').startsWith(key(windir) + '\\'))
  if (!pointless) return { dir: cwd, source: 'here' }
  if (input.cfgDir) return { dir: resolve(cwd, input.cfgDir), source: 'config' }
  return { dir: join(home, 'Downloads'), source: 'default' }
}

export function saveDirLabel(source: SaveDirSource | undefined): string {
  switch (source) {
    case 'here': return 'this folder'
    case 'config': return 'draco.cfg'
    case 'default': return 'default'
    case 'typed': return '-P'
    case 'session': return 'this session'
    default: return ''
  }
}
