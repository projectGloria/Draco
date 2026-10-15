import type { ToolId, ToolStatus } from '../shared/types.ts'
import {
  ffmpegVersion,
  latestFfmpegVersion,
  locateFfmpeg,
  reinstallFfmpeg
} from './hls/ffmpeg.ts'
import { logger } from './log.ts'
import { compareToolVersions } from './tools-version.ts'
import { latestYtDlpVersion, locateYtDlp, reinstallYtDlp, ytDlpVersion } from './youtube.ts'

const log = logger('tools')

/**
 * The installer supplies both binaries. Updates are stored in userData and
 * override the bundled versions without modifying the installation directory.
 *
 * Only a copy in `%APPDATA%/Draco/bin` is Draco's to replace. One found on PATH
 * belongs to whatever installed it, and updating that behind the user's back
 * would be replacing a system tool without being asked.
 */
const TOOLS = {
  ffmpeg: {
    name: 'FFmpeg',
    purpose: 'Merges video and audio, and finishes playlist downloads',
    locate: locateFfmpeg,
    installed: ffmpegVersion,
    latest: latestFfmpegVersion,
    update: () => reinstallFfmpeg().then(() => undefined)
  },
  'yt-dlp': {
    name: 'yt-dlp',
    purpose: 'Resolves YouTube download links',
    locate: locateYtDlp,
    installed: ytDlpVersion,
    latest: latestYtDlpVersion,
    update: () => reinstallYtDlp().then(() => undefined)
  }
} as const satisfies Record<ToolId, unknown>

export const TOOL_IDS = Object.keys(TOOLS) as ToolId[]
const statusCache = new Map<ToolId, { at: number; status: ToolStatus }>()
const STATUS_TTL_MS = 60_000

/**
 * What is installed, what is published, and whether the gap is Draco's to close.
 *
 * `checkLatest: false` answers from the disk alone - no network - which is what
 * the Options panel wants when it is merely opening.
 */
export async function getToolStatus(checkLatest: boolean): Promise<ToolStatus[]> {
  return Promise.all(TOOL_IDS.map((id) => statusOf(id, checkLatest)))
}

async function statusOf(id: ToolId, checkLatest: boolean): Promise<ToolStatus> {
  const cached = statusCache.get(id)
  if (!checkLatest && cached && Date.now() - cached.at < STATUS_TTL_MS) return { ...cached.status }
  const tool = TOOLS[id]
  const base: ToolStatus = {
    id,
    name: tool.name,
    purpose: tool.purpose,
    path: null,
    managed: false,
    installedVersion: null,
    latestVersion: null,
    updateAvailable: false,
    error: null
  }

  try {
    const found = await tool.locate()
    if (!found) {
      // Development checkouts can omit the bundle and fetch tools on first use.
      return base
    }

    const installedVersion = await tool.installed(found.path)
    const latestVersion = checkLatest ? await tool.latest() : cached?.status.latestVersion ?? null
    const behind = compareToolVersions(installedVersion, latestVersion)

    const status = {
      ...base,
      path: found.path,
      managed: found.managed,
      installedVersion,
      latestVersion,
      // Only when both versions were understood *and* the copy is ours. A null
      // comparison means nobody could tell, which is never a reason to replace
      // a working binary.
      updateAvailable: found.managed && behind !== null && behind < 0
    }
    statusCache.set(id, { at: Date.now(), status })
    return status
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Fetches the current build of one tool, replacing Draco's own copy. */
export async function updateTool(id: ToolId): Promise<ToolStatus> {
  const tool = TOOLS[id]
  if (!tool) throw new Error(`Unknown tool: ${id}`)

  const before = await statusOf(id, false)
  if (before.path && !before.managed) {
    throw new Error(`${tool.name} came from your system PATH, so Draco will not replace it`)
  }

  log.info(`updating ${tool.name} from ${before.installedVersion ?? 'nothing'}`)
  await tool.update()
  statusCache.delete(id)
  const after = await statusOf(id, true)
  log.info(`${tool.name} is now ${after.installedVersion ?? 'unknown'}`)
  return after
}
