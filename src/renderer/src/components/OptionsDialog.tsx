import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  Category,
  CookieCheckProgress,
  CookieCheckResult,
  InstalledBrowser,
  SiteCredential,
  Settings,
  ToolId,
  ToolStatus
} from '@shared/types'
import { formatBytes, formatWhen } from '../lib/format'
import { useApp } from '../store/app'
import { reportError, toast } from '../store/toasts'
import Dialog, { GhostButton, PrimaryButton } from './Dialog'
import { CookieIcon, CopyIcon, FolderIcon, GearIcon, GlobeIcon, LayersIcon, LinkIcon, PaletteIcon, PlusIcon, RefreshIcon, ToolsIcon, TrashIcon } from './Icons'
import ffmpegIcon from '../../../../resources/tools/ffmpeg.ico'
import ytDlpIcon from '../../../../resources/tools/yt-dlp.ico'
import Toggle from './Toggle'
import { useT, type TKey } from '../i18n'

type Tab = 'general' | 'connection' | 'cookies' | 'categories' | 'browser' | 'appearance' | 'tools'

const TABS = [
  { id: 'general', label: 'General', icon: GearIcon },
  { id: 'connection', label: 'Connection', icon: LinkIcon },
  { id: 'cookies', label: 'Cookies', icon: CookieIcon },
  { id: 'categories', label: 'Categories', icon: LayersIcon },
  { id: 'browser', label: 'Browser', icon: GlobeIcon },
  { id: 'appearance', label: 'Appearance', icon: PaletteIcon },
  { id: 'tools', label: 'Necessary tools', icon: ToolsIcon }
] as const

function validateDraft(settings: Settings): TKey | null {
  const schedule = settings.scheduledLimit
  if (schedule && (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule.startTime)
    || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule.stopTime)
    || !Number.isFinite(schedule.bytesPerSecond) || schedule.bytesPerSecond <= 0)) {
    return 'incompleteScheduledLimit'
  }
  for (const [value, protocols, error] of [
    [settings.proxyUrl, ['http:', 'https:'], 'invalidProxyUrl'],
    [settings.updateFeedUrl, ['https:'], 'invalidUpdateFeedUrl']
  ] as const) {
    if (!value) continue
    if (value.length > 2048) return error
    try {
      if (!(protocols as readonly string[]).includes(new URL(value).protocol)) return error
    } catch { return error }
  }
  return null
}

export default function OptionsDialog({
  onClose
}: {
  onClose(): void
}): React.ReactElement {
  const [tab, setTab] = useState<Tab>('general')
  const liveSettings = useApp((s) => s.settings)
  const persist = useApp((s) => s.patchSettings)
  const original = useRef(liveSettings)
  const [draft, setDraft] = useState(liveSettings)
  const draftRef = useRef(liveSettings)
  const [changes, setChanges] = useState<Partial<Settings>>({})
  const changesRef = useRef<Partial<Settings>>({})
  const [saving, setSaving] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [validationError, setValidationError] = useState<TKey | null>(null)
  const t = useT()
  const dirty = Object.keys(changes).length > 0

  const patchDraft = useCallback((patch: Partial<Settings>): void => {
    draftRef.current = { ...draftRef.current, ...patch }
    setDraft(draftRef.current)
    const next = { ...changesRef.current, ...patch }
    for (const key of Object.keys(patch) as Array<keyof Settings>) {
      if (JSON.stringify(next[key]) === JSON.stringify(original.current[key])) delete next[key]
    }
    changesRef.current = next
    setChanges(next)
    setConfirmDiscard(false)
    setValidationError(null)
  }, [])

  const requestClose = (): void => {
    if (saving) return
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    const hasChanges = Object.keys(changesRef.current).length > 0
    if (hasChanges && !confirmDiscard) { setConfirmDiscard(true); return }
    if (hasChanges && confirmDiscard) { setConfirmDiscard(false); return }
    onClose()
  }

  const apply = async (): Promise<void> => {
    if (saving) return
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    if (Object.keys(changesRef.current).length === 0) { onClose(); return }
    const error = validateDraft(draftRef.current)
    if (error) { setValidationError(error); return }
    setSaving(true)
    try {
      if (!await persist(changesRef.current)) return
      onClose()
    } catch (error) {
      reportError(t('settingsSaveFailed'), error)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      title={t('options')}
      width={780}
      height={690}
      onClose={requestClose}
      footer={confirmDiscard ? <>
        <span role="alert" className="mr-auto text-[12px] text-warn">{t('unsavedSettings')}</span>
        <GhostButton onClick={() => setConfirmDiscard(false)}>{t('keepEditing')}</GhostButton>
        <PrimaryButton onClick={onClose}>{t('discardChanges')}</PrimaryButton>
      </> : <>
        {validationError && <span role="alert" className="mr-auto text-[12px] text-warn">{t(validationError)}</span>}
        <GhostButton onClick={requestClose} disabled={saving}>{t('cancel')}</GhostButton>
        <PrimaryButton onClick={() => void apply()} disabled={saving}>{saving ? t('saving') : dirty ? t('apply') : t('done')}</PrimaryButton>
      </>}
    >
      <div>
        <nav aria-label="Options sections" className="sticky top-[-16px] z-10 flex gap-1 overflow-x-auto border-b border-line pb-2 bg-[var(--color-surface)]">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setTab(entry.id)}
              aria-current={tab === entry.id ? 'page' : undefined}
              className={
                'flex shrink-0 items-center gap-1.5 whitespace-nowrap px-2 py-2 rounded-lg text-[12px] text-center transition-colors ' +
                (tab === entry.id ? 'text-ink' : 'text-muted hover:text-ink hover:bg-white/[0.05]')
              }
              style={tab === entry.id ? { background: 'var(--accent-soft)' } : undefined}
            >
              <entry.icon className="h-3.5 w-3.5 shrink-0" />
              {entry.label}
            </button>
          ))}
        </nav>

        <div className="min-w-0 pt-4">
          {tab === 'general' && <GeneralTab settings={draft} patch={patchDraft} />}
          {tab === 'connection' && <ConnectionTab settings={draft} patch={patchDraft} />}
          {tab === 'cookies' && <CookiesTab />}
          {tab === 'categories' && <CategoriesTab />}
          {tab === 'browser' && <BrowserTab settings={draft} patch={patchDraft} />}
          {tab === 'appearance' && <AppearanceTab />}
          {tab === 'tools' && <NecessaryToolsTab />}
        </div>
      </div>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ */

const TOOL_PLACEHOLDERS: ToolStatus[] = [
  { id: 'ffmpeg', name: 'FFmpeg', purpose: 'Merges video and audio, and finishes playlist downloads' },
  { id: 'yt-dlp', name: 'yt-dlp', purpose: 'Resolves YouTube download links' }
].map((tool) => ({ ...tool, id: tool.id as ToolId, path: null, managed: false,
  installedVersion: null, latestVersion: null, updateAvailable: false, error: null }))
let cachedTools: ToolStatus[] | null = null

function NecessaryToolsTab(): React.ReactElement {
  const [tools, setTools] = useState<ToolStatus[]>(() => cachedTools ?? TOOL_PLACEHOLDERS)
  const [loaded, setLoaded] = useState(() => cachedTools !== null)
  const [scanning, setScanning] = useState(true)
  const [checking, setChecking] = useState(false)
  const [busyTool, setBusyTool] = useState<ToolId | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void window.api.getToolStatus(false)
      .then((found) => { cachedTools = found; if (live) { setTools(found); setLoaded(true) } })
      .catch((err) => { if (live) setError(String(err)) })
      .finally(() => { if (live) setScanning(false) })
    return () => { live = false }
  }, [])

  const checkLatest = async (): Promise<void> => {
    setChecking(true)
    setError(null)
    try {
      const found = await window.api.getToolStatus(true)
      cachedTools = found
      setTools(found)
      setLoaded(true)
    } catch (err) {
      setError(String(err))
    } finally {
      setChecking(false)
    }
  }

  const install = async (id: ToolId): Promise<void> => {
    setBusyTool(id)
    setError(null)
    try {
      const updated = await window.api.updateTool(id)
      setTools((current) => {
        cachedTools = current.map((tool) => tool.id === id ? updated : tool)
        return cachedTools
      })
    } catch (err) {
      setError(String(err))
    } finally {
      setBusyTool(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-semibold">Necessary tools</h3>
          <p className="mt-1 text-[11.5px] text-faint leading-relaxed">
            Draco uses yt-dlp to find video formats and FFmpeg to combine video and audio.
            These checks show the executables Draco will use on this computer.
          </p>
        </div>
        <button type="button" onClick={() => void checkLatest()} disabled={scanning || checking || busyTool !== null}
          title={checking ? 'Checking for updates…' : 'Check for updates'}
          aria-label={checking ? 'Checking for updates' : 'Check for updates'}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line bg-white/[0.03] text-muted transition-colors hover:bg-white/[0.08] hover:text-ink disabled:opacity-50">
          <RefreshIcon className={'h-4 w-4' + (checking ? ' animate-spin' : '')} />
        </button>
      </div>

      {tools.map((tool) => (
        <div key={tool.id} className="rounded-lg border border-line bg-white/[0.02] p-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-line bg-black/10">
              <img src={tool.id === 'ffmpeg' ? ffmpegIcon : ytDlpIcon} alt="" className="h-7 w-7 object-contain" draggable={false} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h4 className="text-[13px] font-semibold">{tool.name}</h4>
                <span className={tool.path && tool.installedVersion ? 'text-[11px] text-ok' : 'text-[11px] text-warn'}>
                  {!loaded ? scanning ? 'Checking…' : 'Not checked' : tool.path ? tool.installedVersion ? 'Ready' : 'Version unavailable' : 'Missing'}
                </span>
              </div>
              <p className="mt-0.5 text-[11.5px] text-faint">{tool.purpose}</p>
            </div>
            {loaded && (!tool.path || tool.updateAvailable) && (
              <PrimaryButton onClick={() => void install(tool.id)} disabled={scanning || busyTool !== null || checking}>
                {busyTool === tool.id ? 'Installing…' : tool.path ? 'Update' : 'Install'}
              </PrimaryButton>
            )}
          </div>
          <dl className="mt-3 grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[11.5px]">
            <dt className="text-faint">Installed</dt>
            <dd className="tnum break-all">{tool.installedVersion ?? (loaded ? '—' : scanning ? 'Checking…' : '—')}</dd>
            <dt className="text-faint">Latest</dt>
            <dd className="tnum">{tool.latestVersion ?? 'Check for updates to compare'}</dd>
            <dt className="text-faint">Location</dt>
            <dd className="break-all" title={tool.path ?? undefined}>{tool.path ?? (loaded ? 'Not installed' : scanning ? 'Locating…' : '—')}</dd>
          </dl>
          {tool.path && !tool.managed && (
            <p className="mt-2 text-[11px] text-faint">Found on your system PATH. Update this copy outside Draco.</p>
          )}
          {tool.error && <p className="mt-2 text-[11px] text-err">{tool.error}</p>}
        </div>
      ))}
      {error && <p role="alert" className="text-[11.5px] text-err">{error}</p>}
    </div>
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
          if (Number.isFinite(parsed) && text.trim() !== '') {
            const bounded = Math.max(min, Math.min(max, parsed))
            setText(String(bounded))
            onCommit(bounded)
          } else setText(String(value))
        }}
        className="field text-[12.5px] tnum"
      />
    </Field>
  )
}

/* ------------------------------------------------------------------ */

function GeneralTab({ settings, patch }: {
  settings: Settings
  patch: (change: Partial<Settings>) => void
}): React.ReactElement {
  const categories = useApp((s) => s.categories)
  const savedUpdateFeed = useApp((s) => s.settings.updateFeedUrl)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
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
          <option value="">None – save in the download folder</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Cat mode 🐱"
        hint="Keep queued downloads alive by occasionally downloading tiny 5-second chunks at low speed (prevents server timeouts)."
      >
        <label className="flex items-center gap-2 text-[12.5px] cursor-pointer w-max h-8">
          <input
            type="checkbox"
            checked={settings.catMode}
            onChange={(event) => void patch({ catMode: event.target.checked })}
          />
          Enable Cat Mode
        </label>
      </Field>

      <Field
        label="Disk Space Checks"
        hint="Prevent downloads from starting if there is not enough free disk space."
      >
        <label className="flex items-center gap-2 text-[12.5px] cursor-pointer w-max h-8">
          <input
            type="checkbox"
            checked={settings.checkDiskSpace}
            onChange={(event) => void patch({ checkDiskSpace: event.target.checked })}
          />
          Verify free space before downloading
        </label>
      </Field>

      <Field
        label="Network Retries"
        hint="Use exponential backoff when retrying failed connections instead of hitting the server instantly."
      >
        <label className="flex items-center gap-2 text-[12.5px] cursor-pointer w-max h-8">
          <input
            type="checkbox"
            checked={settings.exponentialBackoff}
            onChange={(event) => void patch({ exponentialBackoff: event.target.checked })}
          />
          Enable exponential backoff
        </label>
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
            disabled={checkingUpdate || !settings.updateFeedUrl || settings.updateFeedUrl !== savedUpdateFeed}
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
        {settings.updateFeedUrl !== savedUpdateFeed && (
          <p className="mt-1.5 text-[11px] text-faint">Apply settings before checking this update feed.</p>
        )}
      </Field>
      <Toggle
        checked={settings.autoCheckUpdates}
        onChange={(next) => void patch({ autoCheckUpdates: next })}
        label="Check for updates at startup"
        hint="Checks the update feed and helper tool versions at startup."
      />

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
          checked={settings.completionSound}
          onChange={(next) => void patch({ completionSound: next })}
          label="Play a sound when a download finishes"
          hint="A short, soft chime for completed downloads."
        />
        <Toggle
          checked={settings.associateTorrents}
          onChange={(next) => void patch({ associateTorrents: next })}
          label="Open .torrent files and magnet links with Draco"
          hint="Double-clicking a torrent, or clicking a magnet link, shows it here for you to pick files from. If Windows has already been told to use another app for these, choose Draco once from “Open with” — Windows will not let an app take that back on its own."
        />
        <CliPathToggle settings={settings} patch={patch} />
        <Toggle
          checked={settings.showProgressWindow}
          onChange={(next) => void patch({ showProgressWindow: next })}
          label="Show a progress window for each download"
          hint="One small window per download you start, the way IDM does, with its own pause and cancel. Turn it off to keep everything in this list."
        />
        <Toggle
          checked={settings.showDropzone}
          onChange={(next) => void patch({ showDropzone: next })}
          label="Show Dropzone Widget"
          hint="A small floating window you can drag links into."
        />
      </div>
    </div>
  )
}

/**
 * Passwords for sites that ask for one.
 *
 * The password is write-only from here: it goes to main on save and is sealed
 * by the OS, and nothing ever sends it back - the list shows a host, a realm
 * and a username, which is everything the user needs to recognise an entry.
 */
/**
 * The `draco` command toggle. Disabled - with the reason as its hint - on a
 * copy that has no stable folder to offer (portable, dev), rather than letting
 * someone switch on a setting that can do nothing.
 */
function CliPathToggle({ settings, patch }: {
  settings: Settings
  patch: (change: Partial<Settings>) => void
}): React.ReactElement {
  const integration = useApp((s) => s.integration)
  const refresh = useApp((s) => s.refreshIntegration)
  useEffect(() => {
    void refresh()
  }, [refresh])
  const reason = integration?.cliPath.unavailableReason ?? null
  return (
    <Toggle
      checked={settings.cliOnPath}
      disabled={reason !== null}
      onChange={(next) => {
        void patch({ cliOnPath: next })
        // The registry write runs after the save returns; re-read once it has
        // had a moment so the Browser tab's status line is not stale.
        setTimeout(() => void refresh(), 1500)
      }}
      label="Add the draco command to PATH"
      hint={reason ?? 'Lets you run “draco <url> -best” from any new terminal. Your other PATH entries are left exactly as they are.'}
    />
  )
}

function SiteCredentials(): React.ReactElement {
  const [entries, setEntries] = useState<SiteCredential[]>([])
  const [host, setHost] = useState('')
  const [realm, setRealm] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = (): void => {
    void window.api
      .listCredentials()
      .then(setEntries)
      .catch((error) => reportError('Could not read saved sites', error))
  }

  useEffect(refresh, [])

  const add = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.api.saveCredential({ host, realm, username, password })
      // Cleared on success, not on failure: a rejected save should leave what
      // was typed in place to be corrected.
      setHost('')
      setRealm('')
      setUsername('')
      setPassword('')
      refresh()
      toast('success', 'Saved')
    } catch (error) {
      reportError('Could not save', error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="pt-3 border-t border-line">
      <div className="label mb-1">Site sign-ins</div>
      <p className="text-[11px] text-faint mb-2.5 leading-relaxed">
        Used when a server answers with 401. Passwords are encrypted by Windows for your
        account and never leave this machine.
      </p>

      {entries.length > 0 && (
        <div className="mb-3 border border-line rounded-lg overflow-hidden">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_28px] items-center gap-2 px-2.5 py-2 text-[11.5px] border-b border-line last:border-b-0"
            >
              <span className="truncate" title={entry.host}>
                {entry.host}
                {entry.realm && <span className="text-faint"> · {entry.realm}</span>}
              </span>
              <span className="truncate text-muted" title={entry.username}>{entry.username}</span>
              <button
                type="button"
                title="Forget this sign-in"
                className="justify-self-end text-faint hover:text-err"
                onClick={() => {
                  void window.api
                    .removeCredential(entry.id)
                    .then(refresh)
                    .catch((error) => reportError('Could not remove', error))
                }}
              >
                <TrashIcon className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <input
          value={host}
          onChange={(event) => setHost(event.target.value)}
          placeholder="files.example.com"
          spellCheck={false}
          className="field text-[12.5px]"
        />
        <input
          value={realm}
          onChange={(event) => setRealm(event.target.value)}
          placeholder="Realm (optional)"
          spellCheck={false}
          className="field text-[12.5px]"
        />
        <input
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          placeholder="Username"
          spellCheck={false}
          autoComplete="off"
          className="field text-[12.5px]"
        />
        <input
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && host && username && password && !busy) void add()
          }}
          placeholder="Password"
          type="password"
          autoComplete="new-password"
          className="field text-[12.5px]"
        />
      </div>

      <div className="mt-2 flex justify-end">
        <GhostButton onClick={() => void add()} disabled={busy || !host || !username || !password}>
          <PlusIcon className="w-3.5 h-3.5" />
          Add sign-in
        </GhostButton>
      </div>
    </div>
  )
}

function ConnectionTab({ settings, patch }: {
  settings: Settings
  patch: (change: Partial<Settings>) => void
}): React.ReactElement {

  const [limitText, setLimitText] = useState(
    settings.speedLimit ? String(Math.round(settings.speedLimit / 1024)) : ''
  )
  const [ceilingText, setCeilingText] = useState(
    settings.adaptiveConnectionCeiling ? String(settings.adaptiveConnectionCeiling) : ''
  )
  const [uploadText, setUploadText] = useState(
    settings.uploadLimit ? String(Math.round(settings.uploadLimit / 1024)) : ''
  )
  const [ratioText, setRatioText] = useState(
    settings.seedRatioLimit !== null ? String(settings.seedRatioLimit) : ''
  )
  const [seedMinutesText, setSeedMinutesText] = useState(
    settings.seedTimeMinutes !== null ? String(settings.seedTimeMinutes) : ''
  )
  const [proxyText, setProxyText] = useState(settings.proxyUrl ?? '')
  const [quotaText, setQuotaText] = useState(
    settings.quotaBytes ? String(Math.round(settings.quotaBytes / (1024 * 1024))) : ''
  )
  const [hostLimitsText, setHostLimitsText] = useState(
    settings.hostConnectionLimits.map((rule) => `${rule.host}=${rule.connections}`).join('\n')
  )

  /** Keep incomplete edits in the local draft so the next field can complete the schedule. */
  const patchSchedule = (
    change: Partial<{ startTime: string; stopTime: string; bytesPerSecond: number }>
  ): Promise<void> | void => {
    const current = settings.scheduledLimit ?? { startTime: '', stopTime: '', bytesPerSecond: 0 }
    const next = { ...current, ...change }
    const empty = !next.startTime && !next.stopTime && next.bytesPerSecond <= 0
    return patch({ scheduledLimit: empty ? null : next })
  }

  useEffect(() => setProxyText(settings.proxyUrl ?? ''), [settings.proxyUrl])
  useEffect(() => {
    setUploadText(settings.uploadLimit ? String(Math.round(settings.uploadLimit / 1024)) : '')
  }, [settings.uploadLimit])
  useEffect(() => {
    setRatioText(settings.seedRatioLimit !== null ? String(settings.seedRatioLimit) : '')
  }, [settings.seedRatioLimit])
  useEffect(() => {
    setSeedMinutesText(settings.seedTimeMinutes !== null ? String(settings.seedTimeMinutes) : '')
  }, [settings.seedTimeMinutes])
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
        hint="Leave empty to stop at the number above. Set it higher to let Draco keep climbing past that on servers that reward it; a per-host rule still wins. Applies to ordinary downloads and to YouTube video+audio; playlist streams use a fixed pool."
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

      <div className="pt-1 border-t border-line">
        <Toggle
          checked={settings.seedTorrents}
          onChange={(next) => void patch({ seedTorrents: next })}
          label="Keep seeding finished torrents"
          hint="Your download only worked because other people were still seeding. Off disconnects the moment a torrent completes."
        />
      </div>

      <Field
        label="Upload limit (KB/s)"
        hint="Separate from the speed limit above, so giving back does not cost you download speed. Empty means no limit."
      >
        <input
          value={uploadText}
          onChange={(event) => setUploadText(event.target.value.replace(/[^\d]/g, ''))}
          onBlur={() => {
            const kb = Number(uploadText)
            void patch({ uploadLimit: kb > 0 ? kb * 1024 : null })
          }}
          placeholder="Unlimited"
          className="field text-[12.5px] tnum"
          disabled={!settings.seedTorrents}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Stop seeding at ratio" hint="Empty seeds until you stop it.">
          <input
            value={ratioText}
            onChange={(event) => setRatioText(event.target.value.replace(/[^\d.]/g, ''))}
            onBlur={() => {
              const ratio = Number(ratioText)
              void patch({ seedRatioLimit: ratio > 0 ? ratio : null })
            }}
            placeholder="No ratio target"
            className="field text-[12.5px] tnum"
            disabled={!settings.seedTorrents}
          />
        </Field>
        <Field label="Stop seeding after (minutes)" hint="Whichever target is reached first wins.">
          <input
            inputMode="numeric"
            value={seedMinutesText}
            onChange={(event) => setSeedMinutesText(event.target.value.replace(/[^\d]/g, ''))}
            onBlur={() => {
              const minutes = Number(seedMinutesText)
              void patch({ seedTimeMinutes: minutes > 0 ? minutes : null })
            }}
            placeholder="No time limit"
            className="field text-[12.5px] tnum"
            disabled={!settings.seedTorrents}
          />
        </Field>
      </div>

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

      <div className="grid grid-cols-3 gap-3">
        <Field label="Throttle from" hint="Leave the speed empty for no scheduled limit.">
          <input
            value={settings.scheduledLimit?.startTime ?? ''}
            onChange={(event) => void patchSchedule({ startTime: event.target.value })}
            placeholder="09:00"
            className="field text-[12.5px] tnum"
          />
        </Field>
        <Field label="Until" hint="A stop before the start crosses midnight.">
          <input
            value={settings.scheduledLimit?.stopTime ?? ''}
            onChange={(event) => void patchSchedule({ stopTime: event.target.value })}
            placeholder="17:00"
            className="field text-[12.5px] tnum"
          />
        </Field>
        <Field label="At (KB/s)" hint="Replaces the limit above during those hours.">
          <input
            inputMode="numeric"
            value={settings.scheduledLimit ? String(Math.round(settings.scheduledLimit.bytesPerSecond / 1024)) : ''}
            onChange={(event) => {
              const kb = Number(event.target.value.replace(/[^\d]/g, ''))
              void patchSchedule({ bytesPerSecond: kb > 0 ? kb * 1024 : 0 })
            }}
            placeholder="None"
            className="field text-[12.5px] tnum"
          />
        </Field>
      </div>

      <SiteCredentials />
    </div>
  )
}

/* ------------------------------------------------------------------ */

/**
 * Which browser Draco borrows cookies from, and whether that actually works.
 *
 * This was a dropdown on the Connection tab with a hint under it, and choosing
 * from it told the user nothing: whether the pick had helped only surfaced
 * later, in a different window, as a download failing with a message about PO
 * tokens. It matters more than a dropdown suggests, because YouTube now
 * withholds every format above 360p from a request it reads as signed out - so
 * this setting is the difference between 4K and a 360p file wearing a 4K name.
 *
 * Hence a tab, real browser icons, and a check that goes and finds out.
 */
function CookiesTab(): React.ReactElement {
  const settings = useApp((s) => s.settings)
  const patch = useApp((s) => s.patchSettings)
  const [browsers, setBrowsers] = useState<InstalledBrowser[]>([])
  const [progress, setProgress] = useState<CookieCheckProgress | null>(null)
  const [result, setResult] = useState<CookieCheckResult | null>(null)
  const [running, setRunning] = useState<string | null>(null)

  useEffect(() => {
    void window.api.listBrowsers().then(setBrowsers).catch(() => setBrowsers([]))
  }, [])

  // Subscribed for the life of the tab rather than per run: the progress events
  // start arriving the moment main spawns yt-dlp, which is before the invoke
  // resolves, and a subscription set up inside `check` would miss the first.
  useEffect(() => window.api.onCookieCheckProgress(setProgress), [])

  async function check(browser: string): Promise<void> {
    setRunning(browser)
    setResult(null)
    setProgress({ stage: 'starting', percent: 2, message: 'Starting' })
    try {
      // Saved first, so the check measures the setting that is now in force
      // rather than a choice that would be lost if the dialog were closed.
      if (!await patch({ cookiesFromBrowser: browser as typeof settings.cookiesFromBrowser })) return
      setResult(await window.api.checkCookies(browser))
    } catch (err) {
      reportError('The cookie check could not run', err)
    } finally {
      setRunning(null)
      setProgress(null)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="label">Borrow cookies from</label>
        <p className="text-[11px] text-faint leading-relaxed mb-2.5">
          Pick the browser you watch YouTube in. Draco checks its cookies and compares the
          downloadable qualities with a public lookup. YouTube can limit yt-dlp to 360p even
          when your browser is signed in.
        </p>

        <div className="grid grid-cols-4 gap-2">
          <BrowserButton
            label="None"
            icon={null}
            installed
            selected={settings.cookiesFromBrowser === 'none'}
            busy={false}
            disabled={running !== null}
            onClick={() => {
              setResult(null)
              void patch({ cookiesFromBrowser: 'none' })
            }}
          />
          {browsers.map((browser) => (
            <BrowserButton
              key={browser.id}
              label={browser.label}
              icon={browser.icon}
              installed={browser.installed}
              selected={settings.cookiesFromBrowser === browser.id}
              busy={running === browser.id}
              disabled={running !== null}
              onClick={() => void check(browser.id)}
            />
          ))}
        </div>
      </div>

      {progress && (
        <div className="rounded-lg border border-line bg-white/[0.02] px-3.5 py-3">
          <div className="flex items-center justify-between text-[11.5px]">
            <span>{progress.message}</span>
            <span className="text-faint tnum">{progress.percent}%</span>
          </div>
          <div className="h-1.5 mt-2 rounded-full bg-white/[0.06] overflow-hidden">
            <span
              className="block h-full rounded-full transition-[width] duration-300"
              style={{ width: `${progress.percent}%`, background: 'var(--grad)' }}
            />
          </div>
        </div>
      )}

      {result && <CookieVerdict result={result} />}

      {!progress && !result && settings.cookiesFromBrowser !== 'none' && (
        <p className="text-[11px] text-faint leading-relaxed">
          Currently borrowing cookies from <strong className="text-ink">{settings.cookiesFromBrowser}</strong>.
          Click it again to test the session.
        </p>
      )}
    </div>
  )
}

function BrowserButton({
  label,
  icon,
  installed,
  selected,
  busy,
  disabled,
  onClick
}: {
  label: string
  icon: string | null
  installed: boolean
  selected: boolean
  busy: boolean
  disabled: boolean
  onClick(): void
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={installed ? label : `${label} was not found on this PC`}
      className={
        'rounded-xl border px-2 py-3 flex flex-col items-center gap-1.5 transition-colors ' +
        'disabled:cursor-not-allowed ' +
        (selected ? 'border-[var(--accent)] text-ink' : 'border-line text-muted hover:text-ink hover:bg-white/[0.05]') +
        (installed ? '' : ' opacity-45')
      }
      style={selected ? { background: 'var(--accent-soft)' } : undefined}
    >
      <span className="w-7 h-7 grid place-items-center">
        {busy ? (
          <span className="w-4 h-4 rounded-full border-2 border-faint border-t-[var(--accent)] animate-spin" />
        ) : icon ? (
          <img src={icon} alt="" draggable={false} className="w-7 h-7 object-contain" />
        ) : (
          <GlobeIcon className="w-5 h-5" />
        )}
      </span>
      <span className="text-[11px] truncate max-w-full">{label}</span>
    </button>
  )
}

function CookieVerdict({ result }: { result: CookieCheckResult }): React.ReactElement {
  const tone = result.ok
    ? { border: 'rgba(74,222,128,0.25)', bg: 'rgba(74,222,128,0.08)' }
    : { border: 'rgba(251,191,36,0.25)', bg: 'rgba(251,191,36,0.08)' }

  return (
    <div
      className="rounded-lg px-3.5 py-3 text-[11.5px] leading-relaxed border"
      style={{ borderColor: tone.border, background: tone.bg }}
    >
      <div className={'font-semibold ' + (result.ok ? 'text-ok' : 'text-warn')}>
        {result.ok
          ? result.usedPublicFallback
            ? `Public lookup works — up to ${result.bestQuality}`
            : `${result.browser}'s session works — up to ${result.bestQuality}`
          : `${result.browser}'s lookup is limited to ${result.bestQuality ?? 'no formats'}`}
      </div>

      <div className="text-faint mt-1.5 tnum">
        {result.cookiesRead === null ? 'Cookie count unknown' : `${result.cookiesRead} cookies read`}
        {result.offered.length > 0 && ` · ${result.usedPublicFallback ? 'public formats' : 'offered'} ${result.offered.join(', ')}`}
      </div>

      {result.cause && (
        <p className="mt-2">
          <span className="text-faint uppercase text-[10px] tracking-[0.4px]">Cause </span>
          {result.cause}
        </p>
      )}
      {result.fix && (
        <p className="mt-1.5">
          <span className="text-faint uppercase text-[10px] tracking-[0.4px]">Fix </span>
          {result.fix}
        </p>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */

function CategoriesTab(): React.ReactElement {
  const categories = useApp((s) => s.categories)
  const persistCategories = useApp((s) => s.saveCategories)
  const [draft, setDraft] = useState<Category[]>(categories)
  const [selected, setSelected] = useState(0)

  useEffect(() => setDraft(categories), [categories])

  const current = draft[selected]

  function patchCurrent(next: Partial<Category>): void {
    setDraft((list) => list.map((c, i) => (i === selected ? { ...c, ...next } : c)))
  }

  async function save(list: Category[]): Promise<void> {
    if (await persistCategories(list)) {
      toast('success', 'Categories saved')
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

function BrowserTab({ settings, patch }: {
  settings: Settings
  patch: (change: Partial<Settings>) => void
}): React.ReactElement {
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
        <StatusLine
          ok={integration?.shellHandlers.torrentFiles === true}
          label=".torrent"
          value={integration?.shellHandlers.torrentFiles ? 'Opens with Draco' : 'Opens with another app'}
        />
        <StatusLine
          ok={integration?.shellHandlers.magnetLinks === true}
          label="magnet:"
          value={integration?.shellHandlers.magnetLinks ? 'Opens with Draco' : 'Opens with another app'}
        />
        <StatusLine
          ok={integration?.cliPath.onPath === true}
          label="draco"
          value={
            integration?.cliPath.onPath
              ? 'On PATH'
              : integration?.cliPath.unavailableReason ?? 'Not on PATH'
          }
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
            In Firefox, open about:debugging → This Firefox → Load Temporary Add-on,
            then select manifest.json from this folder. Firefox removes temporary add-ons
            when it restarts; a permanent install needs a Mozilla-signed XPI.
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
