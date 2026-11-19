import { deepStrictEqual, strictEqual } from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  applyOptionsDraftPatch,
  createOptionsDraft,
  isOptionsDraftDirty,
  toggleDraftColumn
} from '../src/shared/options-draft.ts'
import type { Settings } from '../src/shared/types.ts'

function baseSettings(): Settings {
  return {
    language: 'en',
    theme: 'dark',
    downloadDir: 'C:\\Downloads',
    checkDiskSpace: true,
    completionSound: true,
    catMode: false,
    maxConcurrentTasks: 3,
    exponentialBackoff: true,
    maxConnectionsPerTask: 8,
    adaptiveConnectionCeiling: null,
    minSplitSize: 1024 * 1024,
    speedLimit: null,
    scheduledLimit: null,
    seedTorrents: true,
    seedRatioLimit: 2,
    seedTimeMinutes: null,
    uploadLimit: null,
    proxyUrl: null,
    cookiesFromBrowser: 'none',
    hostConnectionLimits: [],
    quotaBytes: null,
    quotaWindowMinutes: 60,
    antivirusProgram: null,
    antivirusArgs: ['{file}'],
    antivirusTimeoutSeconds: 120,
    updateFeedUrl: null,
    autoCheckUpdates: true,
    retryLimit: 5,
    timeoutMs: 30_000,
    defaultCategoryId: null,
    confirmDelete: true,
    closeToTray: true,
    startMinimized: false,
    takeoverEnabled: true,
    confirmHandoff: true,
    takeoverMinSize: 1024 * 1024,
    takeoverExtensions: [],
    takeoverExcludeHosts: [],
    watchClipboard: true,
    associateTorrents: true,
    cliOnPath: true,
    showDropzone: false,
    showProgressWindow: true,
    accent: '#38bdf8',
    columns: [
      { id: 'name', width: 320, visible: true },
      { id: 'size', width: 90, visible: true },
      { id: 'queue', width: 100, visible: false }
    ],
    sortColumn: 'added',
    sortDirection: 'desc',
    sidebarSelection: 'all'
  }
}

describe('OptionsDialog draft transaction (F-11 / D4)', () => {
  it('combines Appearance, Columns, Cookies, and General edits into one Save/Cancel transaction', () => {
    const initial = baseSettings()
    let state = createOptionsDraft(initial)
    strictEqual(isOptionsDraftDirty(state), false)

    // Appearance edits (theme + accent)
    state = applyOptionsDraftPatch(state, { theme: 'light', accent: '#a855f7' })
    // Column toggle edit
    state = applyOptionsDraftPatch(state, { columns: toggleDraftColumn(state.draft.columns, 'queue') })
    // Cookies edit
    state = applyOptionsDraftPatch(state, { cookiesFromBrowser: 'chrome' })
    // General edit
    state = applyOptionsDraftPatch(state, { catMode: true })

    strictEqual(isOptionsDraftDirty(state), true)
    // Original live settings remain untouched until Save
    strictEqual(initial.theme, 'dark')
    strictEqual(initial.accent, '#38bdf8')
    strictEqual(initial.cookiesFromBrowser, 'none')
    strictEqual(initial.columns.find((c) => c.id === 'queue')?.visible, false)

    // Save payload contains all four tab edits together (no stale overwrite)
    strictEqual(state.changes.theme, 'light')
    strictEqual(state.changes.accent, '#a855f7')
    strictEqual(state.changes.cookiesFromBrowser, 'chrome')
    strictEqual(state.changes.catMode, true)
    strictEqual(state.changes.columns?.find((c) => c.id === 'queue')?.visible, true)

    // Name column cannot be toggled off
    const afterNameToggle = toggleDraftColumn(state.draft.columns, 'name')
    strictEqual(afterNameToggle.find((c) => c.id === 'name')?.visible, true)

    // Reverting every edit back to original clears dirty state
    state = applyOptionsDraftPatch(state, {
      theme: 'dark',
      accent: '#38bdf8',
      cookiesFromBrowser: 'none',
      catMode: false,
      columns: toggleDraftColumn(state.draft.columns, 'queue')
    })
    strictEqual(isOptionsDraftDirty(state), false)
    deepStrictEqual(state.changes, {})
  })

  it('OptionsDialog tabs do not bypass the draft transaction via live store patchSettings or toggleColumn', () => {
    const source = readFileSync(new URL('../src/renderer/src/components/OptionsDialog.tsx', import.meta.url), 'utf8')
    const patchMatches = source.match(/useApp\(\s*\(?s\)?\s*=>\s*s\.patchSettings\s*\)/g) ?? []
    strictEqual(patchMatches.length, 1, 'only the root OptionsDialog may bind patchSettings')
    const toggleMatches = source.match(/toggleColumn/g) ?? []
    strictEqual(toggleMatches.length, 0, 'ColumnToggles must not call live store toggleColumn directly')
  })
})
