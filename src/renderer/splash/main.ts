import type { BootstrapState } from '@shared/types'

/**
 * The splash renderer. No framework here on purpose: this window exists to be
 * on screen before anything else is, and pulling React in would defeat that.
 */

const stepsEl = document.getElementById('steps') as HTMLDivElement
const fillEl = document.getElementById('fill') as HTMLDivElement
const pctEl = document.getElementById('pct') as HTMLSpanElement
const currentEl = document.getElementById('current') as HTMLSpanElement
const errorEl = document.getElementById('error') as HTMLDivElement
const retryBtn = document.getElementById('retry') as HTMLButtonElement
const continueBtn = document.getElementById('continue') as HTMLButtonElement

interface Row {
  root: HTMLDivElement
  label: HTMLSpanElement
  detail: HTMLSpanElement
}

/** Rows are created once and then patched, so nothing flickers on each update. */
const rows = new Map<string, Row>()

function rowFor(id: string, label: string): Row {
  const existing = rows.get(id)
  if (existing) return existing

  const root = document.createElement('div')
  root.className = 'step'
  root.dataset.status = 'pending'

  const dot = document.createElement('span')
  dot.className = 'dot'

  const labelEl = document.createElement('span')
  labelEl.className = 'label'
  labelEl.textContent = label

  const detailEl = document.createElement('span')
  detailEl.className = 'detail'

  root.append(dot, labelEl, detailEl)
  stepsEl.append(root)

  const entry: Row = { root, label: labelEl, detail: detailEl }
  rows.set(id, entry)
  return entry
}

function render(state: BootstrapState): void {
  for (const step of state.steps) {
    const row = rowFor(step.id, step.label)
    row.root.dataset.status = step.status
    row.label.textContent = step.label
    // textContent, never innerHTML: a step's detail is an error string that came
    // from a filesystem path, a registry call or a socket.
    row.detail.textContent = step.detail ?? ''
  }

  fillEl.style.width = state.overall + '%'
  pctEl.textContent = Math.round(state.overall) + '%'

  const running = state.steps.find((s) => s.status === 'running')
  currentEl.textContent = state.error
    ? 'Something went wrong'
    : state.done
      ? 'Ready'
      : (running?.label ?? 'Starting…')

  if (state.error) {
    document.body.classList.add('failed')
    errorEl.textContent = state.error.message
    continueBtn.hidden = !state.error.canContinue
  } else {
    document.body.classList.remove('failed')
  }

  // The main window takes over from here; fade out rather than blink away.
  if (state.done) document.body.classList.add('leaving')
}

retryBtn.addEventListener('click', () => {
  document.body.classList.remove('failed')
  currentEl.textContent = 'Retrying…'
  void window.api.bootstrapRetry()
})

continueBtn.addEventListener('click', () => {
  void window.api.bootstrapContinue()
})

window.api.onBootstrap(render)
