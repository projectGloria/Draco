import { join } from 'node:path'
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

/** The `.dracodl` a single ranged download accumulates into. */
export function partPathFor(taskDir: string, filename: string, tempDir?: string): string {
  return join(workspaceDir(taskDir, tempDir), filename + '.dracodl')
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
  task: Pick<DownloadTask, 'dir' | 'filename' | 'audioUrl' | 'audioTracks'>,
  tempDir?: string
): { files: string[]; dirs: string[] } {
  const files = new Set<string>()
  const dirs = new Set<string>()

  const stems = [task.filename]
  // The muxed halves are Draco's own intermediates, and each is a download in
  // its own right with a part file and journal of its own.
  if (task.audioUrl) stems.push(task.filename + '.v.mp4', task.filename + '.a.m4a')

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
  }

  return { files: [...files], dirs: [...dirs] }
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

