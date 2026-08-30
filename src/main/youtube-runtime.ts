/**
 * yt-dlp needs a JavaScript runtime for YouTube's player challenges.
 *
 * Electron already ships a sufficiently new Node runtime. Pointing yt-dlp at
 * the running executable and setting ELECTRON_RUN_AS_NODE makes that runtime
 * available in both development and packaged builds without asking the user to
 * install Deno or add Node to PATH.
 */
export function electronNodeRuntimeArgs(executable = process.execPath): string[] {
  return ['--js-runtimes', `node:${executable}`]
}

export function electronNodeRuntimeEnv(
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return { ...base, ELECTRON_RUN_AS_NODE: '1' }
}
