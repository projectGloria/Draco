import { sanitizeFilename } from '../main/engine/naming.ts'

/**
 * yt-dlp-style output templates for `-o`: `%(uploader)s/%(title)s.%(ext)s`.
 *
 * The split that matters: `/` and `\` typed in the *template* make folders,
 * while every *value* goes through `sanitizeFilename`, which strips path
 * separators, `:` and trailing dots. So a video titled `../../evil` or
 * `C:\Windows` lands as one ordinary file name and can never climb out of `-P`.
 */

export type TemplateFields = Record<string, string | number | null | undefined>

/** The fields `draco --help` and the sample draco.cfg document. */
export const TEMPLATE_FIELDS = [
  'title', 'ext', 'id', 'uploader', 'upload_date', 'height', 'resolution', 'format_id', 'playlist', 'playlist_index'
] as const

// `%(name)s`, `%(name)d`, and zero-padded `%(name)03d`. `%%` is a literal `%`.
const FIELD = /%%|%\((\w+)\)(0?\d*)([sd])/g

/** Whether `-o` is a template rather than one literal file name. */
export function isTemplate(output: string): boolean {
  return /%\(\w+\)0?\d*[sd]/.test(output)
}

/**
 * Throws for a template that could only ever escape `-P`, before anything is
 * resolved or downloaded. Values cannot introduce `..` (see above), so
 * checking the literal segments is enough.
 */
export function validateTemplate(template: string): void {
  const literal = template.replace(FIELD, 'x')
  if (literal.split(/[\\/]/).some((segment) => segment === '..')) {
    throw new Error(`output template must not contain "..": ${template}`)
  }
  if (/[\\/]\s*$/.test(literal)) throw new Error(`output template ends in a folder, not a file name: ${template}`)
}

/**
 * The relative (or, for an absolute template, absolute) path a template names.
 * A field with no value renders `NA`, as yt-dlp does, so a missing uploader
 * still gives a predictable `NA/` folder rather than a silently flatter layout.
 */
export function renderTemplate(template: string, fields: TemplateFields): string {
  validateTemplate(template)
  const rendered = template.replace(FIELD, (whole, name: string | undefined, width: string, type: string) => {
    if (whole === '%%') return '%'
    const value = fields[name!]
    if (value === null || value === undefined || value === '') return 'NA'
    if (type === 'd') {
      const n = Number(value)
      if (!Number.isFinite(n)) return 'NA'
      return width ? String(Math.trunc(n)).padStart(Number(width), width.startsWith('0') ? '0' : ' ') : String(Math.trunc(n))
    }
    return sanitizeFilename(String(value), 'NA')
  })
  // Windows silently drops trailing dots and spaces from each folder name, so
  // trim them here too - otherwise the folder we create and the path we later
  // check for an existing file would disagree.
  return rendered
    .split(/([\\/])/)
    .map((part, i, all) => (part === '/' || part === '\\' || i === all.length - 1 ? part : part.replace(/[. ]+$/, '')))
    .join('')
}

const MEDIA_EXTENSION = /\.(mp4|m4v|webm|mkv|mov|avi|flv|ts|m4a|mp3|aac|opus|ogg|oga|flac|wav)$/i

/**
 * A title without a media extension the uploader typed into it.
 *
 * Uploads named straight from the file (`pub_game_sniper_v2.mp4`) are common,
 * and appending the container on top gave `pub_game_sniper_v2.mp4.mp4`. Only
 * known media extensions go - `Version 2.0` or `Mr. Robot` keep their dots.
 */
export function cleanTitle(title: string): string {
  return title.replace(MEDIA_EXTENSION, '').trim() || title
}
