import { strictEqual, deepStrictEqual } from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const read = async (path: string): Promise<string> =>
  await readFile(join(root, path), 'utf8')

function* matches(source: string, re: RegExp): Generator<string> {
  for (const match of source.matchAll(re)) yield match[1]
}

/*
 * These are text-scans rather than imports on purpose: `src/main/ipc.ts`
 * imports Electron, which node --test cannot load. The scans pin the two
 * contracts that are otherwise only held together by hand:
 *
 *  1. Every channel the main process registers has a preload method that
 *     calls it, and vice versa - drift here surfaces as a renderer call that
 *     rejects with "No handler registered".
 *  2. Every channel main pushes has a preload subscription, and every
 *     subscription has a pusher.
 *
 * All channels are string literals at every call site, which is what makes the
 * scan exhaustive; the "every channel is a literal" assumption is checked by
 * the count assertions below.
 */

const ipcSource = await read('src/main/ipc.ts')
const indexSource = await read('src/main/index.ts')

const mainHandlers = new Set<string>([
  ...matches(ipcSource, /\bhandle\(\s*'([^']+)'/g),
  ...matches(ipcSource, /\bipcMain\.handle\(\s*'([^']+)'/g),
  ...matches(ipcSource, /\bipcMain\.on\(\s*'([^']+)'/g),
  ...matches(indexSource, /\bipcMain\.handle\(\s*'([^']+)'/g)
])

const preloadSource = await read('src/preload/index.ts')
const preloadCalls = new Set<string>([
  ...matches(preloadSource, /\bipcRenderer\.invoke\(\s*'([^']+)'/g),
  ...matches(preloadSource, /\bipcRenderer\.send\(\s*'([^']+)'/g)
])

const mainEmitters = new Set<string>()
for (const entry of await readdir(join(root, 'src/main'), { recursive: true })) {
  if (!entry.endsWith('.ts') || entry.endsWith('.d.ts')) continue
  const source = await read(join('src/main', entry.replaceAll('\\', '/')))
  for (const channel of matches(source, /\bbroadcast\(\s*'([^']+)'/g)) mainEmitters.add(channel)
  for (const channel of matches(source, /(?<![\w$.])send\(\s*'([^']+)'/g)) mainEmitters.add(channel)
  for (const channel of matches(source, /\bsendSplash\(\s*'([^']+)'/g)) mainEmitters.add(channel)
}

const preloadSubscriptions = new Set<string>(
  matches(preloadSource, /\bsubscribe(?:<[^>]*>)?\(\s*'([^']+)'/g)
)

const i18nSource = await read('src/renderer/src/i18n.ts')

describe('IPC surface parity', () => {
  it('scanned the expected number of channels', () => {
    // Guards the "everything is a literal" assumption: if drift turns these
    // into template strings, the parity checks below silently scan nothing.
    strictEqual(mainHandlers.size >= 70, true, `main handlers: ${mainHandlers.size}`)
    strictEqual(preloadCalls.size >= 70, true, `preload calls: ${preloadCalls.size}`)
    strictEqual(mainEmitters.size >= 10, true, `main emitters: ${mainEmitters.size}`)
    strictEqual(preloadSubscriptions.size >= 10, true, `preload subs: ${preloadSubscriptions.size}`)
  })

  it('every preload call has a main handler', () => {
    deepStrictEqual(
      [...preloadCalls].filter((channel) => !mainHandlers.has(channel)).sort(),
      [],
      'preload invokes a channel main never registered'
    )
  })

  it('every main handler has a preload call', () => {
    deepStrictEqual(
      [...mainHandlers].filter((channel) => !preloadCalls.has(channel)).sort(),
      [],
      'main registers a channel the renderer can never reach'
    )
  })

  it('every preload subscription has a main emitter', () => {
    deepStrictEqual(
      [...preloadSubscriptions].filter((channel) => !mainEmitters.has(channel)).sort(),
      [],
      'the renderer subscribes to a channel nothing broadcasts'
    )
  })

  it('every main emitter has a preload subscription', () => {
    deepStrictEqual(
      [...mainEmitters].filter((channel) => !preloadSubscriptions.has(channel)).sort(),
      [],
      'main pushes a channel the renderer never hears'
    )
  })
})

describe('i18n dictionary parity', () => {
  const source = i18nSource

  // The dictionaries are single flat object literals; keys start at two-space
  // indent and end before the value. `tr` is typed Record<Key, string>, so
  // TypeScript already enforces its half - this pins `en` against accidental
  // duplicates and pins both sets against each other even when tsc is skipped.
  const block = (name: string): string => {
    const start = source.indexOf(`const ${name} = {`)
    const end = source.indexOf('} as const', start)
    return source.slice(source.indexOf('{', start) + 1, end)
  }

  const keysOf = (blockText: string): string[] =>
    [...blockText.matchAll(/^  ([A-Za-z0-9_]+):/gm)].map((match) => match[1])

  const en = keysOf(block('en'))
  const tr = keysOf(block('tr'))

  it('en has no duplicate keys', () => {
    strictEqual(en.length, new Set(en).size)
  })

  it('tr has no duplicate keys', () => {
    strictEqual(tr.length, new Set(tr).size)
  })

  it('tr covers exactly the keys en has', () => {
    deepStrictEqual(tr.sort(), [...en].sort())
  })
})
