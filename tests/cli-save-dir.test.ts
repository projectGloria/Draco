import { deepStrictEqual } from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { resolveSaveDir } from '../src/cli/save-dir.ts'

/** Windows-shaped inputs, resolved against whatever this machine calls an absolute path. */
const home = resolve('/Users/Nihil')
const win = { home, platform: 'win32', windir: resolve('/Windows') }

describe('where downloads go', () => {
  it('downloads into the folder Draco was started from', () => {
    const here = join(home, 'Desktop', 'a')
    deepStrictEqual(resolveSaveDir({ ...win, cliDir: null, cfgDir: 'D:\\Videos', cwd: here }), { dir: here, source: 'here' })
  })

  it('falls back to the cfg -P, then Downloads, when started from home', () => {
    deepStrictEqual(resolveSaveDir({ ...win, cliDir: null, cfgDir: resolve('/Videos'), cwd: home }), { dir: resolve('/Videos'), source: 'config' })
    deepStrictEqual(resolveSaveDir({ ...win, cliDir: null, cfgDir: null, cwd: home }), { dir: join(home, 'Downloads'), source: 'default' })
  })

  it('treats home with different casing or a trailing slash as home on Windows', () => {
    deepStrictEqual(resolveSaveDir({ ...win, cliDir: null, cfgDir: null, cwd: home.toUpperCase() + '\\' }).source, 'default')
  })

  it('treats System32 and Draco\'s own folder as "nowhere in particular"', () => {
    deepStrictEqual(resolveSaveDir({ ...win, cliDir: null, cfgDir: null, cwd: join(win.windir, 'System32') }).source, 'default')
    const install = resolve('/Programs/Draco')
    deepStrictEqual(resolveSaveDir({ ...win, cliDir: null, cfgDir: null, cwd: install, ignore: [install] }).source, 'default')
  })

  it('lets a typed -P beat everything', () => {
    deepStrictEqual(resolveSaveDir({ ...win, cliDir: resolve('/X'), cfgDir: resolve('/Videos'), cwd: join(home, 'Desktop') }), { dir: resolve('/X'), source: 'typed' })
  })
})
