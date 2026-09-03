import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  BootstrapState,
  Category,
  DownloadTask,
  NewDownload,
  PendingAction,
  Queue,
  RendererApi,
  RequestHeaders,
  Settings,
  TaskProgress,
  Toast,
  ToolStatus
} from '@shared/types'

/**
 * The only surface the renderer gets. There is no Node, no fs and no child
 * process on the other side of this bridge - every capability is an explicit
 * channel listed here and in `main/ipc.ts`.
 */

/** Wraps a subscription so components can unsubscribe on unmount. */
function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, value: T): void => cb(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: RendererApi = {
  /* bootstrap */
  onBootstrap: (cb) => subscribe<BootstrapState>('bootstrap:state', cb),
  bootstrapRetry: () => ipcRenderer.invoke('bootstrap:retry'),
  bootstrapContinue: () => ipcRenderer.invoke('bootstrap:continue'),

  /* tasks */
  listTasks: () => ipcRenderer.invoke('tasks:list'),
  getTask: (id: string) => ipcRenderer.invoke('tasks:get', id),
  addDownload: (input: NewDownload) => ipcRenderer.invoke('tasks:add', input),
  addDownloads: (inputs: NewDownload[]) => ipcRenderer.invoke('tasks:addMany', inputs),
  probe: (url: string, headers?: RequestHeaders) => ipcRenderer.invoke('tasks:probe', url, headers),
  startTasks: (ids: string[]) => ipcRenderer.invoke('tasks:start', ids),
  pauseTasks: (ids: string[]) => ipcRenderer.invoke('tasks:pause', ids),
  pauseAll: () => ipcRenderer.invoke('tasks:pauseAll'),
  removeTasks: (ids: string[], deleteFiles: boolean) =>
    ipcRenderer.invoke('tasks:remove', ids, deleteFiles),
  removeCompleted: () => ipcRenderer.invoke('tasks:removeCompleted'),
  updateTask: (id: string, patch: Partial<DownloadTask>) =>
    ipcRenderer.invoke('tasks:update', id, patch),
  redownload: (id: string) => ipcRenderer.invoke('tasks:redownload', id),
  openFile: (id: string) => ipcRenderer.invoke('tasks:open', id),
  revealFile: (id: string) => ipcRenderer.invoke('tasks:reveal', id),
  onTasksChanged: (cb) => subscribe<DownloadTask[]>('tasks:changed', cb),
  onProgress: (cb) => subscribe<TaskProgress[]>('tasks:progress', cb),

  /* the confirm window */
  getHandoff: (id: string) => ipcRenderer.invoke('handoff:get', id),
  acceptHandoff: (id: string, input: NewDownload) =>
    ipcRenderer.invoke('handoff:accept', id, input),
  resolveHandoffMedia: (id: string) => ipcRenderer.invoke('handoff:resolveMedia', id),
  acceptHandoffMedia: (id: string, opts: { variantUrl: string; filename: string; dir?: string; categoryId?: string; queueId?: string; audioUrl?: string | null; youtube?: { videoFormatId: string; audioFormatId?: string | null } }) =>
    ipcRenderer.invoke('handoff:acceptMedia', id, opts),
  dismissHandoff: (id: string) => ipcRenderer.invoke('handoff:dismiss', id),
  getYouTubePrimeStatus: (pageUrl: string) => ipcRenderer.invoke('youtube:primeStatus', pageUrl),

  /* categories */
  listCategories: () => ipcRenderer.invoke('categories:list'),
  saveCategories: (categories: Category[]) => ipcRenderer.invoke('categories:save', categories),

  /* queues */
  listQueues: () => ipcRenderer.invoke('queues:list'),
  saveQueue: (queue: Queue) => ipcRenderer.invoke('queues:save', queue),
  removeQueue: (id: string) => ipcRenderer.invoke('queues:remove', id),
  startQueue: (id: string) => ipcRenderer.invoke('queues:start', id),
  stopQueue: (id: string) => ipcRenderer.invoke('queues:stop', id),
  onQueuesChanged: (cb) => subscribe<Queue[]>('queues:changed', cb),
  onPendingAction: (cb) => subscribe<PendingAction | null>('queues:pending', cb),
  cancelPendingAction: () => ipcRenderer.invoke('queues:cancelPending'),

  /* settings and integration */
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch: Partial<Settings>) => ipcRenderer.invoke('settings:save', patch),
  chooseDirectory: (current?: string) => ipcRenderer.invoke('settings:chooseDirectory', current),
  getIntegration: () => ipcRenderer.invoke('integration:get'),
  registerIntegration: () => ipcRenderer.invoke('integration:register'),
  copyToClipboard: (text: string) => ipcRenderer.invoke('clipboard:write', text),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  getToolStatus: (checkLatest: boolean) => ipcRenderer.invoke('tools:status', checkLatest),
  updateTool: (id) => ipcRenderer.invoke('tools:update', id),
  onToolUpdates: (cb) => subscribe<ToolStatus[]>('tools:updates', cb),
  openUpdate: (url: string) => ipcRenderer.invoke('updates:open', url),
  startSiteGrab: (options) => ipcRenderer.invoke('siteGrabber:start', options),
  listSiteGrabs: () => ipcRenderer.invoke('siteGrabber:list'),
  runSiteGrab: (id: string) => ipcRenderer.invoke('siteGrabber:run', id),
  removeSiteGrab: (id: string) => ipcRenderer.invoke('siteGrabber:remove', id),

  /* icons */
  fileIcon: (extension: string) => ipcRenderer.invoke('icons:file', extension),
  siteIcon: (url: string) => ipcRenderer.invoke('icons:site', url),

  /* window */
  minimize: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
  close: () => ipcRenderer.invoke('window:close'),
  minimizeSelf: () => ipcRenderer.invoke('window:minimizeSelf'),
  closeSelf: () => ipcRenderer.invoke('window:closeSelf'),
  onMaximizeChange: (cb) => subscribe<boolean>('window:maximized', cb),
  onToast: (cb) => subscribe<Toast>('toast', cb),
  onClipboardUrl: (cb) => subscribe<string>('clipboard:url', cb)
}

contextBridge.exposeInMainWorld('api', api)
