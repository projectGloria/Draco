import { copyFile, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { run, fetchText } from './build-support.mjs'

const require = createRequire(import.meta.url)
const { getMakeNsisPath } = require('app-builder-lib/out/toolsets/windows.js')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (process.platform !== 'win32' || process.arch !== 'x64' || process.versions.electron) throw new Error('Build the CLI installer with Windows x64 Node.js')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
console.log('Preparing standalone CLI files…')
await mkdir(join(root, '.build-cache'), { recursive: true })
const stage = await mkdtemp(join(root, '.build-cache', 'cli-'))
await mkdir(join(stage, 'out'), { recursive: true })
await cp(join(root, 'out/main'), join(stage, 'out/main'), { recursive: true, filter: source => !source.endsWith('index.js') })
await mkdir(join(stage, 'resources'), { recursive: true })
await cp(join(root, 'resources/runtime'), join(stage, 'resources/runtime'), { recursive: true })
await copyFile(join(root, 'resources/icon.ico'), join(stage, 'resources/icon.ico'))
await copyFile(process.execPath, join(stage, 'node.exe'))
await writeFile(join(stage, 'NODE-LICENSE.txt'), await fetchText(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`))
await copyFile(join(root, 'package.json'), join(stage, 'package.json'))
await copyFile(join(root, 'package-lock.json'), join(stage, 'package-lock.json'))
console.log('Installing CLI dependencies…')
await run('cmd.exe', ['/d', '/s', '/c', 'npm ci --omit=dev --ignore-scripts --no-audit --no-fund'], { cwd: stage })
// node-datachannel fetches its Node-API prebuild in a postinstall script.
// Reuse the desktop build's checked binary only for the identical package version.
const nativePackage = 'node-datachannel'
const installed = JSON.parse(await readFile(join(root, 'node_modules', nativePackage, 'package.json'), 'utf8'))
const staged = JSON.parse(await readFile(join(stage, 'node_modules', nativePackage, 'package.json'), 'utf8'))
if (installed.version !== staged.version) throw new Error('Native package version mismatch; run npm ci in the project first')
await cp(join(root, 'node_modules', nativePackage, 'build'), join(stage, 'node_modules', nativePackage, 'build'), { recursive: true })
console.log(await run(join(stage, 'node.exe'), [join(root, 'tools/check-native.cjs'), join(stage, 'node_modules')]))
await writeFile(join(stage, 'draco.cmd'), '@echo off\r\nsetlocal\r\nset "DRACO_CLI_ROOT=%~dp0"\r\n"%~dp0node.exe" "%~dp0out\\main\\cli.js" %*\r\nexit /b %errorlevel%\r\n')
// Verify startup with only the standalone files and its own runtime.
console.log(await run(join(stage, 'node.exe'), [join(stage, 'out/main/cli.js'), '--ignore-config', '--version'], { env: { ...process.env, DRACO_CLI_ROOT: stage } }))
console.log('Building CLI installer…')
const nsis = await getMakeNsisPath()
await mkdir(join(root, 'dist'), { recursive: true })
const destination = join(root, 'dist', `Draco-CLI-${pkg.version}-x64-Setup.exe`)
console.log(await run(nsis.path, ['/V2', `/DSTAGE=${stage}`, `/DOUTPUT=${destination}`, `/DVERSION=${pkg.version}`, `/DRESOURCES=${join(root, 'resources')}`, join(root, 'resources/cli-installer.nsi')], { env: { ...process.env, ...nsis.env }, timeoutMs: 20 * 60_000 }))
console.log(`CLI installer: ${destination}`)
console.log(`Standalone files for verification: ${stage}`)
