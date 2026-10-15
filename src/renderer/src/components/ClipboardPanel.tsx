import type { ClipboardItem } from '@shared/types'
import { youtubeThumbnailUrl } from '@shared/youtube-link'
import { useT } from '../i18n'
import { formatBytes, hostOf } from '../lib/format'
import { useThumbnail } from '../lib/icons'
import { useApp } from '../store/app'
import FileIcon, { SiteIcon } from './FileIcon'
import { ClipboardIcon, TorrentIcon, TrashIcon } from './Icons'

export default function ClipboardPanel({
  onDownload
}: {
  onDownload(item: ClipboardItem): void
}): React.ReactElement {
  const items = useApp((state) => state.clipboardItems)

  return (
    <section className="flex-1 min-h-0 flex flex-col">
      <header className="h-[46px] shrink-0 px-4 border-b border-line flex items-center gap-2.5">
        <ClipboardIcon className="w-4 h-4 text-[var(--accent)]" />
        <div>
          <div className="text-[12.5px] font-semibold">Clipboard</div>
          <div className="text-[10.5px] text-faint">Copied links are prepared here without interrupting you.</div>
        </div>
      </header>

      {items.length === 0 ? (
        <div className="flex-1 grid place-items-center px-8 text-center">
          <div>
            <ClipboardIcon className="w-9 h-9 mx-auto text-faint opacity-60" />
            <div className="text-[13px] font-semibold mt-3">No copied links yet</div>
            <div className="text-[11.5px] text-faint mt-1 max-w-[360px]">
              Copy a web, YouTube, magnet, or torrent link. Draco will fetch its details in the background.
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
          {[...items].reverse().map((item) => (
            <ClipboardRow key={item.id} item={item} onDownload={onDownload} />
          ))}
        </div>
      )}
    </section>
  )
}

function ClipboardRow({
  item,
  onDownload
}: {
  item: ClipboardItem
  onDownload(item: ClipboardItem): void
}): React.ReactElement {
  const t = useT()
  const remove = (): void => {
    void window.api.removeClipboardItem(item.id)
  }

  return (
    <div
      className="rounded-xl border border-line bg-white/[0.025] hover:bg-white/[0.04] transition-colors px-3.5 py-3 flex items-center gap-3"
      onDoubleClick={() => item.status === 'ready' && onDownload(item)}
    >
      <ClipboardPreview item={item} />

      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-semibold truncate" title={item.filename ?? item.url}>
          {item.filename ?? (item.status === 'fetching' ? t('readingLink') : item.url)}
        </div>
        <div className="text-[10.5px] text-faint flex items-center gap-2 mt-0.5 min-w-0">
          <span className="truncate" title={item.url}>{hostOf(item.url) || item.url}</span>
          {item.size != null && <span className="tnum shrink-0">{formatBytes(item.size)}</span>}
          {/* A listing has no size, so its length is the useful figure there. */}
          {item.playlist && (
            <span className="tnum shrink-0">
              {t('videoCount', { count: item.playlist.count })}
            </span>
          )}
          <span className="uppercase shrink-0">{item.kind}</span>
        </div>
        {item.status === 'error' && (
          <div className="text-[10.5px] text-warn truncate mt-1" title={item.error ?? ''}>
            {item.error || t('prepareFailed')}
          </div>
        )}
      </div>

      <Status item={item} />

      <div className="flex items-center gap-1.5 shrink-0">
        {item.status === 'error' && (
          <button
            className="h-8 px-3 rounded-lg border border-line text-[11.5px] text-muted hover:text-ink hover:bg-white/[0.06]"
            onClick={() => void window.api.retryClipboardItem(item.id)}
          >
            {t('retry')}
          </button>
        )}
        <button
          className="h-8 px-3 rounded-lg text-[11.5px] font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: 'linear-gradient(135deg, var(--accent), var(--accent-2))' }}
          disabled={item.status !== 'ready'}
          onClick={() => onDownload(item)}
        >
          Download
        </button>
        <button
          className="w-8 h-8 rounded-lg grid place-items-center text-faint hover:text-danger hover:bg-white/[0.06]"
          title="Remove"
          onClick={remove}
        >
          <TrashIcon className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}

function ClipboardPreview({ item }: { item: ClipboardItem }): React.ReactElement {
  const resolution = item.youtube ?? item.media
  const previewOf = item.kind === 'youtube' || item.kind === 'media' || item.kind === 'playlist'
  /*
   * A playlist row has no resolution of its own - `prepareClipboardItem` keeps
   * a listing rather than a video - so it falls back to the id in the link,
   * which for `watch?v=X&list=Y` is a real video and for a bare `list=` is
   * nothing. `useThumbnail` is happy with null and simply draws the site icon.
   */
  const thumbnailUrl = previewOf
    ? resolution?.thumbnailUrl ?? youtubeThumbnailUrl(resolution?.id ?? item.url)
    : null
  // Unconditional: a hook cannot sit behind the `previewOf` branch below.
  const thumbnail = useThumbnail(thumbnailUrl)

  if (previewOf) {
    const previewClass = item.kind === 'media' ? 'w-[54px] h-[54px]' : 'w-24 h-[54px]'
    return (
      <div className={`${previewClass} rounded-lg bg-black/30 border border-line overflow-hidden grid place-items-center shrink-0`}>
        {thumbnail ? (
          <img src={thumbnail} alt="" draggable={false} className="w-full h-full object-cover" />
        ) : (
          <SiteIcon url={item.url} className="w-6 h-6" />
        )}
      </div>
    )
  }

  const largestTorrentFile = item.kind === 'torrent'
    ? item.probe?.torrentFiles?.reduce<{ path: string; size: number } | undefined>(
        (largest, file) => !largest || file.size > largest.size ? file : largest,
        undefined
      )
    : undefined

  return (
    <div className="w-11 h-11 rounded-lg bg-white/[0.05] grid place-items-center shrink-0">
      {item.kind === 'torrent' && !largestTorrentFile ? (
        <TorrentIcon className="w-6 h-6" />
      ) : (
        <FileIcon
          name={largestTorrentFile?.path ?? item.filename ?? item.url}
          className="w-7 h-7"
        />
      )}
    </div>
  )
}

function Status({ item }: { item: ClipboardItem }): React.ReactElement {
  const t = useT()
  if (item.status === 'fetching') {
    return (
      <div className="flex items-center gap-2 text-[11px] text-faint shrink-0">
        <span className="w-3.5 h-3.5 rounded-full border-2 border-faint border-t-[var(--accent)] animate-spin" />
        {t('fetching')}
      </div>
    )
  }
  return (
    <div className={item.status === 'ready' ? 'text-ok text-[11px] shrink-0' : 'text-warn text-[11px] shrink-0'}>
      {item.status === 'ready' ? t('statusReady') : t('statusError')}
    </div>
  )
}
