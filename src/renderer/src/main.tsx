import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

/*
 * Fonts are bundled rather than fetched: the renderer runs under a
 * `default-src 'self'` CSP, so a remote stylesheet is simply blocked and every
 * number in the table silently falls back to a system face - which is exactly
 * the kind of thing that makes a column of sizes stop lining up.
 *
 * They are imported here rather than with `@import` inside theme.css because
 * Tailwind's PostCSS plugin inlines a CSS-level @import itself, and the
 * `url(./files/...)` references would then resolve relative to theme.css
 * instead of the package.
 */
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import './styles/theme.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
