import test from 'node:test'
import assert from 'node:assert/strict'
import {
  electronNodeRuntimeArgs,
  electronNodeRuntimeEnv
} from '../src/main/youtube-runtime.ts'

test('yt-dlp is pointed at Electron as an explicit Node runtime', () => {
  assert.deepEqual(
    electronNodeRuntimeArgs('C:\\Program Files\\Draco\\Draco.exe'),
    ['--js-runtimes', 'node:C:\\Program Files\\Draco\\Draco.exe']
  )
})

test('the yt-dlp child can launch Electron in Node mode without losing its environment', () => {
  assert.deepEqual(
    electronNodeRuntimeEnv({ PATH: 'example' }),
    { PATH: 'example', ELECTRON_RUN_AS_NODE: '1' }
  )
})
