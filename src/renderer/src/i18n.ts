import { useApp } from './store/app'

const en = {
  addUrl: 'Add URL', siteGrabber: 'Site grabber', resume: 'Resume', stop: 'Stop',
  stopAll: 'Stop all', delete: 'Delete', deleteCompleted: 'Delete completed', details: 'Details',
  scheduler: 'Scheduler', options: 'Options', search: 'Search', allDownloads: 'All downloads',
  unfinished: 'Unfinished', finished: 'Finished', categories: 'Categories', queues: 'Queues',
  manageQueues: 'Manage queues and the scheduler', queueFailed: 'Queue command failed',
  stopQueue: 'Stop this queue', startQueue: 'Start queue', active: 'active', queued: 'queued',
  remaining: 'remaining', limit: 'limit', browser: 'Browser', downloadManager: 'Download Manager',
  inProgress: '{count} download(s) in progress', downloadingSingle: 'Downloading: {name}',
  downloadingMultiple: 'Downloading: {name} and {count} others', minimize: 'Minimize', restore: 'Restore',
  maximize: 'Maximize', close: 'Close', language: 'Language', systemLanguage: 'System language',
  english: 'English', turkish: 'Türkçe', sortBy: 'Sort by {column}',
  colName: 'Name', colSize: 'Size', colProgress: 'Progress', colStatus: 'Status',
  colEta: 'Time left', colSpeed: 'Speed', colQueue: 'Queue', colAdded: 'Added',
  colDescription: 'Description',
  statusQueued: 'Queued', statusProbing: 'Connecting', statusDownloading: 'Downloading',
  statusPaused: 'Paused', statusDone: 'Complete', statusError: 'Error', statusMissing: 'File missing',
  noDownloads: 'No downloads yet', noDownloadsHint: 'Add a URL, drop a link, or start one from your browser.',
  open: 'Open', openFolder: 'Open containing folder', copyUrl: 'Copy address', redownload: 'Download again',
  moveToQueue: 'Move to queue', noQueue: 'No queue', columns: 'Columns',
  confirmDeleteTitle: 'Delete downloads', confirmDeleteBody: 'Delete {count} download(s) from the list?',
  confirmDeleteFiles: 'Also delete the downloaded files', cancel: 'Cancel', confirm: 'Delete',
  fileMissing: 'That file is no longer where Draco left it'
} as const

type Key = keyof typeof en

/** Exported so component-level key maps can be typed against the dictionary. */
export type TKey = Key

const tr: Record<Key, string> = {
  addUrl: 'URL ekle', siteGrabber: 'Site yakalayıcı', resume: 'Devam et', stop: 'Durdur',
  stopAll: 'Tümünü durdur', delete: 'Sil', deleteCompleted: 'Tamamlananları sil', details: 'Ayrıntılar',
  scheduler: 'Zamanlayıcı', options: 'Seçenekler', search: 'Ara', allDownloads: 'Tüm indirmeler',
  unfinished: 'Tamamlanmamış', finished: 'Tamamlanmış', categories: 'Kategoriler', queues: 'Kuyruklar',
  manageQueues: 'Kuyrukları ve zamanlayıcıyı yönet', queueFailed: 'Kuyruk komutu başarısız',
  stopQueue: 'Bu kuyruğu durdur', startQueue: 'Kuyruğu başlat', active: 'etkin', queued: 'kuyrukta',
  remaining: 'kaldı', limit: 'sınır', browser: 'Tarayıcı', downloadManager: 'İndirme Yöneticisi',
  inProgress: '{count} indirme sürüyor', downloadingSingle: 'İndiriliyor: {name}',
  downloadingMultiple: 'İndiriliyor: {name} ve {count} diğerleri', minimize: 'Küçült', restore: 'Geri yükle',
  maximize: 'Büyüt', close: 'Kapat', language: 'Dil', systemLanguage: 'Sistem dili',
  english: 'İngilizce', turkish: 'Türkçe', sortBy: '{column} sütununa göre sırala',
  colName: 'Ad', colSize: 'Boyut', colProgress: 'İlerleme', colStatus: 'Durum',
  colEta: 'Kalan süre', colSpeed: 'Hız', colQueue: 'Kuyruk', colAdded: 'Eklenme',
  colDescription: 'Açıklama',
  statusQueued: 'Kuyrukta', statusProbing: 'Bağlanıyor', statusDownloading: 'İndiriliyor',
  statusPaused: 'Duraklatıldı', statusDone: 'Tamamlandı', statusError: 'Hata', statusMissing: 'Dosya yok',
  noDownloads: 'Henüz indirme yok', noDownloadsHint: 'Bir URL ekleyin, bağlantı sürükleyin veya tarayıcınızdan başlatın.',
  open: 'Aç', openFolder: 'Bulunduğu klasörü aç', copyUrl: 'Adresi kopyala', redownload: 'Yeniden indir',
  moveToQueue: 'Kuyruğa taşı', noQueue: 'Kuyruk yok', columns: 'Sütunlar',
  confirmDeleteTitle: 'İndirmeleri sil', confirmDeleteBody: '{count} indirme listeden silinsin mi?',
  confirmDeleteFiles: 'İndirilen dosyaları da sil', cancel: 'Vazgeç', confirm: 'Sil',
  fileMissing: 'Bu dosya Draco’nun bıraktığı yerde değil'
}

export function useT(): (key: Key, values?: Record<string, string | number>) => string {
  const preference = useApp((state) => state.settings.language)
  const language = preference === 'system'
    ? (navigator.language.toLowerCase().startsWith('tr') ? 'tr' : 'en')
    : preference
  return (key, values = {}) => {
    let value: string = language === 'tr' ? tr[key] : en[key]
    for (const [name, replacement] of Object.entries(values)) value = value.replaceAll(`{${name}}`, String(replacement))
    return value
  }
}

export function resolvedLanguage(preference: 'system' | 'en' | 'tr'): string {
  return preference === 'system' ? navigator.language : preference
}
