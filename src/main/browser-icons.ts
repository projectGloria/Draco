import { app } from 'electron'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { COOKIE_BROWSERS, type CookieBrowser } from './ytdlp-cookies.ts'
import { logger } from './log.ts'
import type { InstalledBrowser } from '../shared/types.ts'

const log = logger('browsers')

/**
 * Which browsers are actually on this machine, and what they look like.
 *
 * The cookie picker draws a button per browser, and both halves of that need
 * this. The icon is the browser's own, taken off its executable with the same
 * shell call `icons.ts` uses for file types - a real Firefox logo says "this
 * one" far faster than the word does, and drawing approximations of seven
 * browser logos by hand would be worse art and worse trademark manners.
 *
 * "Installed" is the more useful half. Reading cookies from a browser that is
 * not here fails several seconds later with a message about profiles, and there
 * is no reason to offer the button at all.
 */

/**
 * Where each browser puts its executable.
 *
 * Deliberately a fixed list rather than a PATH search or a registry walk: only
 * Firefox and Chromium tend to be on PATH at all, and `App Paths` would mean
 * spawning `reg.exe` seven times to learn something these four roots already
 * answer for every ordinary Windows install. A portable copy somewhere else is
 * missed, and the cost of that is a greyed-out button the user can still pick.
 */
const EXECUTABLES: Record<CookieBrowser, string[]> = {
  chrome: ['Google\\Chrome\\Application\\chrome.exe'],
  edge: ['Microsoft\\Edge\\Application\\msedge.exe'],
  brave: ['BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
  firefox: ['Mozilla Firefox\\firefox.exe'],
  chromium: ['Chromium\\Application\\chrome.exe'],
  opera: ['Opera\\opera.exe', 'Programs\\Opera\\opera.exe', 'Opera GX\\opera.exe'],
  vivaldi: ['Vivaldi\\Application\\vivaldi.exe']
}

const LABELS: Record<CookieBrowser, string> = {
  chrome: 'Chrome',
  edge: 'Edge',
  brave: 'Brave',
  firefox: 'Firefox',
  chromium: 'Chromium',
  opera: 'Opera',
  vivaldi: 'Vivaldi'
}

let cached: Promise<InstalledBrowser[]> | null = null

/** Resolved once per run: nothing here changes while the app is open. */
export function listBrowsers(): Promise<InstalledBrowser[]> {
  cached ??= Promise.all(COOKIE_BROWSERS.map(describe))
  return cached
}

async function describe(id: CookieBrowser): Promise<InstalledBrowser> {
  const path = await findExecutable(id)
  return {
    id,
    label: LABELS[id],
    installed: path !== null,
    icon: path ? await iconOf(path) : null
  }
}

function roots(): string[] {
  return [
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)'],
    process.env['LOCALAPPDATA'],
    process.env['LOCALAPPDATA'] ? join(process.env['LOCALAPPDATA'], 'Programs') : undefined
  ].filter((value): value is string => Boolean(value))
}

async function findExecutable(id: CookieBrowser): Promise<string | null> {
  for (const root of roots()) {
    for (const suffix of EXECUTABLES[id]) {
      const candidate = join(root, suffix)
      try {
        await access(candidate)
        return candidate
      } catch {
        // Not here; try the next root.
      }
    }
  }
  return null
}

async function iconOf(path: string): Promise<string | null> {
  try {
    const image = await app.getFileIcon(path, { size: 'normal' })
    return image.isEmpty() ? null : image.toDataURL()
  } catch (err) {
    log.warn(`no icon for ${path}: ${String(err)}`)
    return null
  }
}
