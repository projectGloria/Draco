import { deepStrictEqual, strictEqual, throws } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { configRequest, parseArgs, UsageError } from '../src/cli/args.ts'
import { defaultConfigPath, tokenizeConfig, withConfigDir } from '../src/cli/config.ts'

/**
 * draco.cfg: tokenising a file full of Windows paths, and merging it under the
 * command line so the command line always wins.
 */

describe('draco.cfg tokenizer', () => {
  it('keeps Windows paths intact and groups quoted words', () => {
    deepStrictEqual(tokenizeConfig('-P "D:\\My Videos\\new"\n-o \'%(title)s.%(ext)s\''), [
      '-P', 'D:\\My Videos\\new', '-o', '%(title)s.%(ext)s'
    ])
  })

  it('drops comments and blank lines, handles CRLF and a BOM', () => {
    const text = '\uFEFF# heading\r\n\r\n-N 16   # trailing comment\r\n  # indented comment\r\n-x\r\n'
    deepStrictEqual(tokenizeConfig(text), ['-N', '16', '-x'])
  })

  it('keeps a # that is inside a word or quoted', () => {
    deepStrictEqual(tokenizeConfig('--proxy http://h/p#frag -f "#3"'), ['--proxy', 'http://h/p#frag', '-f', '#3'])
  })

  it('reports an unclosed quote with its line number', () => {
    throws(() => tokenizeConfig('-N 4\n-P "D:\\x'), /line 2: unclosed "/)
  })

  it('lives beside Draco.exe when installed and in the repo root in dev', () => {
    strictEqual(defaultConfigPath(true, 'C:\\Apps\\Draco\\Draco.exe', 'C:\\repo'), 'C:\\Apps\\Draco\\draco.cfg')
    strictEqual(defaultConfigPath(false, 'C:\\node\\node.exe', 'C:\\repo'), 'C:\\repo\\draco.cfg')
  })
})

describe('draco.cfg merge', () => {
  it('fills defaults the command line leaves unset', () => {
    const options = parseArgs(['https://x.test/a'], ['-N', '16', '-P', 'D:\\V', '--cookies-from-browser', 'firefox'])
    strictEqual(options.connections, 16)
    strictEqual(options.dir, 'D:\\V')
    strictEqual(options.cookiesFromBrowser, 'firefox')
  })

  it('lets the command line override per key, formats included, without a conflict error', () => {
    const options = parseArgs(['https://x.test/a', '-x', '-N', '2'], ['-f', '720', '-N', '16'])
    deepStrictEqual(options.format, { kind: 'bestaudio' })
    strictEqual(options.formatExplicit, true)
    strictEqual(options.connections, 2)
  })

  it('still rejects conflicting formats within one source', () => {
    throws(() => parseArgs(['u'], ['-best', '-x']), /draco\.cfg: conflicting format options/)
  })

  it('refuses URLs and command-line-only flags in the config', () => {
    throws(() => parseArgs(['u'], ['https://x.test/a']), (e: unknown) => e instanceof UsageError && /URLs belong/.test(e.message))
    throws(() => parseArgs(['u'], ['--ignore-config']), /only works on the command line/)
    throws(() => parseArgs(['u'], ['--config-location', 'x.cfg']), /only works on the command line/)
  })

  it('a template in the config allows several URLs; a literal name does not', () => {
    strictEqual(parseArgs(['a', 'b'], ['-o', '%(title)s.%(ext)s']).urls.length, 2)
    throws(() => parseArgs(['a', 'b'], ['-o', 'clip.mp4']), /names one file/)
  })

  it('reads retries and socket timeout', () => {
    const options = parseArgs(['u'], ['-R', '0', '--socket-timeout', '90'])
    strictEqual(options.retries, 0)
    strictEqual(options.socketTimeout, 90)
    throws(() => parseArgs(['u', '-R', '101']), /from 0 to 100/)
  })

  it('works out which config to read from the command line alone', () => {
    deepStrictEqual(configRequest(['u']), { ignore: false, location: null })
    deepStrictEqual(configRequest(['u', '--ignore-config']), { ignore: true, location: null })
    deepStrictEqual(configRequest(['--config-location=D:\\a.cfg', 'u']), { ignore: false, location: 'D:\\a.cfg' })
  })
})

// The supplied yt-dlp config must preserve actual behavior, not discard flags.
it('accepts media config and overrides sorting per key', () => {
  const config = tokenizeConfig(`-f bv*+ba/b
-S lang,quality,res,fps,hdr:12,vbr,vcodec,channels,abr,acodec
--merge-output-format mkv
-o "%(title)s - %(channel,uploader)s [%(id)s].%(ext)s"
--cookies-from-browser firefox
--write-thumbnail
--convert-thumbnails png
--embed-thumbnail
--embed-metadata
--embed-chapters
--windows-filenames
--no-mtime`)
  const options = parseArgs(['https://example.com/video', '-S', 'res'], config)
  strictEqual(options.mediaOptions['--format-sort'], 'res')
  strictEqual(options.mediaOptions['--embed-thumbnail'], true)
  strictEqual(options.mediaOptions['--convert-thumbnails'], 'png')
  strictEqual(options.mediaOptions['--merge-output-format'], 'mkv')
  strictEqual(options.cookiesFromBrowser, 'firefox')
})

describe('F2 writing the default folder into draco.cfg', () => {
  it('replaces an active -P line and leaves everything else byte for byte', () => {
    const text = '# heading\r\n-N 16\r\n-P "D:\\Old"\r\n# tail\r\n'
    strictEqual(withConfigDir(text, 'E:\\New Videos'), '# heading\r\n-N 16\r\n-P "E:\\New Videos"\r\n# tail\r\n')
  })

  it('goes under the commented example when there is no active line', () => {
    const text = '# Download folder\n# -P "D:\\Videos"\n\n# Output\n'
    strictEqual(withConfigDir(text, 'E:\\V'), '# Download folder\n# -P "D:\\Videos"\n-P "E:\\V"\n\n# Output\n')
    deepStrictEqual(tokenizeConfig(withConfigDir(text, 'E:\\V')), ['-P', 'E:\\V'])
  })

  it('appends to a file without an example, or creates one', () => {
    strictEqual(withConfigDir('-N 4\n', 'E:\\V'), '-N 4\n-P "E:\\V"\n')
    strictEqual(withConfigDir('', 'E:\\V'), '-P "E:\\V"\n')
  })
})
