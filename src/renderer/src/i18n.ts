import { useApp } from './store/app'

const en = {
  addUrl: 'Add URL', siteGrabber: 'Site grabber', resume: 'Resume', stop: 'Stop',
  stopAll: 'Stop all', delete: 'Delete', deleteCompleted: 'Delete completed', details: 'Details',
  scheduler: 'Scheduler', options: 'Options', search: 'Search', allDownloads: 'All downloads',
  unfinished: 'Unfinished', finished: 'Finished', categories: 'Categories', queues: 'Queues',
  manageQueues: 'Manage queues and the scheduler', queueFailed: 'Queue command failed',
  stopQueue: 'Stop this queue', startQueue: 'Start this queue', active: 'active', queued: 'queued',
  remaining: 'remaining', limit: 'limit', browser: 'Browser', downloadManager: 'Download Manager',
  inProgress: '{count} download(s) in progress', minimize: 'Minimize', restore: 'Restore',
  maximize: 'Maximize', close: 'Close', language: 'Language', systemLanguage: 'System language',
  english: 'English', turkish: 'Türkçe'
} as const

type Key = keyof typeof en

const tr: Record<Key, string> = {
  addUrl: 'URL ekle', siteGrabber: 'Site yakalayıcı', resume: 'Devam et', stop: 'Durdur',
  stopAll: 'Tümünü durdur', delete: 'Sil', deleteCompleted: 'Tamamlananları sil', details: 'Ayrıntılar',
  scheduler: 'Zamanlayıcı', options: 'Seçenekler', search: 'Ara', allDownloads: 'Tüm indirmeler',
  unfinished: 'Tamamlanmamış', finished: 'Tamamlanmış', categories: 'Kategoriler', queues: 'Kuyruklar',
  manageQueues: 'Kuyrukları ve zamanlayıcıyı yönet', queueFailed: 'Kuyruk komutu başarısız',
  stopQueue: 'Bu kuyruğu durdur', startQueue: 'Bu kuyruğu başlat', active: 'etkin', queued: 'kuyrukta',
  remaining: 'kaldı', limit: 'sınır', browser: 'Tarayıcı', downloadManager: 'İndirme Yöneticisi',
  inProgress: '{count} indirme sürüyor', minimize: 'Küçült', restore: 'Geri yükle',
  maximize: 'Büyüt', close: 'Kapat', language: 'Dil', systemLanguage: 'Sistem dili',
  english: 'İngilizce', turkish: 'Türkçe'
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
