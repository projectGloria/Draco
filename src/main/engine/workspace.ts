import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { DownloadTask } from '../../shared/types.ts'
import { volumeRootOf } from './preallocate.ts'

/**
 * Where a task's intermediate files live while it is running.
 *
 * There is one rule and every runner obeys it, because the alternative is the
 * bug this module was written to end: a partial written to one directory and
 * looked for - or deleted from - in another. `remove`, the restore-time journal
 * reconciliation and all four runners now derive their paths from here, so they
 * cannot disagree again.
 *
 * The shared temp directory is used only when it sits on the same volume as the
 * destination. `moveFile` falls back to copy-and-delete across volumes, so a
 * temp directory on C: and a download folder on D: means every finished file is
 * read and rewritten in full - minutes of disk time on a large download, and
 * twice the space needed transiently. Keeping the partial beside its
 * destination in that case makes the finishing move a rename again, which is
 * the only reason the part file has a separate directory to begin with.
 */
export function workspaceDir(taskDir: string, tempDir?: string): string {
  if (!tempDir) return taskDir
  return volumeRootOf(tempDir) === volumeRootOf(taskDir) ? tempDir : taskDir
}

/** An opaque leaf also keeps malformed IDs from escaping the workspace root. */
export function taskWorkspaceDir(taskDir: string, taskId: string, tempDir?: string): string {
  const key = createHash('sha256').update(taskId).digest('hex')
  return join(workspaceDir(taskDir, tempDir), '.draco-tasks', key)
}

/** The `.dracodl` a single ranged download accumulates into. */
export function partPathFor(taskDir: string, filename: string, taskId: string, tempDir?: string): string {
  return join(taskWorkspaceDir(taskDir, taskId, tempDir), filename + '.dracodl')
}

/** Suffixes that only ever belong to Draco's own intermediates. */
const PART_SUFFIXES = ['.dracodl', '.dracodl.json', '.dracodl.tmp', '.dracodl.json.tmp', '.dracodl.audio']
const DIR_SUFFIX = '.dracoparts'
const TEMP_MEDIA_PATTERN = /\.draco-(?:dash|mux)-temp(?:\.[a-z0-9]+)?$/i

/**
 * Every intermediate a task can leave behind, in both the workspace and the
 * destination - the latter because a task created by an older build kept its
 * partial beside the finished file, and removing the row must clean that up
 * too rather than stranding it forever.
 */
export function intermediatePathsFor(
  task: Pick<DownloadTask, 'id' | 'dir' | 'filename' | 'audioUrl' | 'audioTracks' | 'youtube'>,
  tempDir?: string
): { files: string[]; dirs: string[] } {
  const dirs = [taskWorkspaceDir(task.dir, task.id, tempDir)]
  if (task.audioUrl) {
    dirs.push(taskWorkspaceDir(task.dir, task.id + '-v', tempDir))
    dirs.push(taskWorkspaceDir(task.dir, task.id + '-a', tempDir))
  }
  return { files: [], dirs }
}

/** Old filename-based paths are read only during migration; never use for cleanup. */
function legacyIntermediatePathsFor(
  task: Pick<DownloadTask, 'dir' | 'filename' | 'audioUrl' | 'audioTracks' | 'youtube'>,
  tempDir?: string
): { files: string[]; dirs: string[] } {
  const files = new Set<string>()
  const dirs = new Set<string>()

  const stems = [task.filename]
  // The muxed halves are Draco's own intermediates, and each is a download in
  // its own right with a part file and journal of its own.
  if (task.audioUrl) {
    stems.push(task.filename + '.v.mp4', task.filename + '.a.m4a')
    const safeV = task.youtube?.videoFormatId?.replace(/[^a-z0-9_-]/gi, '')
    const safeA = task.youtube?.audioFormatId?.replace(/[^a-z0-9_-]/gi, '')
    if (safeV) stems.push(task.filename + `.v.${safeV}.mp4`)
    if (safeA) stems.push(task.filename + `.a.${safeA}.m4a`)
  }

  const dot = task.filename.lastIndexOf('.')
  const [baseStem, ext] = dot > 0
    ? [task.filename.slice(0, dot), task.filename.slice(dot)]
    : [task.filename, '']

  for (const dir of new Set([workspaceDir(task.dir, tempDir), task.dir])) {
    for (const stem of stems) {
      for (const suffix of PART_SUFFIXES) files.add(join(dir, stem + suffix))
      dirs.add(join(dir, stem + DIR_SUFFIX))
    }
    if (ext) {
      files.add(join(dir, `${baseStem}.draco-dash-temp${ext}`))
      files.add(join(dir, `${baseStem}.draco-mux-temp${ext}`))
    }
    files.add(join(dir, `${baseStem}.draco-dash-temp`))
    files.add(join(dir, `${baseStem}.draco-mux-temp`))
    files.add(join(dir, `${baseStem}.draco-mux-temp.mp4`))

    const audioCount = task.audioTracks?.length ?? 0
    for (let index = 1; index < audioCount; index++) {
      files.add(join(dir, task.filename + `.dracodl.audio.${index}`))
    }
  }

  // The finished halves themselves, which live beside the destination because
  // that is where the merge reads them from.
  if (task.audioUrl) {
    files.add(join(task.dir, task.filename + '.v.mp4'))
    files.add(join(task.dir, task.filename + '.a.m4a'))
    const safeV = task.youtube?.videoFormatId?.replace(/[^a-z0-9_-]/gi, '')
    const safeA = task.youtube?.audioFormatId?.replace(/[^a-z0-9_-]/gi, '')
    if (safeV) files.add(join(task.dir, task.filename + `.v.${safeV}.mp4`))
    if (safeA) files.add(join(task.dir, task.filename + `.a.${safeA}.m4a`))
  }

  return { files: [...files], dirs: [...dirs] }
}

/**
 * Adopt unambiguous old intermediates before restoring progress. Ambiguous or
 * conflicting data stays in place for manual recovery, never assigned to a
 * task by filename alone. Running this again after a crash is safe.
 */
export async function migrateLegacyIntermediates(tasks: DownloadTask[], tempDir?: string): Promise<Set<string>> {
  const candidates = tasks.filter((task) =>
    task.status !== 'done' && task.status !== 'processing' && task.status !== 'scanning' && !task.finalizationStage && task.kind !== 'torrent'
  ).flatMap((task) => {
    const legacy = legacyIntermediatePathsFor(task, tempDir)
    return [...legacy.files, ...legacy.dirs]
      .filter((path) => isDracoIntermediate(basename(path)))
      .map((source) => {
        const name = basename(source)
        const childId = task.audioUrl && /\.v\.(?:[a-z0-9_-]+\.)?mp4\.dracodl(?:\.json|\.tmp)?$/i.test(name)
          ? task.id + '-v'
          : task.audioUrl && /\.a\.(?:[a-z0-9_-]+\.)?m4a\.dracodl(?:\.json|\.tmp)?$/i.test(name)
            ? task.id + '-a'
            : task.id
        return { task, source, target: join(taskWorkspaceDir(task.dir, childId, tempDir), name) }
      })
  })
  const owners = new Map<string, Set<string>>()
  for (const item of candidates) {
    const key = item.source.toLowerCase()
    const set = owners.get(key) ?? new Set<string>()
    set.add(item.task.id)
    owners.set(key, set)
  }

  const ambiguous = new Set<string>()
  for (const item of candidates) {
    if ((owners.get(item.source.toLowerCase())?.size ?? 0) > 1) {
      if (await stat(item.source).catch(() => null)) ambiguous.add(item.task.id)
    }
    if (item.source.endsWith('.dracodl.json')) {
      const raw = await readFile(item.source, 'utf8').catch(() => null)
      if (raw !== null) {
        try {
          const journal = JSON.parse(raw) as { url?: string }
          if (journal.url !== item.task.url && journal.url !== item.task.audioUrl) ambiguous.add(item.task.id)
        } catch {
          ambiguous.add(item.task.id)
        }
      }
    }
  }

  // A task may have remnants both beside the target and in the old shared
  // temp directory. Do not choose one silently when they map to one new file.
  const targetClaims = new Map<string, number>()
  for (const item of candidates) {
    if (await stat(item.source).catch(() => null)) {
      const key = item.target.toLowerCase()
      targetClaims.set(key, (targetClaims.get(key) ?? 0) + 1)
    }
  }
  for (const item of candidates) {
    if ((targetClaims.get(item.target.toLowerCase()) ?? 0) > 1) ambiguous.add(item.task.id)
  }

  const seen = new Set<string>()
  for (const item of candidates) {
    if (ambiguous.has(item.task.id)) continue
    const key = item.source.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (!await stat(item.source).catch(() => null)) continue
    if (await stat(item.target).catch(() => null)) {
      ambiguous.add(item.task.id)
      continue
    }
    await mkdir(dirname(item.target), { recursive: true })
    try {
      await rename(item.source, item.target)
    } catch {
      // Permissions or a vanished source can change during startup. The old
      // data remains untouched and the task can be recovered manually.
      ambiguous.add(item.task.id)
    }
  }
  return ambiguous
}

/**
 * Whether a name in the shared temp directory is one of ours.
 *
 * Used by the startup sweep, which deletes orphans. It must never be able to
 * match anything the user put there, so it matches on our own suffixes alone.
 */
export function isDracoIntermediate(name: string): boolean {
  return PART_SUFFIXES.some((suffix) => name.endsWith(suffix)) ||
    /\.dracodl\.audio\.\d+$/.test(name) ||
    /\.dracodl(\.json)?\.[0-9a-f-]{36}\.tmp$/i.test(name) ||
    TEMP_MEDIA_PATTERN.test(name) ||
    name.endsWith(DIR_SUFFIX)
}
