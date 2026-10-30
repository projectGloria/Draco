// Exercise the installed launcher entry in a fresh native console.
// Piped test runners cannot reproduce Electron's inherited NUL stdin handle.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { strict as assert } from 'node:assert'

if (process.platform !== 'win32') throw new Error('The native console smoke test requires Windows')
const execute = promisify(execFile)
const target = resolve(process.argv[2] ?? 'dist/win-unpacked')
const standalone = process.argv.includes('--standalone')
const launcher = standalone ? join(target, 'draco.cmd') : join(target, 'resources', 'bin', 'draco.cmd')
const executable = join(target, standalone ? 'node.exe' : 'Draco.exe')
const entry = standalone ? join(target, 'out', 'main', 'cli.js') : join(target, 'resources', 'bin', 'draco.cjs')
assert.match(await readFile(launcher, 'utf8'), standalone ? /node\.exe/ : /"%~dp0draco\.cjs" %\*/)
const work = await mkdtemp(join(tmpdir(), 'draco-console-smoke-'))
const result = join(work, 'result.json')
try {
  const observer = join(work, 'observer.cjs')
  await writeFile(observer, `
    const fs = require('node:fs');
    let output = '', errors = '';
    const write = process.stdout.write.bind(process.stdout);
    const error = process.stderr.write.bind(process.stderr);
    process.stdout.write = (s, ...args) => { output += s.toString(); return write(s, ...args) };
    process.stderr.write = (s, ...args) => { errors += s.toString(); return error(s, ...args) };
    process.on('exit', code => fs.writeFileSync(${JSON.stringify(result)}, JSON.stringify({
      code, input: output.includes('Paste a link'), header: (output.includes('DRACO') || output.includes('Make it yours')) && output.includes('F4 show in'),
      restored: output.includes('\\x1b[?1049l'), errors
    })));
    setTimeout(() => process.emit('SIGINT'), 1000).unref();
    setTimeout(() => process.exit(9), 6000).unref();
    require(${JSON.stringify(entry)});
  `)
  const batch = join(work, 'launch.cmd')
  await writeFile(batch, `@echo off\r\nsetlocal\r\nset "DRACO_CLI_ROOT=${standalone ? target : ''}"\r\nset ELECTRON_RUN_AS_NODE=1\r\nset TERM=dumb\r\nset NO_COLOR=\r\nset FORCE_COLOR=1\r\n"${executable}" "${observer}"\r\n`)
  const quote = s => `'${s.replaceAll("'", "''")}'`
  const command = `Start-Process -FilePath $env:ComSpec -ArgumentList @('/d','/c',${quote(`""${batch}""`)}) -WindowStyle Hidden -Wait`
  await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true, timeout: 45000
  })
  const checked = JSON.parse(await readFile(result, 'utf8'))
  assert.deepEqual(checked, { code: 0, input: true, header: true, restored: true, errors: '' })
  const { stdout } = await execute(executable, [entry, '--ignore-config', '--version'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' }, windowsHide: true, timeout: 10000
  })
  assert.match(stdout, /^draco \d+\.\d+\.\d+/)
  console.log('Native Windows launcher: compact UI, input, Ctrl+C cleanup and --version passed.')
} finally {
  const temporaryRoot = resolve(tmpdir()) + sep
  if (!resolve(work).startsWith(temporaryRoot)) throw new Error('Unexpected smoke-test temporary directory')
  await rm(work, { recursive: true, force: true })
}
