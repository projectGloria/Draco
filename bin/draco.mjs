#!/usr/bin/env node
/**
 * Dev entry point for the `draco` command (`npm link` puts it on PATH).
 *
 * Runs src/cli/draco.ts as source through Node's type stripping - no build.
 * The installed app ships its own launcher, resources/bin/draco.cmd, which
 * runs the bundled copy inside Draco.exe instead.
 */

// The repo's package.json has no "type", so Node reparses each .ts as ESM and
// says so once per file - a dozen lines of noise in front of every command.
// Node prints warnings through a 'warning' listener it installs at startup;
// replacing it filters just those two codes and keeps every other warning.
const defaults = process.listeners('warning')
process.removeAllListeners('warning')
const QUIET = new Set(['MODULE_TYPELESS_PACKAGE_JSON'])
process.on('warning', (warning) => {
  if (QUIET.has(warning.code)) return
  // Type stripping is stable on current Node but still "experimental" on the
  // 22.x line the engines field allows.
  if (warning.name === 'ExperimentalWarning' && /type stripping/i.test(warning.message)) return
  for (const listener of defaults) listener(warning)
})

const { main } = await import('../src/cli/draco.ts')
process.exit(await main(process.argv.slice(2)))
