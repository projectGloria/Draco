import { spawn, type ChildProcess } from 'node:child_process'

/**
 * Kills a spawned process and everything it started.
 *
 * `child.kill()` only signals the direct child. On Windows that orphans any
 * grandchildren, and the processes this app spawns have them: yt-dlp runs
 * Draco's own executable as an Electron-as-Node EJS worker, and ffmpeg
 * provisioners extract archives. A timed-out parent that dies alone leaves
 * the rest of the tree running.
 *
 * `taskkill /T /F` walks the whole tree; the plain kill is the fallback for
 * the (non-Windows) development case where taskkill does not exist.
 */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return

  const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
    shell: false,
    windowsHide: true,
    stdio: 'ignore'
  })
  killer.on('error', () => child.kill('SIGKILL'))
  killer.on('close', (code) => {
    if (code !== 0 && child.exitCode === null) child.kill('SIGKILL')
  })
}
