/**
 * Pins the extension's ID without ever touching the Chrome Web Store.
 *
 *   node tools/gen-extension-key.mjs
 *
 * An unpacked extension normally gets an ID derived from its folder path, which
 * changes the moment the folder moves. That would be fatal here: the native
 * messaging manifest names the allowed extension by ID, so a shifting ID means
 * the browser link silently stops working.
 *
 * Chrome derives the ID from the `key` field when one is present. So: generate
 * an RSA key locally, put its public half in the manifest, and the ID becomes
 * permanent. The private half is never needed again - it is only kept so the
 * same identity can be reissued if the manifest is ever rebuilt from scratch.
 */
import { generateKeyPairSync, createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(root, 'extension', 'manifest.json')
const pemPath = join(root, 'extension', 'key.pem')

/**
 * Chrome's ID alphabet: the first 16 bytes of the SHA-256 of the DER public
 * key, hex-encoded, with 0-9a-f mapped onto a-p.
 */
function extensionIdFromDer(der) {
  const digest = createHash('sha256').update(der).digest('hex').slice(0, 32)
  return [...digest].map((ch) => String.fromCharCode(parseInt(ch, 16) + 97)).join('')
}

let der
let pem

if (existsSync(pemPath)) {
  // Reusing the existing key keeps the ID stable across reruns - regenerating
  // it would invalidate the registry entry and every allowed_origins line.
  pem = readFileSync(pemPath, 'utf8')
  const { createPrivateKey, createPublicKey } = await import('node:crypto')
  der = createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'der' })
  console.log('reusing existing extension/key.pem')
} else {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  })
  der = pair.publicKey
  pem = pair.privateKey
  writeFileSync(pemPath, pem, 'utf8')
  console.log('wrote extension/key.pem (gitignored - keep it, do not publish it)')
}

const key = Buffer.from(der).toString('base64')
const id = extensionIdFromDer(der)

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.key = key
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

console.log('extension id :', id)
console.log('manifest     :', manifestPath)
console.log()
console.log('Load unpacked from:', join(root, 'extension'))
