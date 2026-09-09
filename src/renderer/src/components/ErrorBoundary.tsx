import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * The last thing between a render error and a blank window.
 *
 * React unmounts the entire tree when a render throws, and an Electron renderer
 * that has unmounted looks exactly like a crashed application: an empty frame,
 * with the main process still running and its log still saying nothing is
 * wrong. That is how a one-line mistake in the download table cost an evening
 * of guessing.
 *
 * So the error is caught, kept on screen with its stack, and printed to the
 * console where the packaged app's `--enable-logging` and DevTools can both
 * reach it. Reload is offered because the state that caused it usually is not
 * the state the app will come back to.
 */

interface State {
  error: Error | null
  componentStack: string | null
}

export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, componentStack: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null })
    // Left as console.error on purpose: it is what DevTools shows and what
    // Chromium writes out when the app is launched with logging enabled.
    console.error('Draco renderer crashed:', error, info.componentStack)
  }

  render(): ReactNode {
    const { error, componentStack } = this.state
    if (!error) return this.props.children

    return (
      <div className="fixed inset-0 overflow-auto bg-surface text-ink p-8 text-[12.5px] leading-relaxed">
        <h1 className="text-[15px] font-semibold mb-1">Draco hit an error and stopped drawing</h1>
        <p className="text-faint mb-4">
          Your downloads are unaffected — they run in the background, not in this window. Reloading
          usually brings the list straight back.
        </p>

        <button
          className="mb-5 px-3 py-1.5 rounded-lg text-[12px] font-semibold"
          style={{ background: 'var(--grad)' }}
          onClick={() => window.location.reload()}
        >
          Reload the window
        </button>

        <pre className="whitespace-pre-wrap break-words rounded-lg border border-line bg-black/25 p-3 text-[11px] text-err">
          {error.message}
          {error.stack ? '\n\n' + error.stack : ''}
          {componentStack ? '\n\nComponent stack:' + componentStack : ''}
        </pre>
      </div>
    )
  }
}
