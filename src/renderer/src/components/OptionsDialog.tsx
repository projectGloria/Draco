import { useEffect, useState } from 'react'
import type { Category } from '@shared/types'
import { formatBytes, formatWhen } from '../lib/format'
import { useApp } from '../store/app'
import { reportError, toast } from '../store/toasts'
import Dialog, { GhostButton, PrimaryButton } from './Dialog'
import { CopyIcon, FolderIcon, PlusIcon, RefreshIcon, TrashIcon } from './Icons'
import Toggle from './Toggle'

type Tab = 'general' | 'connection' | 'categories' | 'browser' | 'appearance'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'connection', label: 'Connection' },
  { id: 'categories', label: 'Categories' },
  { id: 'browser', label: 'Browser' },
  { id: 'appearance', label: 'Appearance' }
]

export default function OptionsDialog({ onClose }: { onClose(): void }): React.ReactElement {
  const [tab, setTab] = useState<Tab>('general')

  return (
    <Dialog
      title="Options"
      width={680}
      onClose={onClose}
      footer={<PrimaryButton onClick={onClose}>Done</PrimaryButton>}
    >
      <div className="flex gap-5 min-h-[400px]">
        <aside className="w-[130px] shrink-0 flex flex-col gap-0.5">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setTab(entry.id)}
              className={
                'px-2.5 py-2 rounded-lg text-[12.5px] text-left transition-colors ' +
                (tab === entry.id ? 'text-ink' : 'text-muted hover:text-ink hover:bg-white/[0.05]')
              }
              style={tab === entry.id ? { background: 'var(--accent-soft)' } : undefined}
            >
              {entry.label}
            </button>
          ))}
        </aside>

        <div className="flex-1 min-w-0">
          {tab === 'general' && <GeneralTab />}
          {tab === 'connection' && <ConnectionTab />}
          {tab === 'categories' && <CategoriesTab />}
          {tab === 'browser' && <BrowserTab />}
          {tab === 'appearance' && <AppearanceTab />}
        </div>
      </div>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ */

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-faint mt-1.5 leading-relaxed">{hint}</p>}
    </div>
  )
}

function NumberField({
  label,
  hint,
  value,
  min,
  max,
  onCommit
}: {
  label: string
  hint?: string
  value: number
  min: number
  max: number
  onCommit(next: number): void
}): React.ReactElement {
  const [text, setText] = useState(String(value))

  // The settings are the source of truth; if main clamped the value, show what
  // it actually kept rather than what was typed.
  useEffect(() => setText(String(value)), [value])

  return (
    <Field label={label} hint={hint}>
      <input
        type="number"
        min={min}
        max={max}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          const parsed = Number(text)
          if (Number.isFinite(parsed)) onCommit(parsed)
          else setText(String(value))
        }}
        className="field text-[12.5px] tnum"
      />
    </Field>
  )
}

/* ------------------------------------------------------------------ */

function GeneralTab(): React.ReactElement {
  const settings = useApp((s) => s.settings)
  const categories = useApp((s) => s.categories)
  const patch = useApp((s) => s.patchSettings)

  return (
    <div className="space-y-4">
      <Field
        label="Download folder"
        hint="Categories create their subfolders under this one."
      >
        <button
          onClick={() => {
            void window.api.chooseDirectory(settings.downloadDir).then((dir) => {
              if (dir) void patch({ downloadDir: dir })
            })
          }}
          className="field text-left text-[12.5px] flex items-center gap-2 hover:bg-white/[0.06] transition-colors"
        >
          <FolderIcon className="w-4 h-4 text-faint shrink-0" />
          <span className="truncate">{settings.downloadDir || 'Choose a folder…'}</span>
        </button>
      </Field>

      <Field
        label="Default category"
        hint="Used when a file's extension matches nothing."
      >
        <select
          value={settings.defaultCategoryId ?? ''}
          onChange={(event) => void patch({ defaultCategoryId: event.target.value || null })}
          className="field text-[12.5px]"
        >
          <option value="">None — save in the download folder</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      </Field>

      <div className="pt-1 border-t border-line">
        <Toggle
          checked={settings.confirmDelete}
          onChange={(next) => void patch({ confirmDelete: next })}
          label="Ask before deleting downloads"
        />
        <Toggle
          checked={settings.closeToTray}
          onChange={(next) => void patch({ closeToTray: next })}
          label="Closing the window keeps downloading in the tray"
          hint="Quit from the tray menu to stop everything."
        />
        <Toggle
          checked={settings.startMinimized}
          onChange={(next) => void patch({ startMinimized: next })}
          label="Start minimised"
        />
        <Toggle
          checked={settings.watchClipboard}
          onChange={(next) => void patch({ watchClipboard: next })}
          label="Watch the clipboard for download links"
        />
        <Toggle
          checked={settings.showProgressWindow}
          onChange={(next) => void patch({ showProgressWindow: next })}
          label="Show a progress window for each download"
          hint="One small window per download you start, the way IDM does, with its own pause and cancel. Turn it off to keep everything in this list."
        />
      </div>
    </div>
  )
}

function ConnectionTab(): React.ReactElement {
  const settings = useApp((s) => s.settings)
  const patch = useApp((s) => s.patchSettings)

  const [limitText, setLimitText] = useState(
    settings.speedLimit ? String(Math.round(settings.speedLimit / 1024)) : ''
  )

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <NumberField
          label="Downloads at once"
          value={settings.maxConcurrentTasks}
          min={1}
          max={20}
          onCommit={(next) => void patch({ maxConcurrentTasks: next })}
        />
        <NumberField
          label="Connections per download"
          value={settings.maxConnectionsPerTask}
          min={1}
          max={16}
          onCommit={(next) => void patch({ maxConnectionsPerTask: next })}
        />
      </div>
      <p className="text-[11px] text-faint leading-relaxed -mt-2">
        Connections are handed out as they free up, not split evenly up front. More than eight
        rarely helps and some servers answer the extras with 429 — Draco backs off on its own when
        that happens.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <NumberField
          label="Retries per connection"
          value={settings.retryLimit}
          min={1}
          max={20}
          onCommit={(next) => void patch({ retryLimit: next })}
        />
        <NumberField
          label="Timeout (seconds)"
          value={Math.round(settings.timeoutMs / 1000)}
          min={5}
          max={300}
          onCommit={(next) => void patch({ timeoutMs: next * 1000 })}
        />
      </div>

      <NumberField
        label="Smallest piece to split (KB)"
        hint="A connection that frees up only takes work off another when more than this is left."
        value={Math.round(settings.minSplitSize / 1024)}
        min={64}
        max={262_144}
        onCommit={(next) => void patch({ minSplitSize: next * 1024 })}
      />

      <Field
        label="Speed limit (KB/s)"
        hint="Shared across every download. Leave empty for no limit."
      >
        <input
          value={limitText}
          onChange={(event) => setLimitText(event.target.value.replace(/[^\d]/g, ''))}
          onBlur={() => {
            const kb = Number(limitText)
            void patch({ speedLimit: kb > 0 ? kb * 1024 : null })
          }}
          placeholder="Unlimited"
          className="field text-[12.5px] tnum"
        />
      </Field>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function CategoriesTab(): React.ReactElement {
  const categories = useApp((s) => s.categories)
  const [draft, setDraft] = useState<Category[]>(categories)
  const [selected, setSelected] = useState(0)

  useEffect(() => setDraft(categories), [categories])

  const current = draft[selected]

  function patchCurrent(next: Partial<Category>): void {
    setDraft((list) => list.map((c, i) => (i === selected ? { ...c, ...next } : c)))
  }

  async function save(list: Category[]): Promise<void> {
    try {
      await window.api.saveCategories(list)
      toast('success', 'Categories saved')
    } catch (err) {
      reportError('Could not save categories', err)
    }
  }

  return (
    <div className="flex gap-4 h-full">
      <div className="w-[150px] shrink-0 flex flex-col gap-0.5">
        {draft.map((category, index) => (
          <button
            key={category.id || index}
            onClick={() => setSelected(index)}
            className={
              'px-2.5 py-1.5 rounded-lg text-[12.5px] text-left truncate transition-colors ' +
              (index === selected ? 'text-ink' : 'text-muted hover:text-ink hover:bg-white/[0.05]')
            }
            style={index === selected ? { background: 'var(--accent-soft)' } : undefined}
          >
            {category.name}
          </button>
        ))}

        <button
          onClick={() => {
            const added: Category = {
              // main assigns the real id; an empty one here means "new".
              id: '',
              name: 'New category',
              folder: 'New category',
              extensions: [],
              builtin: false
            }
            setDraft((list) => [...list, added])
            setSelected(draft.length)
          }}
          className="mt-1 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px]
                     text-faint hover:text-ink hover:bg-white/[0.05] transition-colors"
        >
          <PlusIcon className="w-3.5 h-3.5" />
          Add
        </button>
      </div>

      <div className="flex-1 min-w-0 space-y-3.5">
        {current ? (
          <>
            <Field label="Name">
              <input
                value={current.name}
                onChange={(event) => patchCurrent({ name: event.target.value })}
                className="field text-[12.5px]"
              />
            </Field>

            <Field label="Subfolder" hint="Created under the download folder.">
              <input
                value={current.folder}
                onChange={(event) => patchCurrent({ folder: event.target.value })}
                className="field text-[12.5px]"
              />
            </Field>

            <Field
              label="Extensions"
              hint="Space separated, without dots. A file matching none of the categories stays in the download folder."
            >
              <textarea
                value={current.extensions.join(' ')}
                onChange={(event) =>
                  patchCurrent({ extensions: event.target.value.split(/[\s,]+/).filter(Boolean) })
                }
                rows={4}
                spellCheck={false}
                className="field font-mono text-[11.5px] leading-relaxed resize-none"
              />
            </Field>

            <div className="flex gap-2 pt-1">
              <PrimaryButton onClick={() => void save(draft)}>Save categories</PrimaryButton>
              <GhostButton
                danger
                disabled={current.builtin}
                onClick={() => {
                  const next = draft.filter((_, i) => i !== selected)
                  setDraft(next)
                  setSelected(Math.max(0, selected - 1))
                  void save(next)
                }}
              >
                <span className="flex items-center gap-1.5">
                  <TrashIcon className="w-3.5 h-3.5" />
                  Delete
                </span>
              </GhostButton>
            </div>
            {current.builtin && (
              <p className="text-[11px] text-faint">
                Built-in categories can be renamed and re-pointed, but not removed.
              </p>
            )}
          </>
        ) : (
          <p className="text-[12px] text-faint">No categories.</p>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function BrowserTab(): React.ReactElement {
  const settings = useApp((s) => s.settings)
  const patch = useApp((s) => s.patchSettings)
  const integration = useApp((s) => s.integration)
  const refresh = useApp((s) => s.refreshIntegration)

  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-line bg-white/[0.02] p-3 space-y-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[12.5px] font-semibold flex-1">Extension</span>
          <button
            onClick={() => {
              setBusy(true)
              void window.api
                .registerIntegration()
                .then(() => refresh())
                .catch((err) => reportError('Registration failed', err))
                .finally(() => setBusy(false))
            }}
            disabled={busy}
            className="flex items-center gap-1.5 text-[11.5px] text-faint hover:text-ink transition-colors disabled:opacity-40"
          >
            <RefreshIcon className={'w-3.5 h-3.5 ' + (busy ? 'spin-slow' : '')} />
            Re-register
          </button>
        </div>

        <StatusLine
          ok={integration?.bridgeListening === true}
          label="Bridge"
          value={integration?.bridgeListening ? 'Listening on \\\\.\\pipe\\draco' : 'Not listening'}
        />
        <StatusLine
          ok={integration?.registered.chrome === true}
          label="Chrome"
          value={integration?.registered.chrome ? 'Registered' : 'Not registered'}
        />
        <StatusLine
          ok={integration?.registered.edge === true}
          label="Edge"
          value={integration?.registered.edge ? 'Registered' : 'Not registered'}
        />
        <StatusLine
          ok={integration?.registered.brave === true}
          label="Brave"
          value={integration?.registered.brave ? 'Registered' : 'Not registered'}
        />
        <StatusLine
          ok={integration?.extensionId !== null && integration?.extensionId !== undefined}
          label="ID"
          value={integration?.extensionId ?? 'Run npm run keygen to pin the extension ID'}
        />
        {integration?.lastHandoffAt && (
          <StatusLine ok label="Last handoff" value={formatWhen(integration.lastHandoffAt)} />
        )}

        <div className="pt-1">
          <p className="text-[11px] text-faint leading-relaxed mb-2">
            Open <span className="text-muted">chrome://extensions</span>, turn on Developer mode and
            choose “Load unpacked”, then point it at this folder:
          </p>
          <button
            onClick={() => {
              const path = integration?.extensionPath
              if (!path) return
              void window.api.copyToClipboard(path)
              toast('success', 'Path copied')
            }}
            className="field text-left text-[11.5px] font-mono flex items-center gap-2 hover:bg-white/[0.06] transition-colors"
          >
            <CopyIcon className="w-3.5 h-3.5 text-faint shrink-0" />
            <span className="truncate">{integration?.extensionPath ?? '—'}</span>
          </button>
        </div>
      </div>

      <Toggle
        checked={settings.takeoverEnabled}
        onChange={(next) => void patch({ takeoverEnabled: next })}
        label="Take downloads over from the browser"
        hint="The extension asks first; if Draco is not reachable the browser keeps the download."
      />

      <Toggle
        checked={settings.confirmHandoff}
        onChange={(next) => void patch({ confirmHandoff: next })}
        disabled={!settings.takeoverEnabled}
        label="Ask where to save"
        hint="Opens the file info window when the browser hands a download over, the way IDM does. Turn it off to start downloads straight away. Bulk actions never ask."
      />

      <NumberField
        label="Only take over files larger than (KB)"
        hint={'Currently ' + formatBytes(settings.takeoverMinSize) + '.'}
        value={Math.round(settings.takeoverMinSize / 1024)}
        min={0}
        max={1024 * 1024}
        onCommit={(next) => void patch({ takeoverMinSize: next * 1024 })}
      />

      <Field
        label="Only these extensions"
        hint="Space separated, without dots. Leave empty to consider every download."
      >
        <textarea
          value={settings.takeoverExtensions.join(' ')}
          onChange={(event) =>
            void patch({
              takeoverExtensions: event.target.value.split(/[\s,]+/).filter(Boolean)
            })
          }
          rows={2}
          spellCheck={false}
          className="field font-mono text-[11.5px] resize-none"
        />
      </Field>

      <Field
        label="Never take over from these sites"
        hint="Host names, space separated. Worth filling in for banking and anything behind a single-use link."
      >
        <textarea
          value={settings.takeoverExcludeHosts.join(' ')}
          onChange={(event) =>
            void patch({
              takeoverExcludeHosts: event.target.value.split(/[\s,]+/).filter(Boolean)
            })
          }
          rows={2}
          spellCheck={false}
          className="field font-mono text-[11.5px] resize-none"
        />
      </Field>
    </div>
  )
}

function StatusLine({
  ok,
  label,
  value
}: {
  ok: boolean
  label: string
  value: string
}): React.ReactElement {
  return (
    <div className="flex items-center gap-2 text-[11.5px]">
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{ background: ok ? 'var(--color-ok)' : 'var(--color-warn)' }}
      />
      <span className="text-faint w-[86px] shrink-0">{label}</span>
      <span className="truncate font-mono text-[11px]" title={value}>
        {value}
      </span>
    </div>
  )
}

/* ------------------------------------------------------------------ */

const ACCENTS = ['#38bdf8', '#6366f1', '#a78bfa', '#34d399', '#fbbf24', '#f87171', '#f472b6']

function AppearanceTab(): React.ReactElement {
  const settings = useApp((s) => s.settings)
  const patch = useApp((s) => s.patchSettings)

  return (
    <div className="space-y-4">
      <Field label="Accent" hint="Used for progress, selection and every live indicator.">
        <div className="flex gap-2">
          {ACCENTS.map((hex) => (
            <button
              key={hex}
              onClick={() => void patch({ accent: hex })}
              aria-label={hex}
              className="w-8 h-8 rounded-lg border-2 transition-transform hover:scale-110"
              style={{
                background: hex,
                borderColor: settings.accent === hex ? 'var(--color-ink)' : 'transparent'
              }}
            />
          ))}
        </div>
      </Field>

      <Field label="Columns" hint="Right-clicking the table header does the same thing.">
        <ColumnToggles />
      </Field>
    </div>
  )
}

function ColumnToggles(): React.ReactElement {
  const columns = useApp((s) => s.settings.columns)
  const toggleColumn = useApp((s) => s.toggleColumn)

  const NAMES: Record<string, string> = {
    name: 'Name',
    size: 'Size',
    progress: 'Progress',
    status: 'Status',
    eta: 'Time left',
    speed: 'Speed',
    queue: 'Queue',
    added: 'Added',
    description: 'Description'
  }

  return (
    <div className="grid grid-cols-3 gap-x-3">
      {columns.map((column) => (
        <Toggle
          key={column.id}
          checked={column.visible}
          disabled={column.id === 'name'}
          onChange={() => toggleColumn(column.id)}
          label={NAMES[column.id] ?? column.id}
        />
      ))}
    </div>
  )
}
