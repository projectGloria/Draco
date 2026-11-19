import type { ColumnPref, Settings } from './types.ts'

export interface OptionsDraftState {
  original: Settings
  draft: Settings
  changes: Partial<Settings>
}

export function createOptionsDraft(initial: Settings): OptionsDraftState {
  return { original: initial, draft: initial, changes: {} }
}

/**
 * Applies a partial patch into the Options dialog draft transaction.
 * Keys reverted back to their original value are pruned from `changes` so the
 * dialog's dirty indicator stays accurate.
 */
export function applyOptionsDraftPatch(
  state: OptionsDraftState,
  patch: Partial<Settings>
): OptionsDraftState {
  const draft: Settings = { ...state.draft, ...patch }
  const changes: Partial<Settings> = { ...state.changes, ...patch }
  for (const key of Object.keys(patch) as Array<keyof Settings>) {
    if (JSON.stringify(changes[key]) === JSON.stringify(state.original[key])) {
      delete changes[key]
    }
  }
  return { original: state.original, draft, changes }
}

export function toggleDraftColumn(columns: ColumnPref[], id: ColumnPref['id']): ColumnPref[] {
  if (id === 'name') return columns
  return columns.map((col) => (col.id === id ? { ...col, visible: !col.visible } : col))
}

export function isOptionsDraftDirty(state: OptionsDraftState): boolean {
  return Object.keys(state.changes).length > 0
}
