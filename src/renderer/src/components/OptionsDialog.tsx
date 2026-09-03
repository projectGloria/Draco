import { useEffect, useState } from 'react'
import type { Category, ToolStatus } from '@shared/types'
import { formatBytes, formatWhen } from '../lib/format'
import { useApp } from '../store/app'
import { reportError, toast } from '../store/toasts'
import Dialog, { GhostButton, PrimaryButton } from './Dialog'
import { CopyIcon, FolderIcon, PlusIcon, RefreshIcon, TrashIcon } from './Icons'
import Toggle from './Toggle'
import { useT } from '../i18n'

type Tab = 'general' | 'connection' | 'categories' | 'browser' | 'appearance'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'connection', label: 'Connection' },
  { id: 'categories', label: 'Categories' },
  { id: 'browser', label: 'Browser' },
  { id: 'appearance', label: 'Appearance' }
]

export default function OptionsDialog({
  onClose,
  onShowTools
}: {
  onClose(): void
  /** Hands the helper-tool list to the one dialog that offers the update. */
  onShowTools(tools: ToolStatus[]): void
}): React.ReactElement {
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
          {tab === 'general' && <GeneralTab onShowTools={onShowTools} />}
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

function GeneralTab({ onShowTools }: { onShowTools(tools: ToolStatus[]): void }): React.ReactElement {
  const settings = useApp((s) => s.settings)
  const categories = useApp((s) => s.categories)
  const patch = useApp((s) => s.patchSettings)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [checkingTools, setCheckingTools] = useState(false)
  const [toolSummary, setToolSummary] = useState<string | null>(null)
  const t = useT()

  return (
    <div className="space-y-4">
      <Field label={t('language')}>
        <select
          value={settings.language}
          onChange={(event) => void patch({ language: event.target.value as 'system' | 'en' | 'tr' })}
          className="field text-[12.5px]"
        >
          <option value="system">{t('systemLanguage')}</option>
          <option value="en">{t('english')}</option>
          <option value="tr">{t('turkish')}</option>
        </select>
      </Field>
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

      <Field
        label="Security scanner (optional)"
        hint="Runs after completion without a command shell. Use {file} where the downloaded path belongs."
      >
        <div className="grid grid-cols-[1fr_150px] gap-2">
          <input
            value={settings.antivirusProgram ?? ''}
            onChange={(event) => void patch({ antivirusProgram: event.target.value || null })}
            className="field text-[12px]"
            placeholder="C:\\Program Files\\Scanner\\scan.exe"
          />
          <textarea
            rows={2}
            value={settings.antivirusArgs.join('\n')}
            onChange={(event) => void patch({
              antivirusArgs: event.target.value.split(/\r?\n/).filter(Boolean)
            })}
            className="field text-[12px]"
            placeholder={'--scan\n{file}'}
          />
        </div>
      </Field>

      <Field
        label="Updates"
        hint="HTTPS JSON feed with version, url, and optional notes fields. Draco never installs an update silently."
      >
        <div className="flex gap-2">
          <input
            value={settings.updateFeedUrl ?? ''}
            onChange={(event) => void patch({ updateFeedUrl: event.target.value || null })}
            className="field text-[12px] flex-1"
            placeholder="https://example.com/draco/latest.json"
          />
          <GhostButton
            disabled={checkingUpdate || !settings.updateFeedUrl}
            onClick={() => {
              setCheckingUpdate(true)
              void window.api.checkForUpdates()
                .then((info) => {
                  if (info.available) {
                    toast('success', `Draco ${info.latestVersion} is available`, info.notes ?? undefined)
                    if (info.downloadUrl) void window.api.openUpdate(info.downloadUrl)
                  } else toast('success', 'Draco is up to date', info.currentVersion)
                })
                .catch((error) => reportError('Update check failed', error))
                .finally(() => setCheckingUpdate(false))
            }}
          >
            {checkingUpdate ? 'Checking…' : 'Check'}
          </GhostButton>
        </div>
      </Field>
      <Toggle
        checked={settings.autoCheckUpdates}
        onChange={(next) => void patch({ autoCheckUpdates: next })}
        label="Check for updates at startup"
        hint="The feed above, and the versions of the helper tools below."
      />

      <Field
        label="Helper tools"
        hint="ffmpeg and yt-dlp are fetched on first use rather than shipped. yt-dlp especially goes stale - YouTube changes, and an old copy starts reporting that a video has no downloadable formats."
      >
        <div className="flex items-center gap-2">
          <div className="flex-1 text-[11.5px] text-faint leading-snug">
            {toolSummary ?? 'Not checked yet'}
          </div>
          <GhostButton
            disabled={checkingTools}
            onClick={() => {
              setCheckingTools(true)
              void window.api
                .getToolStatus(true)
                .then((tools) => {
                  setToolSummary(
                    tools
                      .map((tool) => `${tool.name} ${tool.installedVersion ?? 'not installed'}`)
                      .join(' · ')
                  )
                  // The same dialog the startup check raises, so an update is
                  // only ever offered from one place.
                  onShowTools(tools)
                })
                .catch((error) => reportError('Could not check the helper tools', error))
                .finally(() => setCheckingTools(false))
            }}
          >
            {checkingTools ? 'Checking…' : 'Check'}
          </GhostButton>
        </div>
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
  const [ceilingText, setCeilingText] = useState(
    settings.adaptiveConnectionCeiling ? String(settings.adaptiveConnectionCeiling) : ''
  )
  const [proxyText, setProxyText] = useState(settings.proxyUrl ?? '')
  const [quotaText, setQuotaText] = useState(
    settings.quotaBytes ? String(Math.round(settings.quotaBytes / (1024 * 1024))) : ''
  )
  const [hostLimitsText, setHostLimitsText] = useState(
    settings.hostConnectionLimits.map((rule) => `${rule.host}=${rule.connections}`).join('\n')
  )

  useEffect(() => setProxyText(settings.proxyUrl ?? ''), [settings.proxyUrl])
  useEffect(() => {
    setCeilingText(
      settings.adaptiveConnectionCeiling ? String(settings.adaptiveConnectionCeiling) : ''
    )
  }, [settings.adaptiveConnectionCeiling])
  useEffect(() => {
    setQuotaText(settings.quotaBytes ? String(Math.round(settings.quotaBytes / (1024 * 1024))) : '')
  }, [settings.quotaBytes])
  useEffect(() => {
    setHostLimitsText(settings.hostConnectionLimits.map((rule) => `${rule.host}=${rule.connections}`).join('\n'))
  }, [settings.hostConnectionLimits])

  return (
    <div className="space-y-4 max-h-[410px] overflow-y-auto pr-1">
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
          max={64}
          onCommit={(next) => void patch({ maxConnectionsPerTask: next })}
        />
      </div>
      <p className="text-[11px] text-faint leading-relaxed -mt-2">
        Connections are handed out as they free up, not split evenly up front, and Draco climbs to
        this number only while the extra ones measurably raise throughput — a server that saturates
        on four keeps four. So a high number costs a measurement rather than the connections, and
        is worth trying on a host that throttles each one separately. It also backs off on its own
        when a server answers with 429.
      </p>

      <Field
        label="Adaptive ceiling"
        hint="Leave empty to stop at the number above. Set it higher to let Draco keep climbing past that on servers that reward it; a per-host rule still wins."
      >
        <input
          value={ceilingText}
          onChange={(event) => setCeilingText(event.target.value.replace(/[^0-9]/g, ''))}
          onBlur={() => {
            const next = Number(ceilingText)
            void patch({ adaptiveConnectionCeiling: next > 0 ? next : null })
          }}
          placeholder="Same as above"
          className="field text-[12.5px] tnum"
        />
      </Field>

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

      <Field
        label="HTTP/HTTPS proxy"
        hint="Leave empty for a direct connection. Example: http://proxy.example:8080"
      >
        <input
          value={proxyText}
          onChange={(event) => setProxyText(event.target.value)}
          onBlur={() => void patch({ proxyUrl: proxyText.trim() || null })}
          placeholder="Direct connection"
          className="field text-[12.5px]"
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Transfer quota (MB)" hint="Leave empty for no quota.">
          <input
            inputMode="numeric"
            value={quotaText}
            onChange={(event) => setQuotaText(event.target.value.replace(/[^\d]/g, ''))}
            onBlur={() => {
              const mb = Number(quotaText)
              void patch({ quotaBytes: mb > 0 ? mb * 1024 * 1024 : null })
            }}
            placeholder="Unlimited"
            className="field text-[12.5px] tnum"
          />
        </Field>
        <NumberField
          label="Quota window (minutes)"
          value={settings.quotaWindowMinutes}
          min={1}
          max={10_080}
          onCommit={(next) => void patch({ quotaWindowMinutes: next })}
        />
      </div>

      <Field
        label="Per-host connection limits"
        hint="One host=connections rule per line. Parent domains also match subdomains."
      >
        <textarea
          value={hostLimitsText}
          onChange={(event) => setHostLimitsText(event.target.value)}
          onBlur={() => {
            const rules = hostLimitsText
              .split(/\r?\n/)
              .map((line) => {
                const [host, rawConnections] = line.split('=', 2)
                return { host: host?.trim() ?? '', connections: Number(rawConnections) }
              })
              .filter((rule) => rule.host && Number.isFinite(rule.connections))
            void patch({ hostConnectionLimits: rules })
          }}
          rows={3}
          placeholder={'example.com=2\ndownloads.example.net=1'}
          className="field text-[12.5px] tnum resize-y"
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
              id: crypto.randomUUID(),
              name: 'New category',
              folder: 'New category',
              extensions: [],
              hosts: [],
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

            <Field
              label="Site rules"
              hint="Host suffixes, space separated. Site matches take precedence over extensions."
            >
              <textarea
                value={current.hosts.join(' ')}
                onChange={(event) => patchCurrent({ hosts: event.target.value.split(/[\s,]+/).filter(Boolean) })}
                rows={2}
                spellCheck={false}
                className="field font-mono text-[11.5px] resize-none"
                placeholder="downloads.example.com example.org"
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
          ok={integration?.registered.opera === true}
          label="Opera"
          value={integration?.registered.opera ? 'Registered' : 'Not registered'}
        />
        <StatusLine
          ok={integration?.registered.vivaldi === true}
          label="Vivaldi"
          value={integration?.registered.vivaldi ? 'Registered' : 'Not registered'}
        />
        <StatusLine
          ok={integration?.registered.firefox === true}
          label="Firefox"
          value={integration?.registered.firefox ? 'Registered' : 'Not registered'}
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
          <p className="text-[11px] text-faint leading-relaxed mt-2 mb-2">
            Firefox uses its generated package at:
          </p>
          <button
            onClick={() => {
              const path = integration?.firefoxExtensionPath
              if (!path) return
              void window.api.copyToClipboard(path)
              toast('success', 'Firefox path copied')
            }}
            className="field text-left text-[11.5px] font-mono flex items-center gap-2 hover:bg-white/[0.06] transition-colors"
          >
            <CopyIcon className="w-3.5 h-3.5 text-faint shrink-0" />
            <span className="truncate">{integration?.firefoxExtensionPath ?? '—'}</span>
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
      <Field label="Theme">
        <select
          value={settings.theme}
          onChange={(event) => void patch({ theme: event.target.value as 'system' | 'dark' | 'light' })}
          className="field text-[12.5px]"
        >
          <option value="system">System</option>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </Field>
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
