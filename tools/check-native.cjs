const { join, resolve } = require('node:path')
const modules = resolve(process.argv[2])
// Load the actual native files: bufferutil's wrapper silently falls back to
// JavaScript, which would hide a missing or incompatible packaged binary.
for (const file of [
  'bufferutil/prebuilds/win32-x64/bufferutil.node',
  'utf-8-validate/prebuilds/win32-x64/utf-8-validate.node',
  'utp-native/prebuilds/win32-x64/node.napi.node',
  'fs-native-extensions/prebuilds/win32-x64/fs-native-extensions.node',
  'node-datachannel/build/Release/node_datachannel.node'
]) {
  const binding = require(join(modules, file))
  binding.cleanup?.()
  console.log(`Native binary loaded: ${file}`)
}
