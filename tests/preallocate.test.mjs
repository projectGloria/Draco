import test from 'node:test'
import assert from 'node:assert/strict'
import {
  forgetPreallocationSupport,
  preallocate,
  volumeRootOf
} from '../src/main/engine/preallocate.ts'

/**
 * Stands in for fsutil and the filesystem, recording the sequence so the order
 * of the calls can be asserted - reserving the range before declaring it valid
 * is the part that has to be right.
 */
function fake({ allowValidData = true, allowSparse = true } = {}) {
  const calls = []
  return {
    calls,
    async run(file, args) {
      calls.push([file, ...args].join(' '))
      if (args[0] === 'file' && args[1] === 'setvaliddata' && !allowValidData) {
        throw new Error('A required privilege is not held by the client.')
      }
      if (args[0] === 'sparse' && !allowSparse) throw new Error('not supported')
    },
    async create(path) {
      calls.push(`create ${path}`)
    },
    async truncate(path, size) {
      calls.push(`truncate ${path} ${size}`)
    }
  }
}

test('a volume that permits it gets a contiguous file with no zero-fill', async () => {
  forgetPreallocationSupport()
  const deps = fake()

  const mode = await preallocate('C:\\dl\\a.dracodl', 4096, deps)

  assert.equal(mode, 'valid-data')
  assert.deepEqual(deps.calls, [
    'create C:\\dl\\a.dracodl',
    // The range must exist before it can be declared valid.
    'truncate C:\\dl\\a.dracodl 4096',
    'fsutil file setvaliddata C:\\dl\\a.dracodl 4096'
  ])
})

test('an unprivileged run falls back to sparse and gives the clusters back first', async () => {
  forgetPreallocationSupport()
  const deps = fake({ allowValidData: false })

  const mode = await preallocate('C:\\dl\\a.dracodl', 4096, deps)

  assert.equal(mode, 'sparse')
  assert.deepEqual(deps.calls, [
    'create C:\\dl\\a.dracodl',
    'truncate C:\\dl\\a.dracodl 4096',
    'fsutil file setvaliddata C:\\dl\\a.dracodl 4096',
    // Marking the file sparse only governs what is allocated from here on, so
    // the failed extend has to be handed back before the flag is set.
    'truncate C:\\dl\\a.dracodl 0',
    'fsutil sparse setflag C:\\dl\\a.dracodl',
    'truncate C:\\dl\\a.dracodl 4096'
  ])
})

test('a refusal is remembered, so only the first download on a volume probes', async () => {
  forgetPreallocationSupport()
  await preallocate('C:\\dl\\a.dracodl', 4096, fake({ allowValidData: false }))

  const second = fake({ allowValidData: false })
  const mode = await preallocate('C:\\dl\\b.dracodl', 8192, second)

  assert.equal(mode, 'sparse')
  assert.ok(
    !second.calls.some((call) => call.includes('setvaliddata')),
    'the privilege is the process\'s and it has not changed within the session'
  )
})

test('each volume is asked separately', async () => {
  forgetPreallocationSupport()
  await preallocate('C:\\dl\\a.dracodl', 4096, fake({ allowValidData: false }))

  // A refusal on the system disk says nothing about the other one.
  const other = fake()
  assert.equal(await preallocate('D:\\dl\\a.dracodl', 4096, other), 'valid-data')
  assert.ok(other.calls.some((call) => call.includes('setvaliddata')))
})

test('a volume that supports neither is left to the first write', async () => {
  forgetPreallocationSupport()
  const deps = fake({ allowValidData: false, allowSparse: false })

  assert.equal(await preallocate('C:\\dl\\a.dracodl', 4096, deps), 'none')
})

test('nothing is reserved for a size the server never gave', async () => {
  forgetPreallocationSupport()
  for (const size of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    const deps = fake()
    assert.equal(await preallocate('C:\\dl\\a.dracodl', size, deps), 'none')
    assert.deepEqual(deps.calls, [], `size ${size} should not touch the disk`)
  }
})

test('the volume root is what the answer is remembered against', () => {
  assert.equal(volumeRootOf('C:\\dl\\a.dracodl'), 'c:\\')
  assert.equal(volumeRootOf('D:\\x\\y\\z.bin'), 'd:\\')
})
