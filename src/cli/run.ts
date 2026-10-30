/**
 * Bundle entry for the packaged CLI (out/main/cli.js).
 *
 * `draco.ts` only exports `main` so tests and the dev launcher can drive it;
 * something has to call it. Not top-level await: the main bundle is CommonJS.
 */
import { main } from './draco.ts'

void main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`draco: ${error instanceof Error ? process.argv.includes('--verbose') || process.argv.includes('-v') ? error.stack ?? error.message : error.message : String(error)}\n`)
    process.exit(1)
  }
)
