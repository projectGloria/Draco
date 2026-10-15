import { strictEqual, deepStrictEqual, ok } from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'

const root = resolve(import.meta.dirname, '..')

function event() {
  let listener: ((...args: any[]) => unknown) | null = null
  return {
    addListener(fn: (...args: any[]) => unknown) { listener = fn },
    get listener() { return listener }
  }
}

async function checkBackground(kind: 'chrome' | 'firefox'): Promise<void> {
  const onMessage = event()
  const onInstalled = event()
  const headerOptions: string[][] = []
  const menus: string[] = []
  const uiStates: boolean[] = []
  const simpleEvent = () => event()
  const webEvent = {
    addListener(_fn: unknown, _filter: unknown, options?: string[]) {
      if (options?.includes('extraHeaders') && kind === 'firefox') {
        throw new Error('Firefox does not support extraHeaders')
      }
      if (options) headerOptions.push(options)
    }
  }
  const api = {
    storage: {
      local: { get: async () => ({}), set: async () => {} },
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      onChanged: simpleEvent()
    },
    downloads: {
      onCreated: simpleEvent(),
      ...(kind === 'chrome' ? {
        setUiOptions: async ({ enabled }: { enabled: boolean }) => { uiStates.push(enabled) }
      } : {})
    },
    runtime: {
      onInstalled, onMessage,
      sendNativeMessage: async () => ({ ok: true, version: 'test' })
    },
    contextMenus: {
      onClicked: simpleEvent(),
      removeAll(callback?: () => void) {
        if (kind === 'firefox' && callback) throw new Error('Use Firefox promise API')
        callback?.()
        return Promise.resolve()
      },
      create(menu: { id: string }) { menus.push(menu.id) }
    },
    webRequest: {
      onBeforeRequest: webEvent,
      onBeforeSendHeaders: webEvent,
      onHeadersReceived: webEvent
    },
    tabs: {
      onRemoved: simpleEvent(), onUpdated: simpleEvent(), onActivated: simpleEvent(),
      query: async () => [], sendMessage: async () => {}
    },
    action: {
      setBadgeText: async () => {}, setIcon: async () => {}, setTitle: async () => {}
    }
  }
  const path = resolve(root, kind === 'firefox' ? 'extension-firefox' : 'extension', 'background.js')
  const source = await readFile(path, 'utf8')
  runInNewContext(source, {
    [kind === 'firefox' ? 'browser' : 'chrome']: api,
    URL, setTimeout, clearTimeout, navigator: { userAgent: 'test' }, console
  }, { filename: path })
  ok(onMessage.listener, `${kind} background must reach message registration`)
  deepStrictEqual(Array.from(headerOptions[0] ?? []), kind === 'firefox'
    ? ['requestHeaders']
    : ['requestHeaders', 'extraHeaders'])

  const state = await new Promise<any>((done) => {
    onMessage.listener!({ type: 'draco:page-state', force: true }, {
      tab: { id: 1, url: 'https://example.com/' }
    }, done)
  })
  strictEqual(state.active, true, `${kind} popup can reach native host through background`)
  if (kind === 'chrome') {
    strictEqual(uiStates.at(-1), false, 'hide the bubble before a download arrives')
    await new Promise<void>((done) => {
      onMessage.listener!({ type: 'draco:set-paused', paused: true }, {}, () => done())
    })
    strictEqual(uiStates.at(-1), true, 'restore the bubble when integration is paused')
    await new Promise<void>((done) => {
      onMessage.listener!({ type: 'draco:set-paused', paused: false }, {}, () => done())
    })
    strictEqual(uiStates.at(-1), false)
    api.runtime.sendNativeMessage = async () => ({ ok: false, version: 'test' })
    await new Promise<void>((done) => {
      onMessage.listener!({ type: 'draco:page-state', force: true }, {}, () => done())
    })
    strictEqual(uiStates.at(-1), true, 'restore the bubble when Draco goes offline')
  }
  onInstalled.listener!()
  await Promise.resolve()
  strictEqual(menus.length, 5, `${kind} context menus are installed`)
}

describe('browser extension startup', () => {
  it('requests UI control only in Chromium', async () => {
    const chromium = JSON.parse(await readFile(resolve(root, 'extension/manifest.json'), 'utf8'))
    const firefox = JSON.parse(await readFile(resolve(root, 'extension-firefox/manifest.json'), 'utf8'))
    ok(chromium.permissions.includes('downloads.ui'))
    ok(!firefox.permissions.includes('downloads.ui'))
  })
  it('registers and answers messages in Chromium', async () => checkBackground('chrome'))
  it('registers and answers messages in Firefox', async () => checkBackground('firefox'))

  it('keeps Firefox files derived from the shared extension without stale copies', async () => {
    for (const name of ['background.js', 'content.js', 'popup.js']) {
      const chromeSource = await readFile(resolve(root, 'extension', name), 'utf8')
      let expected = chromeSource.replace(/\bchrome\./g, 'browser.')
      if (name === 'background.js') {
        expected = expected
          .replace("['requestHeaders', 'extraHeaders']", "['requestHeaders']")
          .replace('browser.contextMenus.removeAll(() => {', 'browser.contextMenus.removeAll().then(() => {')
      }
      strictEqual(await readFile(resolve(root, 'extension-firefox', name), 'utf8'), expected, name)
    }
  })
})

describe('confirmation ownership', () => {
  it('releases filename selection once on timeout or storage failure', async () => {
    const source = await readFile(resolve(root, 'extension/background.js'), 'utf8')
    const start = source.indexOf('const downloadTakeovers = new Map()')
    const end = source.indexOf('async function takeOverDownload(item)', start)
    ok(start >= 0 && end > start)
    for (const failStorage of [false, true]) {
      const onCreated = event()
      const onDeterminingFilename = event()
      const timers = new Map<number, () => void>()
      let nextTimer = 0
      let suggestions = 0
      runInNewContext(source.slice(start, end), {
        chrome: {
          downloads: { onCreated, onDeterminingFilename },
          storage: { local: { get: async () => {
            if (failStorage) throw new Error('storage unavailable')
            return { 'dracoHandoff:7': { stage: 'pending' } }
          } } }
        },
        PENDING_PREFIX: 'dracoHandoff:',
        takeOverDownload: async () => {},
        setTimeout: (callback: () => void) => {
          const id = ++nextTimer
          timers.set(id, callback)
          return id
        },
        clearTimeout: (id: number) => timers.delete(id),
        console: { warn: () => {} }
      })
      strictEqual(onDeterminingFilename.listener!({ id: 7 }, () => suggestions++), true)
      await new Promise((done) => setImmediate(done))
      if (!failStorage) {
        strictEqual(suggestions, 0)
        timers.get(1)!()
        strictEqual(suggestions, 1, 'a pending confirmation must not hold the browser forever')
        timers.get(2)!()
        await new Promise((done) => setImmediate(done))
      }
      strictEqual(suggestions, 1)
      ok(!timers.has(1), 'clear the deadline after release')
    }
  })

  it('records a browser item before pausing so a worker crash can release it', async () => {
    const source = await readFile(resolve(root, 'extension', 'background.js'), 'utf8')
    const stored: Record<string, any> = {}
    const onCreated = event()
    const actions: string[] = []
    const noop = event()
    const api = {
      storage: {
        local: {
          get: async (key: string | null) => key === null ? { ...stored } : { [key]: stored[key] },
          set: async (items: Record<string, any>) => Object.assign(stored, items),
          remove: async (key: string) => { delete stored[key] }
        },
        session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        onChanged: noop
      },
      downloads: {
        onCreated,
        pause: async () => { actions.push('pause'); await new Promise(() => {}) },
        search: async () => [{ state: 'in_progress', paused: true }],
        resume: async () => { actions.push('resume') }
      },
      runtime: {
        onInstalled: noop, onMessage: noop,
        sendNativeMessage: async () => ({ ok: true, pending: false })
      },
      contextMenus: { onClicked: noop, removeAll: (cb: () => void) => cb(), create: () => {} },
      webRequest: {
        onBeforeRequest: { addListener: () => {} },
        onBeforeSendHeaders: { addListener: () => {} },
        onHeadersReceived: { addListener: () => {} }
      },
      tabs: { onRemoved: noop, onUpdated: noop, onActivated: noop, query: async () => [], sendMessage: async () => {} },
      action: { setBadgeText: async () => {}, setIcon: async () => {}, setTitle: async () => {} }
    }
    const context = { chrome: api, URL, setTimeout: () => 0, clearTimeout: () => {},
      navigator: { userAgent: 'test' }, console }
    runInNewContext(source, { ...context })
    void onCreated.listener!({ id: 7, tabId: -1, url: 'https://example.com/file.bin',
      filename: 'file.bin', totalBytes: 2_000_000 })
    await new Promise((done) => setImmediate(done))
    strictEqual(actions[0], 'pause')
    strictEqual(stored['dracoHandoff:7']?.stage, 'preparing')

    // Simulate service-worker eviction during pause, then restart after grace.
    stored['dracoHandoff:7'].preparingUntil = Date.now() - 1
    runInNewContext(source, { ...context })
    await new Promise((done) => setImmediate(done))
    deepStrictEqual(actions, ['pause', 'resume'])
    strictEqual(stored['dracoHandoff:7'], undefined)

    api.storage.local.set = async () => { throw new Error('storage unavailable') }
    runInNewContext(source, { ...context })
    await onCreated.listener!({ id: 8, tabId: -1, url: 'https://example.com/other.bin',
      filename: 'other.bin', totalBytes: 2_000_000 })
    deepStrictEqual(actions, ['pause', 'resume'], 'a failed recovery write must not pause another item')
  })

  for (const decision of ['accepted', 'dismissed'] as const) {
    it(`${decision} confirmation ${decision === 'accepted' ? 'cancels' : 'resumes'} the browser item`, async () => {
      const source = await readFile(resolve(root, 'extension', 'background.js'), 'utf8')
      const onCreated = event()
      const onDeterminingFilename = event()
      const stored: Record<string, any> = {}
      const actions: string[] = []
      const hostMessages: string[] = []
      const noop = event()
      const api = {
        storage: {
          local: {
            get: async (key: string | null) => key === null ? { ...stored } : { [key]: stored[key] },
            set: async (items: Record<string, any>) => Object.assign(stored, items),
            remove: async (key: string) => { delete stored[key] }
          },
          session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
          onChanged: noop
        },
        downloads: {
          onCreated,
          onDeterminingFilename,
          pause: async () => { actions.push('pause') },
          resume: async () => { actions.push('resume') },
          cancel: async () => { actions.push('cancel') },
          erase: async () => { actions.push('erase') },
          search: async () => [{ state: 'in_progress', paused: true }]
        },
        runtime: {
          onInstalled: noop, onMessage: noop,
          sendNativeMessage: async (_host: string, message: any) => {
            hostMessages.push(message.type)
            if (message.type === 'config') return { ok: true, config: { enabled: true, minSize: 0, extensions: [], excludeHosts: [] } }
            if (message.type === 'download') return { ok: true, pending: true, handoffId: 'handoff-1' }
            if (message.type === 'handoffStatus') return decision === 'accepted'
              ? { ok: true, taken: true }
              : { ok: true, pending: false }
            return { ok: true, version: 'test' }
          }
        },
        contextMenus: { onClicked: noop, removeAll: (cb: () => void) => cb(), create: () => {} },
        webRequest: {
          onBeforeRequest: { addListener: () => {} },
          onBeforeSendHeaders: { addListener: () => {} },
          onHeadersReceived: { addListener: () => {} }
        },
        tabs: { onRemoved: noop, onUpdated: noop, onActivated: noop, query: async () => [], sendMessage: async () => {} },
        action: { setBadgeText: async () => {}, setIcon: async () => {}, setTitle: async () => {} },
        cookies: { getAll: async () => [] }
      }
      runInNewContext(source, {
        chrome: api, URL, setTimeout, clearTimeout,
        navigator: { userAgent: 'test' }, console
      })
      const item = { id: 7, tabId: -1, url: 'https://example.com/file.bin', filename: 'file.bin', totalBytes: 2_000_000 }
      const takeover = onCreated.listener!(item)
      let suggestions = 0
      const released = new Promise<void>((done) => {
        strictEqual(onDeterminingFilename.listener!(item, () => {
          suggestions++
          strictEqual(actions.at(-1), decision === 'accepted' ? 'erase' : 'resume')
          done()
        }), true, 'keep filename determination open during the handoff')
      })
      strictEqual(suggestions, 0, 'do not open Save As while ownership is undecided')
      await takeover
      await released
      strictEqual(suggestions, 1)
      await new Promise((done) => setImmediate(done))
      deepStrictEqual(actions, decision === 'accepted' ? ['pause', 'cancel', 'erase'] : ['pause', 'resume'])
      ok(hostMessages.includes('handoffStatus'))
      strictEqual(stored['dracoHandoff:7'], undefined)
    })
  }


  it('releases an expired paused item after the extension worker restarts', async () => {
    const source = await readFile(resolve(root, 'extension', 'background.js'), 'utf8')
    const record = { downloadId: 7, handoffId: 'handoff-1', deadline: Date.now() - 1, stage: 'requesting' }
    const stored: Record<string, any> = { 'dracoHandoff:7': record }
    const actions: string[] = []
    const hostMessages: string[] = []
    const noop = event()
    const api = {
      storage: {
        local: {
          get: async (key: string | null) => key === null ? { ...stored } : { [key]: stored[key] },
          set: async (items: Record<string, any>) => Object.assign(stored, items),
          remove: async (key: string) => { delete stored[key] }
        },
        session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        onChanged: noop
      },
      downloads: {
        onCreated: noop,
        search: async () => [{ state: 'in_progress', paused: true }],
        resume: async () => { actions.push('resume') }
      },
      runtime: {
        onInstalled: noop, onMessage: noop,
        sendNativeMessage: async (_host: string, message: any) => {
          hostMessages.push(message.type)
          return message.type === 'handoffCancel'
            ? { ok: true, taken: false }
            : { ok: true, version: 'test' }
        }
      },
      contextMenus: { onClicked: noop, removeAll: (cb: () => void) => cb(), create: () => {} },
      webRequest: {
        onBeforeRequest: { addListener: () => {} },
        onBeforeSendHeaders: { addListener: () => {} },
        onHeadersReceived: { addListener: () => {} }
      },
      tabs: { onRemoved: noop, onUpdated: noop, onActivated: noop, query: async () => [], sendMessage: async () => {} },
      action: { setBadgeText: async () => {}, setIcon: async () => {}, setTitle: async () => {} }
    }
    runInNewContext(source, {
      chrome: api, URL, setTimeout: () => 0, clearTimeout: () => {},
      navigator: { userAgent: 'test' }, console
    })
    await new Promise((done) => setImmediate(done))
    deepStrictEqual(actions, ['resume'])
    ok(hostMessages.includes('handoffCancel'))
    strictEqual(stored['dracoHandoff:7'], undefined)

    stored['dracoHandoff:7'] = { ...record, deadline: Date.now() + 60_000 }
    api.downloads.search = async () => [{ state: 'complete', paused: false }]
    runInNewContext(source, {
      chrome: api, URL, setTimeout: () => 0, clearTimeout: () => {},
      navigator: { userAgent: 'test' }, console
    })
    await new Promise((done) => setImmediate(done))
    deepStrictEqual(actions, ['resume'])
    strictEqual(stored['dracoHandoff:7'], undefined)
    strictEqual(hostMessages.filter((type) => type === 'handoffCancel').length, 2)

    stored['dracoHandoff:7'] = { ...record, stage: 'pending' }
    api.downloads.search = async () => [{ state: 'in_progress', paused: true }]
    api.runtime.sendNativeMessage = async () => { throw new Error('native host disconnected') }
    runInNewContext(source, {
      chrome: api, URL, setTimeout: () => 0, clearTimeout: () => {},
      navigator: { userAgent: 'test' }, console
    })
    await new Promise((done) => setImmediate(done))
    deepStrictEqual(actions, ['resume', 'resume'])
    strictEqual(stored['dracoHandoff:7'], undefined)
  })
})
