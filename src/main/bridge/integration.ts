import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { IntegrationStatus } from '@shared/types'
import { getPaths } from '../bootstrap/paths.ts'
import { logger } from '../log.ts'

const log = logger('integration')

/**
 * Registers Draco as a native-messaging host so the browser extension can reach
 * it - and so Chrome can start it when it is not already running.
 *
 * Each Chromium-family browser reads its own registry branch, so all three are
 * written. Missing browsers simply end up with a key nothing reads.
 */

export const HOST_NAME = 'com.nihil.draco'

const REGISTRY_KEYS: Record<'chrome' | 'edge' | 'brave', string> = {
  chrome: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
  edge: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
  brave: `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${HOST_NAME}`
}

/**
 * Chrome's extension-ID alphabet: the first 16 bytes of the SHA-256 of the DER
 * public key, hex-encoded, with 0-9a-f mapped onto a-p.
 */
export function extensionIdFromKey(base64Key: string): string {
  const der = Buffer.from(base64Key, 'base64')
  const digest = createHash('sha256').update(der).digest('hex').slice(0, 32)
  return [...digest].map((ch) => String.fromCharCode(parseInt(ch, 16) + 97)).join('')
}

/** Reads the pinned ID out of the extension manifest, or null if not generated yet. */
export async function readExtensionId(): Promise<string | null> {
  try {
    const raw = await readFile(join(getPaths().extensionDir, 'manifest.json'), 'utf8')
    const manifest = JSON.parse(raw) as { key?: string }
    if (!manifest.key) return null
    return extensionIdFromKey(manifest.key)
  } catch (err) {
    log.warn(`could not read the extension manifest: ${String(err)}`)
    return null
  }
}

function run(command: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    // Argument array with shell:false. Paths here contain spaces and the host
    // name is interpolated, so a command string would be a quoting hazard.
    const child = spawn(command, args, { shell: false, windowsHide: true })
    let stdout = ''
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()))
    child.on('error', () => resolve({ code: -1, stdout: '' }))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout }))
  })
}

/**
 * Writes the manifest Chrome reads to find the host binary, plus the small
 * config the host reads to find the app.
 */
export async function writeHostFiles(extensionId: string): Promise<void> {
  const paths = getPaths()

  await writeFile(
    paths.hostManifest,
    JSON.stringify(
      {
        name: HOST_NAME,
        description: 'Draco download manager bridge',
        path: paths.hostExe,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${extensionId}/`]
      },
      null,
      2
    ),
    'utf8'
  )

  // The host is launched by Chrome from an arbitrary working directory, so it
  // cannot infer where the app lives. Record it explicitly.
  const config: { appPath: string; appArgs?: string[] } = { appPath: app.getPath('exe') }
  if (!app.isPackaged) {
    /*
     * In development `exe` is Electron itself, which needs to be told which app
     * to run - the directory holding package.json, exactly as `electron .` does.
     *
     * Not `paths.root`: that is userData (%APPDATA%/Draco), which has no
     * package.json in it. Pointing Electron there makes it refuse to start with
     * "Unable to find Electron app at ...", and because the extension cold-starts
     * the app through this config, the dialog appears on its own with nobody
     * having tried to open anything.
     */
    config.appArgs = [app.getAppPath()]
  }

  await writeFile(
    join(paths.root, 'host-config.json'),
    JSON.stringify(config, null, 2),
    'utf8'
  )
}

export async function registerAll(): Promise<IntegrationStatus['registered']> {
  const paths = getPaths()
  const result = { chrome: false, edge: false, brave: false }

  for (const [browser, key] of Object.entries(REGISTRY_KEYS) as [
    keyof typeof REGISTRY_KEYS,
    string
  ][]) {
    const { code } = await run('reg', [
      'add',
      key,
      '/ve',
      '/t',
      'REG_SZ',
      '/d',
      paths.hostManifest,
      '/f'
    ])
    result[browser] = code === 0
    if (code !== 0) log.warn(`could not register for ${browser} (exit ${code})`)
  }

  return result
}

/** Reports which browsers currently point at *our* manifest path. */
export async function checkRegistered(): Promise<IntegrationStatus['registered']> {
  const paths = getPaths()
  const result = { chrome: false, edge: false, brave: false }

  for (const [browser, key] of Object.entries(REGISTRY_KEYS) as [
    keyof typeof REGISTRY_KEYS,
    string
  ][]) {
    const { code, stdout } = await run('reg', ['query', key, '/ve'])
    // A stale key left behind by a move is worse than no key: it points the
    // browser at a manifest that is not there any more.
    result[browser] = code === 0 && stdout.includes(paths.hostManifest)
  }

  return result
}

/**
 * Idempotent setup. Safe - and intended - to run on every launch, so moving the
 * app folder repairs the integration instead of silently breaking it.
 */
export async function ensureRegistered(): Promise<IntegrationStatus['registered']> {
  const extensionId = await readExtensionId()
  if (!extensionId) {
    log.warn('extension key not generated yet; skipping registration')
    return { chrome: false, edge: false, brave: false }
  }

  await writeHostFiles(extensionId)

  const current = await checkRegistered()
  if (current.chrome && current.edge && current.brave) return current

  return registerAll()
}
