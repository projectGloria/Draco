import { spawn } from 'node:child_process'
import { app } from 'electron'
import { logger } from './log.ts'

const log = logger('shell')

/**
 * Draco as a Windows file and protocol handler: double-clicking a `.torrent`
 * opens it here, and so does clicking a magnet link in a browser.
 *
 * The installer declares the file type (see `electron-builder.yml`), but that
 * only covers an installed copy, and it says nothing about `magnet:`. A dev run
 * and a portable copy get the same behaviour from here, and the registration is
 * per-user (HKCU) throughout - it never touches machine-wide state and never
 * needs elevation.
 *
 * Three separate things have to be written, and it is worth knowing why:
 *
 *   - The ProgIds (`Draco.Torrent`, `Draco.Magnet`) say how to open the thing.
 *   - `Software\Classes\.torrent` and `Software\Classes\magnet` make Draco the
 *     handler when nothing else has claimed the type.
 *   - The `Capabilities` block, listed in `RegisteredApplications`, is what
 *     puts Draco in Windows' own "Default apps" pickers. Without it Draco can
 *     open a magnet link but never appears in the list of apps allowed to be
 *     the default for one - which is how Firefox, mpv and the rest get listed.
 *
 * What none of this can do is *take* the default. Once a user has chosen an
 * app for a type, Windows records it under `UserChoice`/`UserChoiceLatest`
 * with a hash tied to their SID, specifically so an application cannot
 * overwrite it. `shellHandlerStatus` reads that choice rather than our own
 * keys, so the Options panel reports what Windows will actually do, not what
 * Draco would prefer.
 */

/** Our ProgIds. Windows keys an association to these, not to a path. */
const PROG_ID_FILE = 'Draco.Torrent'
const PROG_ID_URL = 'Draco.Magnet'

const CLASSES = 'HKCU\\Software\\Classes'
const FILE_PROG_KEY = `${CLASSES}\\${PROG_ID_FILE}`
const URL_PROG_KEY = `${CLASSES}\\${PROG_ID_URL}`
const EXT_KEY = `${CLASSES}\\.torrent`
const MAGNET_KEY = `${CLASSES}\\magnet`

/** The Default Programs registration, and where Windows is told to find it. */
const CAPABILITIES_PATH = 'Software\\Draco\\Capabilities'
const CAPABILITIES_KEY = `HKCU\\${CAPABILITIES_PATH}`
const REGISTERED_APPS_KEY = 'HKCU\\Software\\RegisteredApplications'

/** Where Windows records the user's own choice, which outranks everything. */
const FILE_EXTS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts'
const URL_ASSOCIATIONS = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations'

export interface ShellHandlerStatus {
  /** `.torrent` currently opens with Draco. */
  torrentFiles: boolean
  /** `magnet:` links currently open with Draco. */
  magnetLinks: boolean
}

function run(command: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    // Argument array with shell:false, as in `bridge/integration.ts`: these
    // carry an executable path with spaces and a literal `%1`.
    const child = spawn(command, args, { shell: false, windowsHide: true })
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.on('error', () => resolve({ code: -1, stdout: '' }))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout }))
  })
}

/**
 * The command line Windows should run, with `%1` for what it was given.
 *
 * In development `exe` is Electron itself, which has to be told which app to
 * run - the same problem, and the same answer, as the native-messaging host
 * config in `bridge/integration.ts`.
 */
function openCommand(): string {
  const exe = app.getPath('exe')
  const prefix = app.isPackaged ? `"${exe}"` : `"${exe}" "${app.getAppPath()}"`
  return `${prefix} "%1"`
}

/** One `reg add`. Empty `data` writes the value with no data, which is what
 * `URL Protocol` and an `OpenWithProgids` entry are. */
async function regWrite(key: string, value: string, type: string, data: string): Promise<boolean> {
  const args = ['add', key, '/f', '/t', type]
  args.push(...(value ? ['/v', value] : ['/ve']))
  if (data) args.push('/d', data)
  const { code } = await run('reg.exe', args)
  if (code !== 0) log.warn(`could not write ${key}${value ? `\\${value}` : ''}`)
  return code === 0
}

async function regQuery(key: string, value: string): Promise<string | null> {
  const args = ['query', key]
  args.push(...(value ? ['/v', value] : ['/ve']))
  const { code, stdout } = await run('reg.exe', args)
  if (code !== 0) return null
  const match = /REG_[A-Z_]+\s+(.*)$/m.exec(stdout)
  const data = match ? match[1].trim() : null
  // What reg.exe prints for a key that exists with an empty default - which is
  // what releasing an association leaves behind, and is not a ProgId.
  return data === '(value not set)' ? null : data
}

/**
 * Claims `.torrent` and `magnet:` for this copy of Draco, and registers it as
 * an app Windows may offer as the default for both.
 *
 * `OpenWithProgids` is written whether or not Draco ends up the default: it is
 * what puts Draco in the "Open with" list, so a user who would rather keep
 * their existing client can still send one torrent here.
 */
export async function registerShellHandlers(): Promise<ShellHandlerStatus> {
  const exe = app.getPath('exe')
  const command = openCommand()
  const icon = `"${exe}",0`

  const writes: Array<[string, string, string, string]> = [
    /* How to open a torrent file. */
    [FILE_PROG_KEY, '', 'REG_SZ', 'BitTorrent file'],
    [FILE_PROG_KEY, 'FriendlyTypeName', 'REG_SZ', 'BitTorrent file'],
    [`${FILE_PROG_KEY}\\DefaultIcon`, '', 'REG_SZ', icon],
    [`${FILE_PROG_KEY}\\shell\\open\\command`, '', 'REG_SZ', command],

    /* How to open a magnet link. `URL Protocol` is what marks a ProgId as a
       protocol handler; without it Windows ignores the shell verb entirely. */
    [URL_PROG_KEY, '', 'REG_SZ', 'URL:Magnet Link'],
    [URL_PROG_KEY, 'URL Protocol', 'REG_SZ', ''],
    [URL_PROG_KEY, 'FriendlyTypeName', 'REG_SZ', 'Magnet link'],
    [`${URL_PROG_KEY}\\DefaultIcon`, '', 'REG_SZ', icon],
    [`${URL_PROG_KEY}\\shell\\open\\command`, '', 'REG_SZ', command],

    /* The handler of last resort for each, used when nobody else has claimed
       the type. Rewritten every launch so a moved or reinstalled copy cannot
       leave a command line pointing at an executable that is no longer there. */
    [`${EXT_KEY}\\OpenWithProgids`, PROG_ID_FILE, 'REG_NONE', ''],
    [EXT_KEY, '', 'REG_SZ', PROG_ID_FILE],
    [MAGNET_KEY, '', 'REG_SZ', 'URL:Magnet Link'],
    [MAGNET_KEY, 'URL Protocol', 'REG_SZ', ''],
    [`${MAGNET_KEY}\\shell\\open\\command`, '', 'REG_SZ', command],

    /* The Default Programs registration - the part that gets Draco listed in
       Settings > Default apps, where the user can actually grant it the type. */
    [CAPABILITIES_KEY, 'ApplicationName', 'REG_SZ', 'Draco'],
    [
      CAPABILITIES_KEY,
      'ApplicationDescription',
      'REG_SZ',
      'Download manager for files, streams and torrents'
    ],
    [CAPABILITIES_KEY, 'ApplicationIcon', 'REG_SZ', icon],
    [`${CAPABILITIES_KEY}\\FileAssociations`, '.torrent', 'REG_SZ', PROG_ID_FILE],
    [`${CAPABILITIES_KEY}\\URLAssociations`, 'magnet', 'REG_SZ', PROG_ID_URL],
    [REGISTERED_APPS_KEY, 'Draco', 'REG_SZ', CAPABILITIES_PATH]
  ]

  for (const [key, value, type, data] of writes) {
    await regWrite(key, value, type, data)
  }

  const status = await shellHandlerStatus()
  log.info(`shell handlers: .torrent=${status.torrentFiles} magnet=${status.magnetLinks}`)
  return status
}

/**
 * Gives both back.
 *
 * The ProgIds themselves are left behind on purpose - they cost nothing, they
 * keep Draco in the "Open with" list, and removing them would break the
 * association of anyone who had picked Draco there rather than through this
 * setting. What goes is the claim on the types and the offer to be a default.
 */
export async function unregisterShellHandlers(): Promise<ShellHandlerStatus> {
  // Only if they are ours. Another client may have taken the type since, and
  // deleting its value would leave the type with no handler at all.
  if ((await regQuery(EXT_KEY, '')) === PROG_ID_FILE) {
    await run('reg.exe', ['delete', EXT_KEY, '/ve', '/f'])
  }
  if (await ownsCommand(`${MAGNET_KEY}\\shell\\open\\command`)) {
    await run('reg.exe', ['delete', MAGNET_KEY, '/f'])
  }

  await run('reg.exe', ['delete', REGISTERED_APPS_KEY, '/v', 'Draco', '/f'])
  await run('reg.exe', ['delete', CAPABILITIES_KEY, '/f'])

  return shellHandlerStatus()
}

/** Whether a `shell\open\command` value is one of ours. */
async function ownsCommand(key: string): Promise<boolean> {
  const command = await regQuery(key, '')
  if (!command) return false
  return command.toLowerCase().includes(app.getPath('exe').toLowerCase())
}

/**
 * What Windows will actually do, which is not the same question as what Draco
 * has registered.
 *
 * A choice the user made in Settings or "Open with" is recorded per-user and
 * outranks `Software\Classes` entirely, so it is consulted first - otherwise
 * this would cheerfully report that torrents open in Draco while they were in
 * fact still opening in another client. Windows 11 writes `UserChoiceLatest`
 * alongside the older `UserChoice`; the newer one wins where both exist.
 */
export async function shellHandlerStatus(): Promise<ShellHandlerStatus> {
  return {
    torrentFiles: await resolvesToDraco(
      [
        [`${FILE_EXTS}\\.torrent\\UserChoiceLatest`, 'ProgId'],
        [`${FILE_EXTS}\\.torrent\\UserChoice`, 'ProgId'],
        [EXT_KEY, '']
      ],
      PROG_ID_FILE,
      `${EXT_KEY}\\shell\\open\\command`
    ),
    magnetLinks: await resolvesToDraco(
      [
        [`${URL_ASSOCIATIONS}\\magnet\\UserChoice`, 'ProgId'],
        [MAGNET_KEY, '']
      ],
      PROG_ID_URL,
      `${MAGNET_KEY}\\shell\\open\\command`
    )
  }
}

/**
 * Walks the chain of places a ProgId can come from, most authoritative first,
 * and answers whether the winner is Draco.
 *
 * A ProgId of ours settles it. Anything else settles it the other way - except
 * the fallback class key, whose "ProgId" is really just a class name, so that
 * one is confirmed by looking at the command it would run.
 */
async function resolvesToDraco(
  sources: Array<[key: string, value: string]>,
  ours: string,
  fallbackCommandKey: string
): Promise<boolean> {
  for (const [key, value] of sources) {
    const progId = await regQuery(key, value)
    if (!progId) continue
    if (progId === ours) return true
    // Someone else's ProgId, and it is the one Windows will use.
    if (value === 'ProgId') return false
  }
  return ownsCommand(fallbackCommandKey)
}

/**
 * The torrent or magnet a launch was asked to open, if any.
 *
 * Windows passes it as a plain argument, so this has to pick it out of an argv
 * that also holds Chromium's own switches and, in development, the app
 * directory. Rather than trying to model those, it recognises only the two
 * shapes it can act on and ignores everything else.
 */
export function shellTargetsFromArgv(argv: readonly string[]): string[] {
  const targets: string[] = []
  for (const raw of argv.slice(1)) {
    const arg = String(raw).trim()
    if (!arg || arg.startsWith('-')) continue
    if (/^magnet:/i.test(arg)) targets.push(arg)
    else if (/\.torrent$/i.test(arg)) targets.push(arg)
  }
  return targets
}
