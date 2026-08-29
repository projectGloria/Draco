import { useState } from 'react'
import { looksLikeUrl } from '../lib/format'
import Dialog, { GhostButton, PrimaryButton } from './Dialog'

/**
 * IDM's "Add URL" box. One URL per line, so pasting a list from somewhere else
 * does the obvious thing instead of failing validation on the whole blob.
 */

export default function AddUrlDialog({
  onSubmit,
  onClose
}: {
  onSubmit(urls: string[]): void
  onClose(): void
}): React.ReactElement {
  const [text, setText] = useState('')

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const valid = lines.filter(looksLikeUrl)
  const invalid = lines.length - valid.length

  const submit = (): void => {
    if (valid.length === 0) return
    onSubmit(valid)
    onClose()
  }

  return (
    <Dialog
      title="Add download"
      subtitle="One address per line"
      width={560}
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton onClick={submit} disabled={valid.length === 0}>
            {valid.length > 1 ? `Add ${valid.length} downloads` : 'Continue'}
          </PrimaryButton>
        </>
      }
    >
      <label className="label">Address</label>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // Ctrl+Enter submits; a plain Enter has to stay available for the
          // next URL in the list.
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) submit()
        }}
        rows={5}
        spellCheck={false}
        placeholder="https://example.com/file.iso"
        className="field font-mono text-[12px] leading-relaxed resize-none"
      />

      <div className="mt-2 h-4 text-[11.5px]">
        {invalid > 0 ? (
          <span className="text-warn">
            {invalid} line{invalid === 1 ? '' : 's'} skipped — only http and https addresses are
            accepted
          </span>
        ) : valid.length > 1 ? (
          <span className="text-faint">
            {valid.length} downloads will be added and filed by category
          </span>
        ) : (
          <span className="text-faint">Ctrl+Enter to continue</span>
        )}
      </div>
    </Dialog>
  )
}
