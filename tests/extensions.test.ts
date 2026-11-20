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

describe('link interception security and fallback (F-01 / F-04)', () => {
  async function loadContentScript(opts: {
    active: boolean
    linkReply?: unknown
  }) {
    const source = await readFile(resolve(root, 'extension', 'content.js'), 'utf8')
    const listeners = new Map<string, Array<(event: any) => void>>()
    const sentMessages: any[] = []
    const onMessage = event()
    let windowOpenCalls = 0
    const location = { href: 'https://app.example.com/dashboard', hostname: 'app.example.com', pathname: '/dashboard', search: '' }

    class FakeAnchor {
      href: string
      target: string
      private attrs: Map<string, string>
      clicks = 0
      constructor(href: string, download?: string | null, target = '') {
        this.href = href
        this.target = target
        this.attrs = new Map()
        if (download !== undefined && download !== null) this.attrs.set('download', download)
      }
      hasAttribute(name: string) { return this.attrs.has(name) }
      getAttribute(name: string) { return this.attrs.has(name) ? this.attrs.get(name)! : null }
      click() {
        this.clicks++
        // Simulate browser dispatching a synthetic (untrusted) click event
        const synthetic = makeClickEvent(this, { isTrusted: false })
        for (const fn of listeners.get('click') ?? []) fn(synthetic)
      }
    }

    function makeClickEvent(anchor: FakeAnchor, overrides: Record<string, any> = {}) {
      const ev = {
        isTrusted: true,
        defaultPrevented: false,
        stopped: false,
        button: 0,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        composedPath: () => [anchor],
        preventDefault() { this.defaultPrevented = true },
        stopPropagation() { this.stopped = true },
        ...overrides
      }
      return ev
    }

    const chromeApi = {
      runtime: {
        id: 'draco-test-id',
        onMessage,
        getURL: (p: string) => `chrome-extension://draco-test-id/${p}`,
        sendMessage: async (msg: any) => {
          sentMessages.push(msg)
          if (msg.type === 'draco:page-state') {
            return { running: opts.active, paused: false, active: opts.active, excluded: false }
          }
          if (msg.type === 'draco:list-media') return { media: [] }
          if (msg.type === 'draco:link-click') return opts.linkReply ?? { taken: false }
          return { ok: true }
        }
      },
      storage: { local: { get: async () => ({}), set: async () => {} } }
    }

    const timers: Array<ReturnType<typeof setTimeout>> = []
    const ctx: Record<string, any> = {
      chrome: chromeApi,
      URL,
      URLSearchParams,
      console,
      navigator: { userAgent: 'test' },
      location,
      HTMLAnchorElement: FakeAnchor,
      HTMLAudioElement: class {},
      MutationObserver: class { observe() {} disconnect() {} },
      requestAnimationFrame: () => 0,
      setInterval: () => 0,
      clearInterval: () => {},
      setTimeout: (fn: () => void, ms?: number) => {
        const t = setTimeout(fn, ms)
        timers.push(t)
        return t
      },
      clearTimeout,
      addEventListener: (type: string, fn: (e: any) => void) => {
        const list = listeners.get(type) ?? []
        list.push(fn)
        listeners.set(type, list)
      },
      removeEventListener: () => {},
      document: {
        documentElement: {},
        visibilityState: 'visible',
        fullscreenElement: null,
        querySelectorAll: () => [],
        addEventListener: () => {},
        removeEventListener: () => {}
      },
      window: null as any
    }
    ctx.window = ctx
    ctx.top = ctx
    ctx.window.open = () => { windowOpenCalls++; return null }

    runInNewContext(source, ctx, { filename: resolve(root, 'extension', 'content.js') })
    // Let initial refreshDracoState settle
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    return {
      FakeAnchor,
      makeClickEvent,
      dispatchClick(ev: any) {
        for (const fn of listeners.get('click') ?? []) fn(ev)
      },
      sentMessages,
      location,
      getWindowOpenCalls: () => windowOpenCalls,
      cleanup: () => { for (const t of timers) clearTimeout(t) }
    }
  }

  it('ignores untrusted synthetic clicks without preventing default or messaging background (F-01)', async () => {
    const env = await loadContentScript({ active: true })
    try {
      const anchor = new env.FakeAnchor('https://victim.example/backup.zip', 'backup.zip')
      const ev = env.makeClickEvent(anchor, { isTrusted: false })
      env.dispatchClick(ev)
      await new Promise((r) => setImmediate(r))
      strictEqual(ev.defaultPrevented, false, 'untrusted click must not call preventDefault')
      strictEqual(ev.stopped, false, 'untrusted click must not call stopPropagation')
      strictEqual(
        env.sentMessages.filter((m) => m.type === 'draco:link-click').length,
        0,
        'untrusted click must not trigger draco:link-click'
      )
    } finally {
      env.cleanup()
    }
  })

  it('does not call preventDefault or intercept when Draco is inactive (F-04)', async () => {
    const env = await loadContentScript({ active: false })
    try {
      const anchor = new env.FakeAnchor('https://app.example.com/raw/data.json', 'data.json')
      const ev = env.makeClickEvent(anchor, { isTrusted: true })
      env.dispatchClick(ev)
      await new Promise((r) => setImmediate(r))
      strictEqual(ev.defaultPrevented, false, 'inactive state must not call preventDefault')
      strictEqual(
        env.sentMessages.filter((m) => m.type === 'draco:link-click').length,
        0,
        'inactive state must not send draco:link-click'
      )
    } finally {
      env.cleanup()
    }
  })

  it('replays declined <a download> links via anchor.click() without navigating away (F-04)', async () => {
    const env = await loadContentScript({ active: true, linkReply: { taken: false } })
    try {
      const startHref = env.location.href
      const anchor = new env.FakeAnchor('https://app.example.com/raw/data.json', 'data.json')
      const ev = env.makeClickEvent(anchor, { isTrusted: true })
      env.dispatchClick(ev)
      await new Promise((r) => setTimeout(r, 20))
      strictEqual(ev.defaultPrevented, true)
      strictEqual(anchor.clicks, 1, 'declined <a download> should replay via anchor.click()')
      strictEqual(env.location.href, startHref, 'must not navigate away by assigning location.href')
      strictEqual(
        env.sentMessages.filter((m) => m.type === 'draco:link-click').length,
        1,
        'replayed synthetic click must not re-enter the interception handler'
      )
    } finally {
      env.cleanup()
    }
  })

  it('replays declined target="_blank" links as a background-opened tab, not a forced download (F-04)', async () => {
    const env = await loadContentScript({ active: true, linkReply: { taken: false } })
    try {
      const anchor = new env.FakeAnchor('https://files.example.com/manual.pdf', null, '_blank')
      const ev = env.makeClickEvent(anchor, { isTrusted: true })
      env.dispatchClick(ev)
      await new Promise((r) => setTimeout(r, 20))
      strictEqual(env.getWindowOpenCalls(), 0, 'must not rely on popup-blocked window.open')
      strictEqual(
        env.sentMessages.filter((m) => m.type === 'draco:fallback-download').length,
        0,
        'a viewable link must not be force-downloaded'
      )
      const opened = env.sentMessages.filter((m) => m.type === 'draco:fallback-open-tab')
      strictEqual(opened.length, 1, 'should ask background to open the link in a new tab')
      strictEqual(opened[0].url, 'https://files.example.com/manual.pdf')
    } finally {
      env.cleanup()
    }
  })

  it('filters SameSite cookies on draco:link-click by site and frameId (F-01 / D2)', async () => {
    const source = await readFile(resolve(root, 'extension', 'background.js'), 'utf8')
    const onMessage = event()
    const noop = event()
    const hostPayloads: any[] = []
    const cookiesByUrl: Record<string, Array<{ name: string; value: string; sameSite?: string }>> = {
      'https://victim.example/backup.zip': [
        { name: 'strict_tok', value: 'S', sameSite: 'strict' },
        { name: 'lax_tok', value: 'L', sameSite: 'lax' },
        { name: 'unspec_tok', value: 'U', sameSite: 'unspecified' },
        { name: 'none_tok', value: 'N', sameSite: 'no_restriction' }
      ],
      'https://cdn.example.com/archive.zip': [
        { name: 'strict_tok', value: 'S', sameSite: 'strict' },
        { name: 'lax_tok', value: 'L', sameSite: 'lax' },
        { name: 'none_tok', value: 'N', sameSite: 'no_restriction' }
      ],
      'https://bank.co.uk/statement.pdf': [
        { name: 'strict_tok', value: 'S', sameSite: 'strict' },
        { name: 'lax_tok', value: 'L', sameSite: 'lax' }
      ]
    }
    const api = {
      storage: {
        local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        onChanged: noop
      },
      downloads: { onCreated: noop, download: async () => 1 },
      runtime: {
        onInstalled: noop,
        onMessage,
        sendNativeMessage: async (_host: string, message: any) => {
          if (message.type === 'config') return { ok: true, config: { enabled: true, minSize: 0, extensions: [], excludeHosts: [] } }
          if (message.type === 'download') {
            hostPayloads.push(message)
            return { ok: true, taken: true }
          }
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
      cookies: { getAll: async ({ url }: { url: string }) => cookiesByUrl[url] ?? [] }
    }
    runInNewContext(source, { chrome: api, URL, setTimeout, clearTimeout, navigator: { userAgent: 'test' }, console })

    const send = (url: string, sender: any) =>
      new Promise<any>((done) => onMessage.listener!({ type: 'draco:link-click', url }, sender, done))

    // 1. Cross-site top-frame click: omit strict, keep lax/unspecified/no_restriction
    await send('https://victim.example/backup.zip', {
      frameId: 0,
      url: 'https://evil.example/page',
      tab: { id: 1, url: 'https://evil.example/page' }
    })
    strictEqual(hostPayloads.at(-1).cookie, 'lax_tok=L; unspec_tok=U; none_tok=N')

    // 2. Cross-site subframe click: omit strict, lax, and unspecified; keep only no_restriction
    await send('https://victim.example/backup.zip', {
      frameId: 42,
      url: 'https://ad.tracker.example/frame',
      tab: { id: 2, url: 'https://news.example/article' }
    })
    strictEqual(hostPayloads.at(-1).cookie, 'none_tok=N')

    // 3. Same-site subdomain click (top frame): keep strict, lax, no_restriction
    await send('https://cdn.example.com/archive.zip', {
      frameId: 0,
      url: 'https://www.example.com/downloads',
      tab: { id: 3, url: 'https://www.example.com/downloads' }
    })
    strictEqual(hostPayloads.at(-1).cookie, 'strict_tok=S; lax_tok=L; none_tok=N')

    // 4. Multi-part public suffix cross-site (evil.co.uk -> bank.co.uk): omit strict
    await send('https://bank.co.uk/statement.pdf', {
      frameId: 0,
      url: 'https://evil.co.uk/phish',
      tab: { id: 4, url: 'https://evil.co.uk/phish' }
    })
    strictEqual(hostPayloads.at(-1).cookie, 'lax_tok=L')
  })

  it('draco:send-media accepts both /i/web/status/<id> and /i/status/<id> URLs (F-07d)', async () => {
    const source = await readFile(resolve(root, 'extension', 'background.js'), 'utf8')
    const onMessage = event()
    const noop = event()
    const mediaPayloads: any[] = []
    const api = {
      storage: {
        local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        onChanged: noop
      },
      downloads: { onCreated: noop },
      runtime: {
        onInstalled: noop,
        onMessage,
        sendNativeMessage: async (_host: string, message: any) => {
          if (message.type === 'media') mediaPayloads.push(message)
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
    runInNewContext(source, { chrome: api, URL, setTimeout, clearTimeout, navigator: { userAgent: 'test' }, console })

    for (const url of ['https://x.com/i/web/status/1234567890?s=20', 'https://x.com/i/status/9876543210']) {
      const reply = await new Promise<any>((done) =>
        onMessage.listener!({ type: 'draco:send-media', mediaUrl: url }, { tab: { id: 1, url } }, done)
      )
      strictEqual(reply.ok, true, `expected ok for ${url}, got ${JSON.stringify(reply)}`)
    }
    strictEqual(mediaPayloads.length, 2)
    strictEqual(mediaPayloads[0].pageUrl, 'https://x.com/i/web/status/1234567890')
    strictEqual(mediaPayloads[1].pageUrl, 'https://x.com/i/status/9876543210')
  })
})
