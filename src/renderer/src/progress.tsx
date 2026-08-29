import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import ProgressWindow from './components/ProgressWindow'

/*
 * The per-download window's entry point. Like the confirm window it shares the
 * preload bridge and the theme with the main window and none of its state: it
 * exists for the length of one download and must be able to open while the main
 * window is still hidden in the tray.
 */
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import './styles/theme.css'

const id = new URLSearchParams(location.search).get('id') ?? ''

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ProgressWindow id={id} />
  </StrictMode>
)
