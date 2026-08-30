import { create } from 'zustand'

export type ToastKind = 'success' | 'info' | 'danger'

export interface Toast {
  id: number
  kind: ToastKind
  title: string
  detail?: string
  /** Set while the exit animation plays, just before the row is dropped. */
  leaving?: boolean
  timer?: NodeJS.Timeout
}

const VISIBLE_MS = 3600
const EXIT_MS = 260
/** Enough to show a burst from "download all links" without burying the app. */
const MAX_VISIBLE = 4

interface ToastState {
  toasts: Toast[]
  push(kind: ToastKind, title: string, detail?: string): void
  dismiss(id: number): void
}

let nextId = 1

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],

  push(kind, title, detail) {
    const id = nextId++
    const timer = setTimeout(() => get().dismiss(id), VISIBLE_MS)
    set((state) => ({ toasts: [...state.toasts, { id, kind, title, detail, timer }].slice(-MAX_VISIBLE) }))
  },

  dismiss(id) {
    const toast = get().toasts.find(t => t.id === id)
    if (toast?.timer) clearTimeout(toast.timer)

    // Mark first so the exit animation can run, then drop the row. Removing it
    // outright makes toasts vanish mid-stack and the ones below jump up.
    set((state) => ({
      toasts: state.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t))
    }))
    setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
    }, EXIT_MS)
  }
}))

export function toast(kind: ToastKind, title: string, detail?: string): void {
  useToasts.getState().push(kind, title, detail)
}

/** Turns a rejected IPC call into a toast without every caller writing this. */
export function reportError(title: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err)
  // Electron prefixes IPC rejections with the handler name; that is noise here.
  toast('danger', title, detail.replace(/^Error invoking remote method '[^']+':\s*/, ''))
}
