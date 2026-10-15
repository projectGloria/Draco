import { notStrictEqual, rejects, strictEqual } from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { closeDispatchers, getDispatcher } from '../src/main/engine/http.ts'
import { requestGuarded } from '../src/main/fetch-guard.ts'

test('timeout changes retire old pools while frequently used pools remain cached', async () => {
  try {
    const first = getDispatcher(1000)
    const used = getDispatcher(1001)
    for (let timeout = 1002; timeout <= 1008; timeout++) {
      getDispatcher(timeout)
      strictEqual(getDispatcher(1001), used)
    }
    notStrictEqual(getDispatcher(1000), first, 'the oldest unused pool has been retired')
  } finally {
    await closeDispatchers()
  }
})

test('shutdown releases pools even when a response never finishes', { timeout: 3000 }, async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200)
    response.write('unfinished body')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { response } = await requestGuarded(`http://127.0.0.1:${(server.address() as AddressInfo).port}/file`, { timeoutMs: 30_000 })
    const checked = rejects(response.body.text())
    await closeDispatchers()
    await checked
  } finally {
    await closeDispatchers()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
