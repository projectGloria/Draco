import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { content, elements, rendererFixture, settle } from './helpers/renderer-fixture.ts'

test('Save As accepts only one pending file or media batch and permits retry after rejection', async () => {
  const { SaveAsDialog, useApp, useToasts, createRenderer } = await rendererFixture(`
    export { default as SaveAsDialog } from './src/renderer/src/components/SaveAsDialog.tsx';
    export { useApp } from './src/renderer/src/store/app.ts';
    export { useToasts } from './src/renderer/src/store/toasts.ts';
  `)
  useApp.setState({ settings: { ...useApp.getState().settings, language: 'en' } })
  const calls: any[] = []
  let resolve!: (value: unknown) => void
  let reject!: (error: Error) => void
  const submit = (input: unknown): Promise<unknown> => {
    calls.push(input)
    return new Promise((accept, fail) => { resolve = accept; reject = fail })
  }
  Object.assign(globalThis, { window: { api: { addDownload: submit, addDownloads: submit }, crypto: globalThis.crypto } })
  let closed = 0
  const renderer = createRenderer()
  const props = { url: 'https://example.com/movie.mp4', onClose: () => closed++ }
  const startButton = (tree: any): any => elements(tree).find((node) => node.type?.name === 'PrimaryButton')
  const first = startButton(renderer.render(SaveAsDialog, props))
  first.props.onClick()
  first.props.onClick()
  assert.equal(calls.length, 1, 'rapid repeated clicks must not create duplicate tasks')
  assert.equal(startButton(renderer.render(SaveAsDialog, props)).props.disabled, true)
  reject(new Error('save failed'))
  await settle()
  const retry = startButton(renderer.render(SaveAsDialog, props))
  assert.equal(retry.props.disabled, false)
  retry.props.onClick()
  assert.equal(calls.length, 2)
  resolve({ id: 'new-file' })
  await settle()
  assert.equal(closed, 1)

  const media = createRenderer()
  const batchProps = {
    url: 'https://example.com/album', onClose: () => closed++,
    clipboardItem: { kind: 'media', media: { title: 'Album', variants: [
      { url: 'https://example.com/one.mp3', label: 'One', container: 'mp3' },
      { url: 'https://example.com/two.mp3', label: 'Two', container: 'mp3' }
    ] } }
  }
  const batch = startButton(media.render(SaveAsDialog, batchProps))
  batch.props.onClick()
  batch.props.onClick()
  assert.equal(calls.length, 3, 'a media batch must also be submitted once')
  assert.equal(calls[2].length, 2)
  resolve([])
  await settle()
  assert.equal(closed, 2)
  for (const toast of useToasts.getState().toasts) clearTimeout(toast.timer)
})

test('group Properties stops connecting, processing, and scanning tasks', async () => {
  const { GroupDetailDialog, useApp, createRenderer } = await rendererFixture(`
    export { default as GroupDetailDialog } from './src/renderer/src/components/GroupDetailDialog.tsx';
    export { useApp } from './src/renderer/src/store/app.ts';
  `)
  useApp.setState({ settings: { ...useApp.getState().settings, language: 'en' } })
  const commands: string[][] = []
  Object.assign(globalThis, { window: { api: {
    pauseTasks: async (ids: string[]) => { commands.push(ids) },
    startTasks: async () => { throw new Error('active tasks must not be resumed') }
  } } })
  for (const status of ['probing', 'processing', 'scanning']) {
    useApp.setState({ tasks: [{ id: status, groupId: 'batch', groupName: 'Batch', status,
      filename: 'movie.mp4', url: 'https://example.com/movie.mp4', size: 100, received: 50,
      speed: 0, createdAt: 1, queueId: null, completedAt: null }] })
    const tree = createRenderer().render(GroupDetailDialog, { groupId: 'batch', onClose() {} })
    const button = elements(tree).find((node) => content(node) === 'Stop 1 downloads')
    assert.ok(button, `${status} needs a Stop command`)
    button.props.onClick()
  }
  await settle()
  assert.deepEqual(commands, [['probing'], ['processing'], ['scanning']])
})

test('progress-window Pause reports failure and keeps the window available to retry', async () => {
  const { ProgressWindow, useApp, createRenderer } = await rendererFixture(`
    export { default as ProgressWindow } from './src/renderer/src/components/ProgressWindow.tsx';
    export { useApp } from './src/renderer/src/store/app.ts';
  `)
  useApp.setState({ settings: { ...useApp.getState().settings, language: 'en' } })
  const task = { id: 'movie', status: 'downloading', filename: 'movie.mp4', url: 'https://example.com/movie.mp4',
    size: 100, received: 50, speed: 10, eta: 5, error: null, detail: null, dir: 'downloads' }
  let reject!: (error: Error) => void
  let closed = 0
  const noop = (): void => {}
  Object.assign(globalThis, {
    window: { matchMedia: () => ({ matches: true, addEventListener: noop, removeEventListener: noop }), api: {
      getSettings: async () => useApp.getState().settings, getTask: async () => task,
      onProgress: () => noop, onTasksChanged: () => noop,
      pauseTasks: () => new Promise((_resolve, fail) => { reject = fail }),
      closeSelf: async () => { closed++ }
    } },
    document: { documentElement: { dataset: {}, style: { setProperty() {} } }, addEventListener: noop, removeEventListener: noop }
  })
  const windowRenderer = createRenderer()
  windowRenderer.render(ProgressWindow, { id: task.id })
  windowRenderer.flushEffects()
  await settle()
  const body = elements(windowRenderer.render(ProgressWindow, { id: task.id })).find((node) => node.type?.name === 'Body')
  assert.ok(body)
  const bodyRenderer = createRenderer()
  const tree = bodyRenderer.render(body.type, body.props)
  const pause = elements(tree).find((node) => node.type?.name === 'PrimaryButton' && content(node).trim() === 'Pause')
  assert.ok(pause)
  pause.props.onClick()
  assert.equal(elements(bodyRenderer.render(body.type, body.props)).find((node) => node.type?.name === 'PrimaryButton').props.disabled, true)
  reject(new Error('checkpoint could not be saved'))
  await settle()
  const failedTree = bodyRenderer.render(body.type, body.props)
  assert.ok(elements(failedTree).some((node) => node.props?.role === 'alert' && content(node).includes('checkpoint could not be saved')))
  assert.equal(elements(failedTree).find((node) => node.type?.name === 'PrimaryButton').props.disabled, false)
  assert.equal(closed, 0)
  windowRenderer.cleanup()
})

test('task Properties follows a late probe name while preserving fields the user edited', async () => {
  const { TaskDetailDialog, useApp, useToasts, createRenderer } = await rendererFixture(`
    export { default as TaskDetailDialog } from './src/renderer/src/components/TaskDetailDialog.tsx';
    export { useApp } from './src/renderer/src/store/app.ts';
    export { useToasts } from './src/renderer/src/store/toasts.ts';
  `)
  const task = { id: 'movie', status: 'probing', filename: 'download', description: '', queueId: null,
    categoryId: null, url: 'https://example.com/file', size: null, received: 0, speed: 0,
    createdAt: 1, segments: [], connections: 0, kind: 'file', dir: 'downloads' }
  useApp.setState({ settings: { ...useApp.getState().settings, language: 'en' }, tasks: [task] })
  let saved: any
  Object.assign(globalThis, { window: { api: {
    taskDetail: async () => null,
    updateTask: async (_id: string, patch: unknown) => { saved = patch; return task }
  } } })
  const renderer = createRenderer()
  const props = { id: task.id, onClose() {} }
  const fields = (tree: any): any[] => elements(tree).filter((node) => node.type === 'input')
  let tree = renderer.render(TaskDetailDialog, props)
  renderer.flushEffects()
  fields(tree)[1].props.onChange({ target: { value: 'A description' } })
  useApp.setState({ tasks: [{ ...task, filename: 'server-movie.mp4' }] })
  renderer.render(TaskDetailDialog, props)
  renderer.flushEffects()
  tree = renderer.render(TaskDetailDialog, props)
  assert.equal(fields(tree)[0].props.value, 'server-movie.mp4')
  assert.equal(fields(tree)[1].props.value, 'A description')
  elements(tree).find((node) => node.type?.name === 'PrimaryButton').props.onClick()
  await settle()
  assert.deepEqual(saved, { description: 'A description' }, 'saving a description must not rename the current filename or restart its queue')

  fields(tree)[0].props.onChange({ target: { value: 'my-movie.mp4' } })
  useApp.setState({ tasks: [{ ...task, filename: 'another-server-name.mp4' }] })
  renderer.render(TaskDetailDialog, props)
  renderer.flushEffects()
  tree = renderer.render(TaskDetailDialog, props)
  assert.equal(fields(tree)[0].props.value, 'my-movie.mp4')
  renderer.cleanup()
  for (const toast of useToasts.getState().toasts) clearTimeout(toast.timer)
})

test('mixed URL batches queue video and playlist pickers while adding direct files once', async () => {
  const { App, useApp, useToasts, createRenderer } = await rendererFixture(`
    export { default as App } from './src/renderer/src/App.tsx';
    export { useApp } from './src/renderer/src/store/app.ts';
    export { useToasts } from './src/renderer/src/store/toasts.ts';
  `)
  useApp.setState({ ready: true, settings: { ...useApp.getState().settings, language: 'en' } })
  const added: any[] = []
  const noop = (): void => {}
  Object.assign(globalThis, {
    window: { location: { hash: '' }, matchMedia: () => ({ matches: true, addEventListener: noop, removeEventListener: noop }), api: {
      readClipboard: async () => '', takePendingOpens: async () => [],
      onDownloadComplete: () => noop, onToast: () => noop, onToolUpdates: () => noop, onShellOpen: () => noop,
      addDownloads: async (inputs: unknown[]) => { added.push(inputs); return [] }
    } },
    document: { documentElement: { dataset: {}, style: { setProperty: noop } } }
  })
  const renderer = createRenderer()
  let tree = renderer.render(App, {})
  renderer.flushEffects()
  elements(tree).find((node) => node.type?.name === 'Toolbar').props.actions.onAdd()
  await settle()
  tree = renderer.render(App, {})
  const add = elements(tree).find((node) => node.type?.name === 'AddUrlDialog')
  assert.ok(add)
  add.props.onSubmit(['https://www.youtube.com/watch?v=abcdefghijk', 'https://example.com/movie.mp4', 'https://www.youtube.com/playlist?list=PLtest'])
  add.props.onClose()
  tree = renderer.render(App, {})
  renderer.flushEffects()
  tree = renderer.render(App, {})
  assert.deepEqual(added, [[{ url: 'https://example.com/movie.mp4' }]])
  const video = elements(tree).find((node) => node.type?.name === 'SaveAsDialog')
  assert.ok(video)
  assert.equal(video.props.url, 'https://www.youtube.com/watch?v=abcdefghijk')
  assert.equal(video.key, 'https://www.youtube.com/watch?v=abcdefghijk:')
  video.props.onClose()
  renderer.render(App, {})
  renderer.flushEffects()
  tree = renderer.render(App, {})
  const playlist = elements(tree).find((node) => node.type?.name === 'PlaylistDialog')
  assert.ok(playlist)
  assert.equal(playlist.props.url, 'https://www.youtube.com/playlist?list=PLtest')
  assert.equal(playlist.key, playlist.props.url)
  renderer.cleanup()
  await settle()
  for (const toast of useToasts.getState().toasts) clearTimeout(toast.timer)
})

test('torrent Save As locks the metadata name and omits a custom filename from admission', async () => {
  const { SaveAsDialog, useApp, createRenderer } = await rendererFixture(`
    export { default as SaveAsDialog } from './src/renderer/src/components/SaveAsDialog.tsx';
    export { useApp } from './src/renderer/src/store/app.ts';
  `)
  useApp.setState({ settings: { ...useApp.getState().settings, language: 'en' } })
  let added: any
  Object.assign(globalThis, { window: { api: { addDownload: async (input: unknown) => { added = input; return {} } } } })
  const renderer = createRenderer()
  const tree = renderer.render(SaveAsDialog, { url: 'magnet:?xt=urn:btih:' + 'a'.repeat(40), suggestedFilename: 'custom name', onClose() {} })
  const filename = elements(tree).find((node) => node.type === 'input' && node.props.value === 'custom name')
  assert.equal(filename.props.disabled, true)
  elements(tree).find((node) => node.type?.name === 'PrimaryButton').props.onClick()
  await settle()
  assert.equal(added.filename, undefined)
})

test('appearance follows the system theme and removes its listener after an explicit theme is selected', async () => {
  const { useAppearance, createRenderer } = await rendererFixture(`
    export { useAppearance } from './src/renderer/src/lib/use-appearance.ts';
  `)
  let change: (() => void) | undefined
  const system = {
    matches: true,
    addEventListener(_event: string, callback: () => void) { change = callback },
    removeEventListener(_event: string, callback: () => void) { if (change === callback) change = undefined }
  }
  const root = { lang: '', dataset: { theme: '' }, style: { setProperty() {} } }
  Object.assign(globalThis, { window: { matchMedia: () => system }, document: { documentElement: root } })
  const renderer = createRenderer()
  const settings = { theme: 'system', accent: '#38bdf8', language: 'tr' }
  renderer.render(useAppearance, settings)
  renderer.flushEffects()
  assert.equal(root.lang, 'tr')
  assert.equal(root.dataset.theme, 'dark')
  system.matches = false
  change?.()
  assert.equal(root.dataset.theme, 'light')
  renderer.render(useAppearance, { ...settings, theme: 'dark' })
  renderer.flushEffects()
  assert.equal(root.dataset.theme, 'dark')
  assert.equal(change, undefined)
  renderer.cleanup()
})

test('update Check is unavailable while its feed is an unsaved Options draft', async () => {
  const { OptionsDialog, useApp, createRenderer } = await rendererFixture(`
    export { default as OptionsDialog } from './src/renderer/src/components/OptionsDialog.tsx';
    export { useApp } from './src/renderer/src/store/app.ts';
  `)
  const settings = { ...useApp.getState().settings, language: 'en', updateFeedUrl: 'https://example.com/old.json' }
  useApp.setState({ settings })
  const options = createRenderer().render(OptionsDialog, { onClose() {} })
  const general = elements(options).find((node) => node.type?.name === 'GeneralTab')
  assert.ok(general)
  const renderer = createRenderer()
  const next = { ...settings, updateFeedUrl: 'https://example.com/new.json' }
  const props = { ...general.props, settings: next }
  const check = (tree: any): any => elements(tree).find((node) => node.type?.name === 'GhostButton' && content(node) === 'Check')
  let tree = renderer.render(general.type, props)
  assert.equal(check(tree).props.disabled, true)
  assert.ok(elements(tree).some((node) => content(node) === 'Apply settings before checking this update feed.'))
  useApp.setState({ settings: next })
  tree = renderer.render(general.type, props)
  assert.equal(check(tree).props.disabled, false)
})

test('torrent checkboxes use committed selections before the next diagnostics poll', async () => {
  const { TaskDetailDialog, useApp, createRenderer } = await rendererFixture(`
    export { default as TaskDetailDialog } from './src/renderer/src/components/TaskDetailDialog.tsx';
    export { useApp } from './src/renderer/src/store/app.ts';
  `)
  const task = { id: 'torrent', status: 'paused', filename: 'Bundle', description: '', queueId: null,
    kind: 'torrent', selectedFiles: undefined, segments: [], url: 'magnet:?xt=urn:btih:' + 'a'.repeat(40),
    received: 0, speed: 0, size: 2, createdAt: 1, connections: 0, dir: 'downloads',
    torrentInfo: { files: [
      { path: 'one.mp4', size: 1, downloaded: 0, selected: true },
      { path: 'two.mp4', size: 1, downloaded: 0, selected: true }
    ], trackers: [], sources: [], peers: [] }
  }
  useApp.setState({ settings: { ...useApp.getState().settings, language: 'en' }, tasks: [task] })
  const saved: string[][] = []
  Object.assign(globalThis, { window: { api: { setTorrentFiles: async (_id: string, paths: string[]) => { saved.push(paths); return true } } } })
  const outer = createRenderer()
  const props = { id: task.id, onClose() {} }
  let tree = outer.render(TaskDetailDialog, props)
  let details = elements(tree).find((node) => node.type?.name === 'TorrentDetails')
  details.props.onTabChange('content')
  tree = outer.render(TaskDetailDialog, props)
  details = elements(tree).find((node) => node.type?.name === 'TorrentDetails')
  const detailsTree = createRenderer().render(details.type, details.props)
  const contents = elements(detailsTree).find((node) => node.type?.name === 'TorrentContent')
  assert.ok(contents)
  const renderer = createRenderer()
  const checkboxes = (node: any): any[] => elements(node).filter((element) => element.type === 'input' && element.props.type === 'checkbox')
  tree = renderer.render(contents.type, contents.props)
  checkboxes(tree)[0].props.onChange()
  await settle()
  assert.deepEqual(saved, [['two.mp4']])
  tree = renderer.render(contents.type, { task: { ...task, selectedFiles: ['two.mp4'] } })
  assert.equal(checkboxes(tree)[0].props.checked, false)
  assert.equal(checkboxes(tree)[1].props.checked, true)
  checkboxes(tree)[0].props.onChange()
  await settle()
  assert.deepEqual(saved[1], ['two.mp4', 'one.mp4'])
})
