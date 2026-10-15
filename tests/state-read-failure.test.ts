import { rejects, strictEqual } from 'node:assert/strict'
import { build } from 'esbuild'
import { it } from 'node:test'

async function unreadableState(code: string): Promise<any> {
  const bundled = await build({
    stdin: { contents: `export { readJsonOrThrowIfPresent } from './src/main/json-file.ts'; export { readSealedJsonFile } from './src/main/sealed-json.ts'`, resolveDir: process.cwd() },
    bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{ name: 'inaccessible-state-files', setup(builder) {
      builder.onResolve({ filter: /^node:fs\/promises$/ }, (args) => args.namespace === 'fault'
        ? { path: args.path, external: true } : { path: args.path, namespace: 'fault' })
      builder.onLoad({ filter: /.*/, namespace: 'fault' }, () => ({ contents: `
        export * from 'node:fs/promises';
        const fail = async () => { throw Object.assign(new Error('inaccessible saved state'), { code: ${JSON.stringify(code)} }); };
        export const readFile = fail; export const stat = fail;
      ` }))
    } }]
  })
  return import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'))
}

it('refuses to initialize empty state when the primary and backup cannot even be inspected', async () => {
  const state = await unreadableState('EACCES')
  await rejects(state.readJsonOrThrowIfPresent('settings.json'), /invalid or inaccessible/)
  await rejects(state.readSealedJsonFile('tasks.json', { open: () => '', seal: () => '' }), /invalid or inaccessible/)
})

it('permits first-run initialization when both saved-state files are absent', async () => {
  const state = await unreadableState('ENOENT')
  strictEqual(await state.readJsonOrThrowIfPresent('settings.json'), null)
  strictEqual(await state.readSealedJsonFile('tasks.json', { open: () => '', seal: () => '' }), null)
})
