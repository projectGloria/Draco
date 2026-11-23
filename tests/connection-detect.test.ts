import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { analyzeConnection, recommendConnectionSettings } from '../src/main/connection-detect.ts'
import type { ConnectionAnalysisProgress } from '../src/shared/types.ts'

describe('Connection auto-detect recommendations', () => {
  it('recommends conservative settings for slow or high-latency connections', () => {
    const slow = recommendConnectionSettings(240, 500 * 1024, 900 * 1024)
    strictEqual(slow.profile, 'slow')
    strictEqual(slow.maxConcurrentTasks, 2)
    strictEqual(slow.maxConnectionsPerTask, 4)
    strictEqual(slow.adaptiveConnectionCeiling, 8)
    strictEqual(slow.minSplitSize, 512 * 1024)
    strictEqual(slow.retryLimit, 8)
    strictEqual(slow.timeoutMs, 60_000)
  })

  it('recommends standard settings for medium broadband connections', () => {
    const medium = recommendConnectionSettings(45, 3 * 1024 * 1024, 5 * 1024 * 1024)
    strictEqual(medium.profile, 'medium')
    strictEqual(medium.maxConcurrentTasks, 3)
    strictEqual(medium.maxConnectionsPerTask, 8)
    strictEqual(medium.adaptiveConnectionCeiling, 12)
    strictEqual(medium.minSplitSize, 1024 * 1024)
    strictEqual(medium.retryLimit, 5)
    strictEqual(medium.timeoutMs, 30_000)
  })

  it('recommends wider parallelism for fast broadband connections', () => {
    const fast = recommendConnectionSettings(28, 12 * 1024 * 1024, 22 * 1024 * 1024)
    strictEqual(fast.profile, 'fast')
    strictEqual(fast.maxConcurrentTasks, 4)
    strictEqual(fast.maxConnectionsPerTask, 12)
    strictEqual(fast.adaptiveConnectionCeiling, 16)
    strictEqual(fast.minSplitSize, 2 * 1024 * 1024)
  })

  it('recommends high concurrency and larger split sizes for ultra fiber connections', () => {
    const ultra = recommendConnectionSettings(12, 30 * 1024 * 1024, 65 * 1024 * 1024)
    strictEqual(ultra.profile, 'ultra')
    strictEqual(ultra.maxConcurrentTasks, 5)
    strictEqual(ultra.maxConnectionsPerTask, 16)
    strictEqual(ultra.adaptiveConnectionCeiling, 32)
    strictEqual(ultra.minSplitSize, 4 * 1024 * 1024)
    strictEqual(ultra.timeoutMs, 20_000)
  })

  it('runs the full staged analysis and emits monotonic progress', async () => {
    const stages: ConnectionAnalysisProgress[] = []
    const result = await analyzeConnection(
      (progress) => stages.push(progress),
      {
        async measureLatency() {
          return 22
        },
        async measureBandwidth(connections) {
          return connections === 1 ? 10 * 1024 * 1024 : 24 * 1024 * 1024
        }
      }
    )

    deepStrictEqual(stages.map((s) => s.stage), ['latency', 'single', 'multi', 'done'])
    ok(stages.every((s, idx) => idx === 0 || s.percent >= stages[idx - 1].percent))
    strictEqual(result.profile, 'fast')
    strictEqual(result.latencyMs, 22)
    strictEqual(result.effectiveSpeedBps, 24 * 1024 * 1024)
    strictEqual(result.maxConcurrentTasks, 4)
    strictEqual(result.maxConnectionsPerTask, 12)
  })

  it('rejects when bandwidth probes transfer 0 bytes', async () => {
    await rejects(
      () =>
        analyzeConnection(
          () => {},
          {
            async measureLatency() {
              return 30
            },
            async measureBandwidth() {
              return 0
            }
          }
        ),
      /0 bytes/
    )
  })
})
