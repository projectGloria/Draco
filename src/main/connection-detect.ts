import { performance } from 'node:perf_hooks'
import { fetchGuarded } from './fetch-guard.ts'
import { logger } from './log.ts'
import type { ConnectionAnalysisProgress, ConnectionAnalysisResult, ConnectionProfile } from '../shared/types.ts'

const log = logger('connection-detect')

export interface ConnectionProbeDeps {
  measureLatency(): Promise<number>
  measureBandwidth(connections: number, durationMs: number): Promise<number>
}

export interface SuggestedConnectionSettings {
  profile: ConnectionProfile
  maxConcurrentTasks: number
  maxConnectionsPerTask: number
  adaptiveConnectionCeiling: number | null
  minSplitSize: number
  retryLimit: number
  timeoutMs: number
}

/**
 * Derives optimal connection settings from measured single-stream speed,
 * multi-stream speed, and round-trip latency.
 *
 * Pure function so the heuristic can be tested across connection tiers without
 * hitting live endpoints.
 */
export function recommendConnectionSettings(
  latencyMs: number,
  singleSpeedBps: number,
  multiSpeedBps: number
): SuggestedConnectionSettings {
  const effectiveSpeed = Math.max(singleSpeedBps, multiSpeedBps)
  const mbPerSec = effectiveSpeed / (1024 * 1024)
  const parallelGain = singleSpeedBps > 0 ? multiSpeedBps / singleSpeedBps : 1
  const highLatency = latencyMs >= 160

  let profile: ConnectionProfile
  let maxConcurrentTasks: number
  let maxConnectionsPerTask: number
  let adaptiveConnectionCeiling: number | null
  let minSplitSize: number
  let retryLimit: number
  let timeoutMs: number

  if (mbPerSec >= 35) {
    profile = 'ultra'
    maxConcurrentTasks = 5
    maxConnectionsPerTask = parallelGain >= 1.35 ? 16 : 12
    adaptiveConnectionCeiling = 32
    minSplitSize = 4 * 1024 * 1024
    retryLimit = 5
    timeoutMs = highLatency ? 30_000 : 20_000
  } else if (mbPerSec >= 10) {
    profile = 'fast'
    maxConcurrentTasks = 4
    maxConnectionsPerTask = parallelGain >= 1.3 ? 12 : 8
    adaptiveConnectionCeiling = 16
    minSplitSize = 2 * 1024 * 1024
    retryLimit = 5
    timeoutMs = highLatency ? 35_000 : 25_000
  } else if (mbPerSec >= 2) {
    profile = 'medium'
    maxConcurrentTasks = 3
    maxConnectionsPerTask = parallelGain >= 1.25 ? 8 : 6
    adaptiveConnectionCeiling = 12
    minSplitSize = 1024 * 1024
    retryLimit = highLatency ? 6 : 5
    timeoutMs = highLatency ? 45_000 : 30_000
  } else {
    profile = 'slow'
    maxConcurrentTasks = 2
    maxConnectionsPerTask = parallelGain >= 1.25 ? 4 : 2
    adaptiveConnectionCeiling = 8
    minSplitSize = 512 * 1024
    retryLimit = 8
    timeoutMs = 60_000
  }

  return {
    profile,
    maxConcurrentTasks,
    maxConnectionsPerTask,
    adaptiveConnectionCeiling,
    minSplitSize,
    retryLimit,
    timeoutMs
  }
}

const LATENCY_ENDPOINTS = [
  'https://speed.cloudflare.com/__down?bytes=0',
  'https://www.cloudflare.com/cdn-cgi/trace',
  'https://one.one.one.one/cdn-cgi/trace'
]

const PAYLOAD_URL_8MB = 'https://speed.cloudflare.com/__down?bytes=8388608'
const PAYLOAD_URL_4MB = 'https://speed.cloudflare.com/__down?bytes=4194304'

const defaultDeps: ConnectionProbeDeps = {
  async measureLatency(): Promise<number> {
    const samples: number[] = []
    for (const url of LATENCY_ENDPOINTS) {
      for (let i = 0; i < 2; i++) {
        const start = performance.now()
        try {
          const res = await fetchGuarded(url, {
            method: 'GET',
            timeoutMs: 6000,
            requireHttps: true,
            allowPrivate: false
          })
          await res.body?.cancel().catch(() => {})
          if (res.ok) {
            // Second request on same origin measures warm TCP/TLS RTT
            if (i === 1 || samples.length === 0) {
              samples.push(Math.max(1, Math.round(performance.now() - start)))
            }
          }
        } catch {
          // Try next endpoint
        }
      }
      if (samples.length >= 2) break
    }
    if (samples.length === 0) {
      throw new Error('Could not reach connection test servers. Check your internet connection or proxy settings.')
    }
    return Math.min(...samples)
  },

  async measureBandwidth(connections: number, durationMs: number): Promise<number> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), durationMs)
    let totalBytes = 0
    const start = performance.now()
    const url = connections === 1 ? PAYLOAD_URL_8MB : PAYLOAD_URL_4MB

    const worker = async (index: number): Promise<void> => {
      try {
        const res = await fetchGuarded(`${url}&r=${Date.now()}-${index}`, {
          method: 'GET',
          signal: controller.signal,
          timeoutMs: durationMs + 3000,
          requireHttps: true,
          allowPrivate: false
        })
        if (!res.ok || !res.body) return
        const reader = res.body.getReader()
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (value) totalBytes += value.byteLength
          }
        } finally {
          await reader.cancel().catch(() => {})
          reader.releaseLock()
        }
      } catch {
        // Expected when the measurement window timer aborts in-flight streams
      }
    }

    try {
      await Promise.allSettled(Array.from({ length: connections }, (_, i) => worker(i)))
    } finally {
      clearTimeout(timer)
    }

    const elapsedSec = Math.max(0.1, (performance.now() - start) / 1000)
    return Math.round(totalBytes / elapsedSec)
  }
}

export async function analyzeConnection(
  onProgress: (progress: ConnectionAnalysisProgress) => void,
  deps: ConnectionProbeDeps = defaultDeps
): Promise<ConnectionAnalysisResult> {
  onProgress({ stage: 'latency', percent: 12 })
  const latencyMs = await deps.measureLatency()

  onProgress({ stage: 'single', percent: 42 })
  const singleSpeedBps = await deps.measureBandwidth(1, 2200)

  onProgress({ stage: 'multi', percent: 76 })
  const multiSpeedBps = await deps.measureBandwidth(4, 2400)

  const effectiveSpeedBps = Math.max(singleSpeedBps, multiSpeedBps)
  if (effectiveSpeedBps <= 0) {
    throw new Error('Connection test transferred 0 bytes. Check your network or firewall settings.')
  }

  const suggested = recommendConnectionSettings(latencyMs, singleSpeedBps, multiSpeedBps)
  onProgress({ stage: 'done', percent: 100 })

  const result: ConnectionAnalysisResult = {
    latencyMs,
    singleSpeedBps,
    multiSpeedBps,
    effectiveSpeedBps,
    ...suggested
  }

  log.info(
    `connection analysis: ${result.profile} (${(effectiveSpeedBps / (1024 * 1024)).toFixed(2)} MB/s, ` +
    `${latencyMs} ms RTT) -> ${result.maxConcurrentTasks} tasks, ${result.maxConnectionsPerTask} conns`
  )
  return result
}
