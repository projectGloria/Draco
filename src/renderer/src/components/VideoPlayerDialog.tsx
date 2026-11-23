import { useEffect, useRef, useState } from 'react'
import type { WatchSessionInfo } from '@shared/types'
import { formatBytes, formatEta, formatPercent, formatSpeed, percent } from '../lib/format'
import { useT } from '../i18n'
import { useApp } from '../store/app'
import { reportError, toast } from '../store/toasts'
import Dialog, { GhostButton, PrimaryButton } from './Dialog'
import { CopyIcon, FolderIcon, PauseIcon, PlayIcon, VideoIcon } from './Icons'
import ProgressBar from './ProgressBar'

export default function VideoPlayerDialog({
  taskId,
  torrentFilePath,
  onClose
}: {
  taskId: string
  torrentFilePath?: string
  onClose(): void
}): React.ReactElement | null {
  const t = useT()
  const task = useApp((s) => s.tasks.find((item) => item.id === taskId))
  const [session, setSession] = useState<WatchSessionInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [waitingForBytes, setWaitingForBytes] = useState(false)
  const [streamGeneration, setStreamGeneration] = useState(0)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const savedTimeRef = useRef<number>(0)
  const wasDoneRef = useRef<boolean>(task?.status === 'done')

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    void window.api
      .prepareWatch(taskId, torrentFilePath)
      .then((info) => {
        if (!active) return
        setSession(info)
        wasDoneRef.current = info.status === 'done'
      })
      .catch((err) => {
        if (!active) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [taskId, torrentFilePath, streamGeneration])

  // When a dual-stream or HLS download finishes muxing while the user is watching,
  // refresh the session seamlessly and restore the exact playback timestamp.
  useEffect(() => {
    if (!task || !session) return
    if (!wasDoneRef.current && task.status === 'done') {
      wasDoneRef.current = true
      if (videoRef.current) {
        savedTimeRef.current = videoRef.current.currentTime
      }
      if (session.audioStreamUrl || task.kind === 'hls') {
        setStreamGeneration((gen) => gen + 1)
      }
    }
  }, [task?.status, task?.kind, session])

  // Synchronize separate audio element when watching an unmuxed dual-stream download
  useEffect(() => {
    const video = videoRef.current
    const audio = audioRef.current
    if (!video || !audio || !session?.audioStreamUrl) return

    const onPlay = (): void => {
      audio.playbackRate = video.playbackRate
      if (Math.abs(audio.currentTime - video.currentTime) > 0.25) {
        audio.currentTime = video.currentTime
      }
      void audio.play().catch(() => {})
    }
    const onPause = (): void => {
      audio.pause()
    }
    const onWaiting = (): void => {
      audio.pause()
    }
    const onPlaying = (): void => {
      if (Math.abs(audio.currentTime - video.currentTime) > 0.25) {
        audio.currentTime = video.currentTime
      }
      void audio.play().catch(() => {})
    }
    const onSeeked = (): void => {
      audio.currentTime = video.currentTime
      if (!video.paused) void audio.play().catch(() => {})
    }
    const onRateChange = (): void => {
      audio.playbackRate = video.playbackRate
    }
    const onVolumeChange = (): void => {
      audio.volume = video.volume
      audio.muted = video.muted
    }
    const onTimeUpdate = (): void => {
      if (!video.paused && !audio.paused && Math.abs(audio.currentTime - video.currentTime) > 0.35) {
        audio.currentTime = video.currentTime
      }
    }

    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('playing', onPlaying)
    video.addEventListener('seeked', onSeeked)
    video.addEventListener('ratechange', onRateChange)
    video.addEventListener('volumechange', onVolumeChange)
    video.addEventListener('timeupdate', onTimeUpdate)

    return () => {
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('ratechange', onRateChange)
      video.removeEventListener('volumechange', onVolumeChange)
      video.removeEventListener('timeupdate', onTimeUpdate)
    }
  }, [session?.audioStreamUrl, streamGeneration])

  const totalSize = task?.size ?? task?.expectedSize ?? session?.size ?? null
  const received = task?.received ?? session?.received ?? 0
  const pct = totalSize && totalSize > 0 ? percent(received, totalSize) : task?.status === 'done' ? 100 : null
  const isDownloading =
    task?.status === 'downloading' ||
    task?.status === 'probing' ||
    task?.status === 'queued' ||
    task?.status === 'processing'
  const isAudioOnly = session?.mimeType.startsWith('audio/') ?? false

  return (
    <Dialog
      title={session?.title ?? task?.filename ?? t('watchWhileDownloading')}
      subtitle={
        task?.status === 'done'
          ? t('watchCompletedBadge')
          : `${t('watchLiveBadge')} · ${formatBytes(received)}${totalSize ? ` / ${formatBytes(totalSize)} (${formatPercent(received, totalSize)})` : ''}`
      }
      width={900}
      onClose={onClose}
      autoFocus={false}
      footer={
        <>
          <div className="mr-auto flex items-center gap-2 text-[11.5px] text-muted">
            <span
              className={'w-2 h-2 rounded-full shrink-0 ' + (isDownloading ? 'animate-pulse' : '')}
              style={{ background: task?.status === 'done' ? 'var(--color-ok)' : 'var(--accent)' }}
            />
            <span className="tnum">
              {task?.status === 'done'
                ? t('watchCompletedBadge')
                : isDownloading && (task?.speed ?? 0) > 0
                  ? `${formatSpeed(task?.speed ?? 0)}${task?.eta ? ` · ${formatEta(task.eta)} ${t('remaining')}` : ''}`
                  : t('watchLiveBadge')}
            </span>
            {session?.audioStreamUrl && (
              <span className="rounded-md border border-line bg-white/[0.04] px-2 py-0.5 text-[10.5px] text-faint">
                {t('watchDualStreamBadge')}
              </span>
            )}
          </div>

          {task && task.status !== 'done' && (
            <GhostButton
              onClick={() => {
                const call = isDownloading
                  ? window.api.pauseTasks([task.id])
                  : window.api.startTasks([task.id])
                void call.catch((err) => reportError(t('commandFailed'), err))
              }}
            >
              <span className="flex items-center gap-1.5">
                {isDownloading ? <PauseIcon className="w-3.5 h-3.5" /> : <PlayIcon className="w-3.5 h-3.5" />}
                {isDownloading ? t('stop') : t('resume')}
              </span>
            </GhostButton>
          )}

          {task && (
            <GhostButton onClick={() => void window.api.revealFile(task.id)}>
              <span className="flex items-center gap-1.5">
                <FolderIcon className="w-3.5 h-3.5" />
                {t('openFolder')}
              </span>
            </GhostButton>
          )}

          {session?.externalStreamUrl && (
            <GhostButton
              onClick={() => {
                void window.api.copyToClipboard(session.externalStreamUrl!)
                toast('info', t('watchStreamUrlCopied'))
              }}
            >
              <span className="flex items-center gap-1.5">
                <CopyIcon className="w-3.5 h-3.5" />
                {t('watchCopyStreamUrl')}
              </span>
            </GhostButton>
          )}

          {task && (
            <GhostButton
              onClick={() => {
                videoRef.current?.pause()
                audioRef.current?.pause()
                void window.api
                  .watchExternal(task.id, torrentFilePath)
                  .then((ok) => {
                    if (!ok) toast('info', t('watchExternalFailed'))
                  })
                  .catch((err) => reportError(t('watchExternalFailed'), err))
              }}
            >
              {t('watchOpenExternal')}
            </GhostButton>
          )}

          <PrimaryButton onClick={onClose}>{t('close')}</PrimaryButton>
        </>
      }
    >
      <div className="space-y-3">
        <div className="relative rounded-xl overflow-hidden border border-line bg-black aspect-video flex items-center justify-center">
          {loading ? (
            <div className="flex flex-col items-center gap-2 text-muted text-[12.5px]">
              <span className="w-6 h-6 rounded-full border-2 border-faint border-t-[var(--accent)] animate-spin" />
              <span>{t('watchWaitingFirstBytes')}</span>
            </div>
          ) : error ? (
            <div className="px-8 text-center space-y-3">
              <div className="text-[13px] font-semibold text-err">{t('watchFailed')}</div>
              <p className="text-[12px] text-muted max-w-md">{error}</p>
              <GhostButton onClick={() => setStreamGeneration((g) => g + 1)}>{t('retry')}</GhostButton>
            </div>
          ) : session ? (
            <>
              {isAudioOnly && (
                <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center gap-2 text-muted">
                  <VideoIcon className="w-10 h-10 text-[var(--accent)] opacity-80" />
                  <span className="text-[12.5px] font-medium">{session.title}</span>
                </div>
              )}
              <video
                key={`${session.streamUrl}:${streamGeneration}`}
                ref={videoRef}
                src={`${session.streamUrl}&g=${streamGeneration}`}
                controls
                autoPlay
                playsInline
                className="w-full h-full object-contain bg-black outline-none"
                onWaiting={() => setWaitingForBytes(true)}
                onPlaying={() => setWaitingForBytes(false)}
                onCanPlay={() => setWaitingForBytes(false)}
                onLoadedMetadata={(e) => {
                  if (savedTimeRef.current > 0) {
                    e.currentTarget.currentTime = savedTimeRef.current
                    savedTimeRef.current = 0
                  }
                }}
                onError={() => {
                  // If the partial file is still receiving its first header bytes, retry once automatically
                  if (isDownloading && received < 512 * 1024) {
                    setWaitingForBytes(true)
                    setTimeout(() => setStreamGeneration((g) => g + 1), 1200)
                  }
                }}
              />
              {session.audioStreamUrl && (
                <audio
                  key={`${session.audioStreamUrl}:${streamGeneration}`}
                  ref={audioRef}
                  src={`${session.audioStreamUrl}&g=${streamGeneration}`}
                  preload="auto"
                />
              )}

              {waitingForBytes && task?.status !== 'done' && (
                <div className="pointer-events-none absolute top-3 right-3 flex items-center gap-2 rounded-lg border border-line bg-black/75 px-3 py-1.5 text-[11.5px] text-ink backdrop-blur-sm">
                  <span className="w-3.5 h-3.5 rounded-full border-2 border-faint border-t-[var(--accent)] animate-spin" />
                  <span>
                    {t('watchBufferingRange', {
                      percent: totalSize ? formatPercent(received, totalSize) : formatBytes(received)
                    })}
                  </span>
                </div>
              )}
            </>
          ) : null}
        </div>

        {task && (
          <div className="rounded-lg border border-line bg-white/[0.02] px-3.5 py-2.5 space-y-1.5">
            <div className="flex items-center justify-between text-[11.5px]">
              <span className="text-muted truncate">{task.detail ?? task.filename}</span>
              <span className="tnum text-faint shrink-0 ml-3">
                {formatBytes(received)}
                {totalSize ? ` / ${formatBytes(totalSize)}` : ''}
                {pct !== null ? ` · ${pct.toFixed(1)}%` : ''}
              </span>
            </div>
            <ProgressBar percent={pct} status={task.status} height={6} />
          </div>
        )}
      </div>
    </Dialog>
  )
}
