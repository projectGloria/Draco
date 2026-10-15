import { deepStrictEqual, strictEqual } from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
import { it } from 'node:test'

function fixture(fail: string, hold?: Promise<void>) {
  const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const code = stripTypeScriptTypes(
    source.slice(source.indexOf('let bootstrapWork:'), source.indexOf('function finish():')) +
    source.slice(source.indexOf('async function runStep('), source.indexOf('function publish():'))
  )
  const steps = ['appdata', 'settings', 'restore', 'bridge', 'integration']
  const state = { steps: steps.map((id) => ({ id, status: 'pending', detail: null })), error: null as any, done: false, overall: 0 }
  const calls: string[] = []
  const work = async (name: string) => { calls.push(name); if (name === fail) throw new Error('cannot read saved state'); if (name === 'settings' && hold) await hold }
  const ctx = {
    manager: { restoreQuota() {}, async load() { await work('manager.load') } },
    pendingHandoffs: [], browserInbox: { async load() { return [] } },
    scheduler: { load() {} }, siteProjects: { async start() {} }, media: [], clipboardItems: [],
    pipe: { async start() {} }
  }
  const api = runInNewContext(code + '\n({ runBootstrap })', {
    ctx, state, finished: false, initialRestoreDone: false,
    ensureDirs: () => { calls.push('appdata'); return {} }, getPaths: () => ({}),
    setLogDirectory() {}, setTorrentStoreDir() {},
    ensureElectronJsonCipherReady: () => work('settings'), loadSettings: async () => {},
    loadCredentials: async () => {}, loadQuotaState: async () => null, loadCategories: async () => {},
    loadTasks: async () => { await work('restore'); return [] }, loadQueues: async () => [], loadClipboardItems: async () => [],
    restoredHandoffsAwaitingStatus: new Set(), ensurePipeSecret: async () => { await work('bridge'); return 'secret' },
    smokeBridgeRequested: true, publish() {}, finish: () => calls.push('finish'),
    log: { error() {}, warn() {} }
  })
  return { api, state, calls }
}

it('does not restore or start integration after secure settings fail', async () => {
  const f = fixture('settings')
  await f.api.runBootstrap()
  deepStrictEqual(f.calls, ['appdata', 'settings'])
  strictEqual(f.state.error.step, 'settings')
  strictEqual(f.state.error.canContinue, false)
})

it('does not allow an empty manager to replace tasks after restoration fails', async () => {
  const f = fixture('restore')
  await f.api.runBootstrap()
  deepStrictEqual(f.calls, ['appdata', 'settings', 'restore'])
  strictEqual(f.state.error.step, 'restore')
  strictEqual(f.state.error.canContinue, false)
})

it('shares concurrent retries instead of loading state twice', async () => {
  let release!: () => void
  const f = fixture('', new Promise<void>((resolve) => { release = resolve }))
  const one = f.api.runBootstrap()
  const two = f.api.runBootstrap()
  strictEqual(one, two)
  release()
  await one
  strictEqual(f.calls.filter((name) => name === 'restore').length, 1)
  strictEqual(f.calls.filter((name) => name === 'finish').length, 1)
})
