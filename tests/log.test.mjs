import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flushLogs, logger, setLogDirectory } from '../src/main/log.ts'

test('production-style logging writes after its app-data directory is configured', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'draco-log-'))
  try {
    setLogDirectory(dir)
    logger('test').error('preserved failure', new Error('root cause'))
    await flushLogs()
    const content = await readFile(join(dir, 'main.log'), 'utf8')
    assert.match(content, /ERROR \[test\] preserved failure: Error: root cause/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
