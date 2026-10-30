import { deepStrictEqual, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { addPathEntry, cliDirFor, hasPathEntry, parseRegQuery, removePathEntry } from '../src/main/cli-path.ts'

/**
 * The string side of putting `draco` on PATH. A bug here does not fail a
 * download - it quietly damages the user's PATH - so every other entry must
 * come back exactly as it went in.
 */

const DIR = 'C:\\Program Files\\Draco\\resources\\bin'

describe('cli PATH editing', () => {
  it('appends without touching unexpanded variables or other entries', () => {
    const before = '%USERPROFILE%\\.cargo\\bin;C:\\Tools;%LOCALAPPDATA%\\Microsoft\\WindowsApps'
    strictEqual(addPathEntry(before, DIR), `${before};${DIR}`)
  })

  it('is idempotent, whatever case or trailing slash the entry already has', () => {
    const before = `C:\\Tools;${DIR.toUpperCase()}\\`
    strictEqual(addPathEntry(before, DIR), before)
    strictEqual(hasPathEntry(`"${DIR}"`, DIR), true)
  })

  it('handles an empty or semicolon-terminated PATH', () => {
    strictEqual(addPathEntry('', DIR), DIR)
    strictEqual(addPathEntry('C:\\Tools;', DIR), `C:\\Tools;${DIR}`)
  })

  it('removes every spelling of our folder and nothing else', () => {
    const before = `C:\\Tools;${DIR};%X%\\y;${DIR.toLowerCase()}\\`
    strictEqual(removePathEntry(before, DIR), 'C:\\Tools;%X%\\y')
    strictEqual(removePathEntry('C:\\Tools;C:\\Program Files\\Draco\\resources\\binary', DIR),
      'C:\\Tools;C:\\Program Files\\Draco\\resources\\binary')
  })
})

describe('cli PATH registry parsing', () => {
  it('reads the raw value and keeps its type', () => {
    const out = '\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\bin;C:\\Program Files\\x\r\n\r\n'
    deepStrictEqual(parseRegQuery(out), { type: 'REG_EXPAND_SZ', value: '%USERPROFILE%\\bin;C:\\Program Files\\x' })
  })

  it('reads an empty value and a plain REG_SZ', () => {
    deepStrictEqual(parseRegQuery('    Path    REG_SZ    \r\n'), { type: 'REG_SZ', value: '' })
    deepStrictEqual(parseRegQuery('    Path    REG_SZ    C:\\a'), { type: 'REG_SZ', value: 'C:\\a' })
  })

  it('reports nothing when there is no Path value', () => {
    strictEqual(parseRegQuery('ERROR: The system was unable to find the specified registry key or value.'), null)
  })
})

describe('cliDirFor', () => {
  it('offers nothing for dev or portable copies, and says why', () => {
    strictEqual(cliDirFor({ isPackaged: false, resourcesPath: 'C:\\x', portable: false }).dir, null)
    const portable = cliDirFor({ isPackaged: true, resourcesPath: 'C:\\x', portable: true })
    strictEqual(portable.dir, null)
    strictEqual(typeof portable.reason, 'string')
  })

  it('refuses an install whose draco.cmd is missing', () => {
    strictEqual(cliDirFor({ isPackaged: true, resourcesPath: 'C:\\definitely\\not\\here', portable: false }).dir, null)
  })
})
