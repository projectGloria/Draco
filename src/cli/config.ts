import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { UsageError } from './args.ts'

/**
 * draco.cfg: default command-line flags, one or more per line, read before the
 * real command line so anything typed there wins.
 *
 *   # comments start with #
 *   -P "D:\Videos"
 *   -N 16
 *   -o "%(uploader)s/%(title)s.%(ext)s"
 *
 * Same idea as yt-dlp's config file, so it needs no second vocabulary: every
 * flag `draco --help` lists works here, and nothing else does.
 */

export const CONFIG_NAME = 'draco.cfg'

/**
 * Draco's root folder: the one holding Draco.exe when installed (the CLI runs
 * inside Draco.exe, so `execPath` is it), the repository root in development.
 */
export function defaultConfigPath(packaged: boolean, execPath: string, sourceRoot: string): string {
  return join(packaged ? join(execPath, '..') : sourceRoot, CONFIG_NAME)
}

/**
 * Splits config text into argv-style tokens.
 *
 * Quotes group, and there is deliberately no backslash escaping: this file is
 * full of Windows paths, and `D:\new\videos` must not grow a newline. A `#`
 * starts a comment only at the start of a word, so `#3` inside quotes and the
 * `#` in a URL fragment survive.
 */
export function tokenizeConfig(text: string): string[] {
  const tokens: string[] = []
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  lines.forEach((line, index) => {
    let current = ''
    let inToken = false
    let quote: '"' | "'" | null = null
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (quote) {
        if (ch === quote) quote = null
        else current += ch
        continue
      }
      if (ch === '"' || ch === "'") {
        quote = ch
        inToken = true
        continue
      }
      if (ch === ' ' || ch === '\t') {
        if (inToken) tokens.push(current)
        current = ''
        inToken = false
        continue
      }
      if (ch === '#' && !inToken) break
      current += ch
      inToken = true
    }
    if (quote) throw new UsageError(`${CONFIG_NAME} line ${index + 1}: unclosed ${quote}`)
    if (inToken) tokens.push(current)
  })
  return tokens
}

/**
 * The tokens from a config file. A missing file at the default location is
 * simply no config; one named by `--config-location` must exist, since the
 * user said it did.
 */
export async function loadConfig(path: string, required: boolean): Promise<string[] | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new UsageError(`cannot read config ${path}: ${(error as Error).message}`)
  }
  return tokenizeConfig(text)
}

/**
 * Makes `dir` the cfg's `-P`, editing the file the way a person would: an
 * existing `-P` line is replaced, otherwise the new line goes under the
 * commented `# -P` example (or at the end). Every other line - comments,
 * blank lines, line endings - survives byte for byte.
 */
export function withConfigDir(text: string, dir: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.length ? text.split(/\r?\n/) : []
  // No escaping exists in the format, so pick the quote the path does not contain.
  const line = `-P ${dir.includes('"') ? `'${dir}'` : `"${dir}"`}`
  const isFlag = (token: string | undefined): boolean => token === '-P' || token === '--paths'
  const tokens = (l: string): string[] => { try { return tokenizeConfig(l) } catch { return [] } }
  const active = lines.findIndex(l => { const t = tokens(l); return t.length === 2 && isFlag(t[0]) })
  if (active >= 0) lines[active] = line
  else {
    const example = lines.findIndex(l => /^\s*#\s*(-P|--paths)\s/.test(l))
    if (example >= 0) lines.splice(example + 1, 0, line)
    else {
      // Keep the file's final newline where it was: insert before a trailing empty line.
      if (lines.length && lines[lines.length - 1] === '') lines.splice(lines.length - 1, 0, line)
      else lines.push(line, '')
    }
  }
  return lines.join(eol)
}

/** Writes `dir` into the cfg at `path` as its `-P`, creating the file if needed. Atomic, like the preferences. */
export async function setConfigDir(path: string, dir: string): Promise<void> {
  let text = ''
  try { text = await readFile(path, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, withConfigDir(text, dir), 'utf8')
  await rename(temporary, path)
}
