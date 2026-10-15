import { createHash } from 'node:crypto'
import { match, ok, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  HttpAuthenticator,
  basicAuthHeader,
  chooseChallenge,
  digestAuthHeader,
  digestUri,
  parseChallenges,
  type AuthChallenge,
  type Credentials
} from '../src/main/engine/auth.ts'

/**
 * HTTP authentication. The interesting cases are the ones a real server
 * produces and a naive client gets wrong: several challenges in one header,
 * a repeated nonce meaning "wrong password", and Basic over plain HTTP.
 */

const CREDS: Credentials = { username: 'aladdin', password: 'open sesame' }

/** Pulls `name="value"` (or bare) back out of an Authorization header. */
function param(header: string, name: string): string | null {
  const quoted = new RegExp(`${name}="((?:[^"\\\\]|\\\\.)*)"`).exec(header)
  if (quoted) return quoted[1]
  const bare = new RegExp(`${name}=([^,\\s]+)`).exec(header)
  return bare ? bare[1] : null
}

const md5 = (value: string): string => createHash('md5').update(value, 'utf8').digest('hex')

describe('parseChallenges', () => {
  it('reads a plain Basic challenge', () => {
    const [challenge] = parseChallenges('Basic realm="Files"')
    strictEqual(challenge.scheme, 'basic')
    strictEqual(challenge.realm, 'Files')
  })

  it('reads a Digest challenge with all its parameters', () => {
    const [challenge] = parseChallenges(
      'Digest realm="test", qop="auth,auth-int", nonce="abc123", opaque="xyz", algorithm=MD5'
    )
    strictEqual(challenge.scheme, 'digest')
    strictEqual(challenge.realm, 'test')
    strictEqual(challenge.nonce, 'abc123')
    strictEqual(challenge.opaque, 'xyz')
    strictEqual(challenge.algorithm, 'MD5')
    strictEqual(challenge.qop, 'auth,auth-int')
  })

  it('splits several challenges offered in one header', () => {
    // The parameters are comma-separated too, so this cannot be a comma split.
    const challenges = parseChallenges('Digest realm="a", nonce="n1", Basic realm="b"')
    strictEqual(challenges.length, 2)
    strictEqual(challenges[0].scheme, 'digest')
    strictEqual(challenges[0].realm, 'a')
    strictEqual(challenges[1].scheme, 'basic')
    strictEqual(challenges[1].realm, 'b')
  })

  it('joins the repeated header form undici hands over', () => {
    const challenges = parseChallenges(['Digest realm="a", nonce="n1"', 'Basic realm="b"'])
    strictEqual(challenges.length, 2)
  })

  it('reads the stale flag, which is not a rejection', () => {
    strictEqual(parseChallenges('Digest realm="r", nonce="n", stale=TRUE')[0].stale, true)
    strictEqual(parseChallenges('Digest realm="r", nonce="n"')[0].stale, false)
  })

  it('unescapes a quoted realm', () => {
    strictEqual(parseChallenges('Basic realm="say \\"hello\\""')[0].realm, 'say "hello"')
  })

  it('ignores schemes it cannot answer, and junk', () => {
    strictEqual(parseChallenges('Negotiate').length, 0)
    strictEqual(parseChallenges('NTLM, Negotiate').length, 0)
    strictEqual(parseChallenges(undefined).length, 0)
    strictEqual(parseChallenges('').length, 0)
    strictEqual(parseChallenges('x'.repeat(9000)).length, 0, 'a header that long is not a challenge')
  })
})

describe('chooseChallenge', () => {
  const basic: AuthChallenge = { scheme: 'basic', realm: 'r' }
  const digestMd5: AuthChallenge = { scheme: 'digest', realm: 'r', nonce: 'n', algorithm: 'MD5' }
  const digestSha: AuthChallenge = { scheme: 'digest', realm: 'r', nonce: 'n', algorithm: 'SHA-256' }

  it('prefers Digest over Basic, and SHA-256 over MD5', () => {
    strictEqual(chooseChallenge([basic, digestMd5]), digestMd5)
    strictEqual(chooseChallenge([digestMd5, digestSha]), digestSha)
    strictEqual(chooseChallenge([basic]), basic)
  })

  it('skips a Digest challenge with no nonce, which cannot be answered', () => {
    strictEqual(chooseChallenge([{ scheme: 'digest', realm: 'r' }, basic]), basic)
  })

  it('has nothing to choose from an empty list', () => {
    strictEqual(chooseChallenge([]), null)
  })

  it('skips algorithms and qop modes it cannot compute rather than choosing them over Basic', () => {
    strictEqual(chooseChallenge([{ ...digestMd5, algorithm: 'unknown' }, basic]), basic)
    strictEqual(chooseChallenge([{ ...digestMd5, qop: 'auth-int' }, basic]), basic)
  })
})

describe('basicAuthHeader', () => {
  it('matches the example every RFC uses', () => {
    strictEqual(basicAuthHeader({ username: 'Aladdin', password: 'open sesame' }),
      'Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==')
  })

  it('encodes a non-ASCII password as UTF-8', () => {
    const header = basicAuthHeader({ username: 'u', password: 'pä55' })
    strictEqual(Buffer.from(header.slice(6), 'base64').toString('utf8'), 'u:pä55')
  })
})

describe('digestAuthHeader', () => {
  const challenge: AuthChallenge = {
    scheme: 'digest',
    realm: 'testrealm@host.com',
    nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093',
    opaque: '5ccc069c403ebaf9f0171e9517f40e41',
    qop: 'auth',
    algorithm: 'MD5'
  }

  it('computes the response RFC 2617 documents', () => {
    const header = digestAuthHeader(
      challenge,
      { username: 'Mufasa', password: 'Circle Of Life' },
      { method: 'GET', uri: '/dir/index.html', nonceCount: 1, cnonce: '0a4f113b' }
    )

    strictEqual(param(header, 'response'), '6629fae49393a05397450978507c4ef1')
    strictEqual(param(header, 'nc'), '00000001')
    strictEqual(param(header, 'qop'), 'auth')
    strictEqual(param(header, 'opaque'), '5ccc069c403ebaf9f0171e9517f40e41')
  })

  it('answers auth when the server offers auth-int as well', () => {
    // auth-int hashes the body, and the body here is being streamed to disk.
    const header = digestAuthHeader(
      { ...challenge, qop: 'auth-int,auth' },
      CREDS,
      { method: 'GET', uri: '/f', nonceCount: 2, cnonce: 'abc' }
    )
    strictEqual(param(header, 'qop'), 'auth')
  })

  it('drops qop, nc and cnonce for a server that offered no qop', () => {
    const header = digestAuthHeader(
      { scheme: 'digest', realm: 'r', nonce: 'n', algorithm: 'MD5' },
      CREDS,
      { method: 'GET', uri: '/f', nonceCount: 1, cnonce: 'abc' }
    )

    strictEqual(param(header, 'qop'), null)
    strictEqual(param(header, 'nc'), null)
    // The legacy form: MD5(HA1:nonce:HA2).
    const ha1 = md5(`${CREDS.username}:r:${CREDS.password}`)
    const ha2 = md5('GET:/f')
    strictEqual(param(header, 'response'), md5(`${ha1}:n:${ha2}`))
  })

  it('hashes with SHA-256 when the server asks for it', () => {
    const header = digestAuthHeader(
      { ...challenge, algorithm: 'SHA-256' },
      CREDS,
      { method: 'GET', uri: '/f', nonceCount: 1, cnonce: 'abc' }
    )
    strictEqual(param(header, 'response')?.length, 64, 'a SHA-256 digest is 64 hex characters')
    strictEqual(param(header, 'algorithm'), 'SHA-256')
  })

  it('folds the client nonce into HA1 for a -sess algorithm', () => {
    const options = { method: 'GET', uri: '/f', nonceCount: 1, cnonce: 'abc' }
    const plain = digestAuthHeader({ ...challenge, algorithm: 'MD5' }, CREDS, options)
    const sess = digestAuthHeader({ ...challenge, algorithm: 'MD5-sess' }, CREDS, options)
    ok(param(plain, 'response') !== param(sess, 'response'))
    const legacy = digestAuthHeader({ ...challenge, algorithm: 'MD5-sess', qop: undefined }, CREDS, options)
    strictEqual(param(legacy, 'cnonce'), 'abc', 'the server needs this nonce to compute the session digest')
  })

  it('escapes quotes so a hostile realm cannot forge header parameters', () => {
    const header = digestAuthHeader(
      { ...challenge, realm: 'ev"il' },
      { username: 'a"b', password: 'p' },
      { method: 'GET', uri: '/f', nonceCount: 1, cnonce: 'abc' }
    )
    match(header, /realm="ev\\"il"/)
    match(header, /username="a\\"b"/)
  })
})

describe('digestUri', () => {
  it('is the path and query, never the host', () => {
    strictEqual(digestUri('https://example.test/a/b.bin?token=1'), '/a/b.bin?token=1')
    strictEqual(digestUri('https://example.test'), '/')
    strictEqual(digestUri('nonsense'), 'nonsense')
  })
})

describe('HttpAuthenticator', () => {
  const always = (): Credentials => CREDS
  const never = (): null => null

  it('sends nothing until a server has asked', () => {
    const auth = new HttpAuthenticator(always)
    strictEqual(auth.armed, false)
    strictEqual(auth.headerFor('https://example.test/f', 'GET'), null)
  })

  it('resolves new credentials when a different realm challenges on the same origin', () => {
    const auth = new HttpAuthenticator((_url, realm) => ({ username: realm, password: 'password' }))
    auth.challenged('https://example.test/a', 'Basic realm="A"')
    auth.headerFor('https://example.test/a', 'GET')
    strictEqual(auth.challenged('https://example.test/b', 'Basic realm="B"'), true)
    strictEqual(auth.headerFor('https://example.test/b', 'GET'), basicAuthHeader({ username: 'B', password: 'password' }))
  })

  it('arms itself from a challenge and answers every later request', () => {
    const auth = new HttpAuthenticator(always)
    strictEqual(auth.challenged('https://example.test/f', 'Basic realm="Files"'), true)
    strictEqual(auth.armed, true)
    strictEqual(auth.realm, 'Files')

    // Eight connections on one file should not each need to be told "no" first.
    match(auth.headerFor('https://example.test/f', 'GET') ?? '', /^Basic /)
    match(auth.headerFor('https://example.test/other', 'GET') ?? '', /^Basic /)
  })

  it('never sends an armed password to another origin', () => {
    const auth = new HttpAuthenticator(always)
    strictEqual(auth.challenged('https://example.test/file', 'Basic realm="Files"'), true)
    strictEqual(auth.headerFor('https://other.test/file', 'GET'), null)
    strictEqual(auth.headerFor('https://example.test:8443/file', 'GET'), null)
    strictEqual(auth.headerFor('http://example.test/file', 'GET'), null)
    match(auth.headerFor('https://example.test/other', 'GET') ?? '', /^Basic /)
  })

  it('gives every Digest request its own count and client nonce', () => {
    const auth = new HttpAuthenticator(always)
    auth.challenged('https://example.test/f', 'Digest realm="r", nonce="n", qop="auth"')

    const first = auth.headerFor('https://example.test/f', 'GET') ?? ''
    const second = auth.headerFor('https://example.test/f', 'GET') ?? ''

    strictEqual(param(first, 'nc'), '00000001')
    strictEqual(param(second, 'nc'), '00000002')
    ok(param(first, 'cnonce') !== param(second, 'cnonce'))
    ok(param(first, 'response') !== param(second, 'response'))
  })

  it('computes the response over the URL being requested', () => {
    const auth = new HttpAuthenticator(always)
    auth.challenged('https://example.test/a', 'Digest realm="r", nonce="n", qop="auth"')
    strictEqual(param(auth.headerFor('https://example.test/deep/file.bin', 'GET') ?? '', 'uri'), '/deep/file.bin')
  })

  it('does not retry when nobody has a password for the realm', () => {
    const auth = new HttpAuthenticator(never)
    strictEqual(auth.challenged('https://example.test/f', 'Basic realm="Files"'), false)
    strictEqual(auth.armed, false)
  })

  it('remembers the realm even when it could not answer for it', () => {
    // "add a password for Files on example.test" is only sayable if the realm
    // survives the lookup that found nothing.
    const auth = new HttpAuthenticator(never)
    auth.challenged('https://example.test/f', 'Basic realm="Files"')
    strictEqual(auth.realm, 'Files')
    strictEqual(auth.armed, false, 'knowing the realm is not being authenticated')
  })

  it('does not retry a challenge it cannot answer', () => {
    const auth = new HttpAuthenticator(always)
    strictEqual(auth.challenged('https://example.test/f', 'Negotiate'), false)
    strictEqual(auth.challenged('https://example.test/f', undefined), false)
  })

  it('refuses Basic over plain http, where the password is the wire', () => {
    const auth = new HttpAuthenticator(always)
    strictEqual(auth.challenged('http://example.test/f', 'Basic realm="Files"'), false)
    strictEqual(auth.challenged('http://localhost:8080/f', 'Basic realm="Files"'), true, 'your own machine is not a network')
  })

  it('still answers Digest over plain http, which never sends the password', () => {
    const auth = new HttpAuthenticator(always)
    strictEqual(auth.challenged('http://example.test/f', 'Digest realm="r", nonce="n"'), true)
  })

  it('stops after the same nonce is refused - the password is wrong', () => {
    const auth = new HttpAuthenticator(always)
    const challenge = 'Digest realm="r", nonce="n", qop="auth"'

    strictEqual(auth.challenged('https://example.test/f', challenge), true)
    auth.headerFor('https://example.test/f', 'GET')
    // Repeating it would spend attempts on a password that has already failed,
    // and on some servers that is what locks an account.
    strictEqual(auth.challenged('https://example.test/f', challenge), false)
  })

  it('answers again when the server says only that the nonce went stale', () => {
    const auth = new HttpAuthenticator(always)
    auth.challenged('https://example.test/f', 'Digest realm="r", nonce="n", qop="auth"')
    auth.headerFor('https://example.test/f', 'GET')

    strictEqual(
      auth.challenged('https://example.test/f', 'Digest realm="r", nonce="n", qop="auth", stale=true'),
      true
    )
  })

  it('answers a genuinely new nonce, counting from one again', () => {
    const auth = new HttpAuthenticator(always)
    auth.challenged('https://example.test/f', 'Digest realm="r", nonce="n1", qop="auth"')
    auth.headerFor('https://example.test/f', 'GET')

    strictEqual(auth.challenged('https://example.test/f', 'Digest realm="r", nonce="n2", qop="auth"'), true)
    strictEqual(param(auth.headerFor('https://example.test/f', 'GET') ?? '', 'nc'), '00000001')
  })

  it('asks for the password once and keeps it', () => {
    let lookups = 0
    const auth = new HttpAuthenticator(() => {
      lookups++
      return CREDS
    })

    auth.challenged('https://example.test/f', 'Digest realm="r", nonce="n1", qop="auth"')
    auth.headerFor('https://example.test/f', 'GET')
    auth.challenged('https://example.test/f', 'Digest realm="r", nonce="n2", qop="auth"')

    strictEqual(lookups, 1, 'a keychain prompt per connection would be unusable')
  })
})
