/**
 * Bundle entry the NSIS installer runs (out/main/path-setup.js), with
 * Draco.exe acting as Node via ELECTRON_RUN_AS_NODE:
 *
 *   path-setup.js add    <dir>   - setup: put draco.cmd's folder on PATH
 *   path-setup.js remove <dir>   - uninstall: take it back off
 *
 * The installer delegates instead of editing PATH itself because NSIS strings
 * have a fixed size, and a user PATH longer than that comes back truncated -
 * this way setup, uninstall and the Options toggle all share one tested
 * implementation in `cli-path.ts`.
 *
 * Never fails the install: a PATH problem is reported in the installer's log
 * and the exit code, and the app's own start-up sync gets another go at it.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { addCliToPath, removeCliFromPath } from '../main/cli-path.ts'

async function run([action, dir]: string[]): Promise<number> {
  if (!dir || (action !== 'add' && action !== 'remove')) {
    process.stderr.write('usage: path-setup add|remove <dir>\n')
    return 2
  }
  if (action === 'add') {
    // Refuse to point PATH at a folder that would not actually give `draco`.
    if (!existsSync(join(dir, 'draco.cmd'))) {
      process.stderr.write(`draco.cmd not found in ${dir}; PATH left unchanged\n`)
      return 1
    }
    const changed = await addCliToPath(dir)
    process.stdout.write(changed ? `added ${dir} to PATH; draco works in new terminals\n` : `${dir} is already on PATH\n`)
  } else {
    const changed = await removeCliFromPath(dir)
    process.stdout.write(changed ? `removed ${dir} from PATH\n` : `${dir} was not on PATH\n`)
  }
  return 0
}

void run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`PATH update failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
)
