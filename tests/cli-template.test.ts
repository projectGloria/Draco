import { strictEqual, throws } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { cleanTitle, isTemplate, renderTemplate, validateTemplate } from '../src/cli/template.ts'

/**
 * Output templates. The property that matters most: folders come only from the
 * template the user typed, never from a value a website controls.
 */

describe('cli output templates', () => {
  it('fills fields and makes folders from the template', () => {
    strictEqual(
      renderTemplate('%(uploader)s/%(title)s.%(ext)s', { uploader: 'Kertmeyenmikele', title: 'pub_game_sniper_v2', ext: 'mp4' }),
      'Kertmeyenmikele/pub_game_sniper_v2.mp4'
    )
  })

  it('renders a missing field as NA', () => {
    strictEqual(renderTemplate('%(uploader)s/%(title)s.%(ext)s', { title: 'a', ext: 'mp4' }), 'NA/a.mp4')
  })

  it('never lets a value add folders or climb out', () => {
    const climbed = renderTemplate('%(title)s.%(ext)s', { title: '../../evil/x', ext: 'mp4' })
    strictEqual(/[\\/]/.test(climbed) || climbed.startsWith('..'), false)
    strictEqual(renderTemplate('%(uploader)s/%(title)s.%(ext)s', { uploader: '..', title: 'a', ext: 'mp4' }), 'NA/a.mp4')
    strictEqual(renderTemplate('%(title)s.%(ext)s', { title: 'C:\\Windows\\x', ext: 'mp4' }), 'CWindowsx.mp4')
  })

  it('rejects a template that climbs out or names no file', () => {
    throws(() => validateTemplate('../%(title)s.%(ext)s'), /must not contain/)
    throws(() => validateTemplate('%(uploader)s/'), /ends in a folder/)
  })

  it('pads numbers and keeps %% literal', () => {
    strictEqual(renderTemplate('%(playlist_index)03d - %(title)s', { playlist_index: 7, title: 'x' }), '007 - x')
    strictEqual(renderTemplate('100%% %(title)s', { title: 'x' }), '100% x')
  })

  it('trims trailing dots from folders, as Windows would', () => {
    strictEqual(renderTemplate('%(uploader)s./%(title)s.%(ext)s', { uploader: 'Dr', title: 'a', ext: 'mp4' }), 'Dr/a.mp4')
  })

  it('tells a template from a literal file name', () => {
    strictEqual(isTemplate('%(title)s.%(ext)s'), true)
    strictEqual(isTemplate('clip 100%.mp4'), false)
  })
})

describe('cli cleanTitle', () => {
  it('drops a media extension the uploader left in the title', () => {
    strictEqual(cleanTitle('pub_game_sniper_v2.mp4'), 'pub_game_sniper_v2')
    strictEqual(cleanTitle('song.MP3'), 'song')
  })

  it('keeps ordinary dots', () => {
    strictEqual(cleanTitle('Version 2.0'), 'Version 2.0')
    strictEqual(cleanTitle('Mr. Robot'), 'Mr. Robot')
    strictEqual(cleanTitle('.mp4'), '.mp4')
  })
})
