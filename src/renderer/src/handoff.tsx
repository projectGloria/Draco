import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import HandoffWindow from './components/HandoffWindow'

/*
 * The confirm window's own entry point. It shares the preload bridge and the
 * theme with the main window but none of its state: this window exists for the
 * length of one question and must be able to open before - or entirely without -
 * the download list.
 */
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import './styles/theme.css'

const id = new URLSearchParams(location.search).get('id') ?? ''

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HandoffWindow id={id} />
  </StrictMode>
)
