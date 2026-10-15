import { createHash, randomBytes } from 'node:crypto'

/**
 * HTTP authentication, the kind a server asks for with 401 and a
 * `WWW-Authenticate` header.
 *
 * Draco used to read every 401 as "this signed URL expired, go and refresh it"
 * - true for YouTube's CDN, and wrong for every ordinary password-protected
 * file, which could not be downloaded at all. A 401 that names a challenge is
 * not an expiry; it is a server saying who it wants to hear from.
 *
 * Free of Electron and of the credential store on purpose: what is kept here is
 * the wire protocol, and *where the password comes from* is injected. That
 * makes the whole of it testable without a server and without a keychain.
 */

export interface Credentials {
  username: string
  password: string
}

export interface AuthChallenge {
  scheme: 'basic' | 'digest'
  realm: string
  /** Digest only. */
  nonce?: string
  opaque?: string
  algorithm?: string
  qop?: string
  /** The server saying the nonce went stale, not that the password was wrong. */
  stale?: boolean
}

/**
 * Splits a `WWW-Authenticate` value into the challenges it offers.
 *
 * One header can carry several, comma-separated, each with comma-separated
 * parameters of its own - which is why this walks the string rather than
 * splitting on commas. A scheme token is a bare word followed by whitespace; a
 * parameter is `name=value`, quoted or not.
 */
export function parseChallenges(header: string | string[] | undefined): AuthChallenge[] {
  const raw = Array.isArray(header) ? header.join(', ') : header
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8192) return []

  const challenges: AuthChallenge[] = []
  let current: { scheme: string; params: Record<string, string> } | null = null

  const commit = (): void => {
    if (!current) return
    const scheme = current.scheme.toLowerCase()
    if (scheme === 'basic' || scheme === 'digest') {
      challenges.push({
        scheme,
        realm: current.params.realm ?? '',
        nonce: current.params.nonce,
        opaque: current.params.opaque,
        algorithm: current.params.algorithm,
        qop: current.params.qop,
        stale: /^true$/i.test(current.params.stale ?? '')
      })
    }
    current = null
  }

  // `name=value` (quoted or bare), or a bare scheme token.
  const token = /([A-Za-z][A-Za-z0-9._-]*)\s*(?:=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*)))?/g
  let match: RegExpExecArray | null
  while ((match = token.exec(raw)) !== null) {
    const [, name, quoted, bare] = match
    const hasValue = quoted !== undefined || bare !== undefined

    if (!hasValue) {
      // A word with no value starts a new challenge.
      commit()
      current = { scheme: name, params: {} }
      continue
    }

    if (!current) continue
    current.params[name.toLowerCase()] = quoted !== undefined ? quoted.replace(/\\(.)/g, '$1') : bare ?? ''
  }
  commit()

  return challenges
}

/**
 * The challenge worth answering.
 *
 * Digest before Basic, and a hashed algorithm before MD5, because Basic puts
 * the password on the wire in a form anyone can read back. Over TLS that is
 * survivable; over plain HTTP it is the password itself, which is why
 * `authorizationFor` refuses Basic there.
 */
export function chooseChallenge(challenges: AuthChallenge[]): AuthChallenge | null {
  const score = (challenge: AuthChallenge): number => {
    if (challenge.scheme !== 'digest') return 1
    return /sha-?256/i.test(challenge.algorithm ?? '') ? 3 : 2
  }

  let best: AuthChallenge | null = null
  for (const challenge of challenges) {
    if (challenge.scheme === 'digest') {
      if (!challenge.nonce || !/^(MD5|SHA-?256)(-sess)?$/i.test(challenge.algorithm ?? 'MD5')) continue
      if (challenge.qop && !challenge.qop.split(',').some((value) => value.trim().toLowerCase() === 'auth')) continue
    }
    if (!best || score(challenge) > score(best)) best = challenge
  }
  return best
}

export function basicAuthHeader(credentials: Credentials): string {
  const raw = `${credentials.username}:${credentials.password}`
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`
}

/** The request-target a Digest response is computed over: path plus query. */
export function digestUri(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}`
  } catch {
    return url
  }
}

function hasher(algorithm: string | undefined): (value: string) => string {
  const name = /sha-?256/i.test(algorithm ?? '') ? 'sha256' : 'md5'
  return (value) => createHash(name).update(value, 'utf8').digest('hex')
}

export interface DigestOptions {
  method: string
  uri: string
  nonceCount: number
  cnonce: string
}

/** RFC 7616 / 2617. `-sess` variants fold the client nonce into HA1. */
export function digestAuthHeader(
  challenge: AuthChallenge,
  credentials: Credentials,
  options: DigestOptions
): string {
  const hash = hasher(challenge.algorithm)
  const realm = challenge.realm ?? ''
  const nonce = challenge.nonce ?? ''
  const nc = options.nonceCount.toString(16).padStart(8, '0')

  let ha1 = hash(`${credentials.username}:${realm}:${credentials.password}`)
  if (/-sess$/i.test(challenge.algorithm ?? '')) {
    ha1 = hash(`${ha1}:${nonce}:${options.cnonce}`)
  }
  const ha2 = hash(`${options.method.toUpperCase()}:${options.uri}`)

  // A server offering several qop values is answered with `auth`; `auth-int`
  // would mean hashing the body, and a download's body is the thing we are
  // streaming to disk rather than holding in memory.
  const qop = (challenge.qop ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .includes('auth')
    ? 'auth'
    : null

  const response = qop
    ? hash(`${ha1}:${nonce}:${nc}:${options.cnonce}:auth:${ha2}`)
    : hash(`${ha1}:${nonce}:${ha2}`)

  const parts = [
    `username="${escapeQuoted(credentials.username)}"`,
    `realm="${escapeQuoted(realm)}"`,
    `nonce="${escapeQuoted(nonce)}"`,
    `uri="${escapeQuoted(options.uri)}"`,
    `response="${response}"`
  ]
  if (challenge.algorithm) parts.push(`algorithm=${challenge.algorithm}`)
  if (qop) parts.push(`qop=auth`, `nc=${nc}`, `cnonce="${escapeQuoted(options.cnonce)}"`)
  else if (/-sess$/i.test(challenge.algorithm ?? '')) parts.push(`cnonce="${escapeQuoted(options.cnonce)}"`)
  if (challenge.opaque) parts.push(`opaque="${escapeQuoted(challenge.opaque)}"`)

  return `Digest ${parts.join(', ')}`
}

function escapeQuoted(value: string): string {
  return value.replace(/["\\]/g, '\\$&')
}

/**
 * One host's authentication state for the life of a task.
 *
 * It exists because a download is many requests: eight connections on one file,
 * each of which would otherwise have to be told "no" by the server before it
 * learned to say who it was. The first 401 teaches this object the challenge,
 * and every request after it is authenticated before it is sent.
 *
 * Digest nonce counts must not repeat, so each header gets the next count and
 * its own client nonce.
 */
export class HttpAuthenticator {
  private challenge: AuthChallenge | null = null
  private credentials: Credentials | null = null
  private origin: string | null = null
  private nonceCount = 0
  /**
   * The realm of the last challenge seen, whether or not it could be answered.
   *
   * Kept apart from `challenge`, which is only set once there is a password to
   * go with it: the message a user most needs the realm in is the one saying
   * that nothing is saved for it yet.
   */
  private observedRealm: string | null = null
  private readonly resolve: (url: string, realm: string) => Credentials | null

  constructor(resolve: (url: string, realm: string) => Credentials | null) {
    this.resolve = resolve
  }

  /** True once a challenge has been answered, so callers can send it up front. */
  get armed(): boolean {
    return this.challenge !== null && this.credentials !== null
  }

  /**
   * Learns from a 401.
   *
   * Returns whether the request is worth sending again: it is not, if the
   * server named no challenge Draco can answer, or if nobody has a password for
   * it, or if the same nonce has just failed - which means the password is
   * wrong, and repeating it only locks the account out.
   */
  challenged(url: string, header: string | string[] | undefined): boolean {
    const challenge = chooseChallenge(parseChallenges(header))
    if (!challenge) return false
    let origin: string
    try { origin = new URL(url).origin } catch { return false }

    // Basic sends the password in plain text. Over http:// that hands it to
    // anyone on the path, so it is refused rather than quietly leaked.
    if (challenge.scheme === 'basic' && !isSecureUrl(url)) return false

    this.observedRealm = challenge.realm || null

    const sameNonce =
      this.origin === origin &&
      this.challenge?.scheme === challenge.scheme &&
      this.challenge?.realm === challenge.realm &&
      this.challenge?.nonce === challenge.nonce

    // A repeat of a nonce we already answered means the credentials were
    // refused - unless the server says the nonce merely went stale, which is a
    // request to compute again, not a rejection.
    if (sameNonce && this.nonceCount > 0 && !challenge.stale) return false

    const credentials = this.origin === origin && this.challenge?.realm === challenge.realm && this.credentials
      ? this.credentials : this.resolve(url, challenge.realm)
    if (!credentials) return false

    this.challenge = challenge
    this.credentials = credentials
    this.origin = origin
    if (!sameNonce) this.nonceCount = 0
    return true
  }

  /** The `Authorization` value for this request, or null when there is none. */
  headerFor(url: string, method: string): string | null {
    if (!this.challenge || !this.credentials) return null
    try {
      if (new URL(url).origin !== this.origin) return null
    } catch { return null }

    if (this.challenge.scheme === 'basic') {
      this.nonceCount++
      return basicAuthHeader(this.credentials)
    }

    this.nonceCount++
    return digestAuthHeader(this.challenge, this.credentials, {
      method,
      uri: digestUri(url),
      nonceCount: this.nonceCount,
      cnonce: randomBytes(8).toString('hex')
    })
  }

  /** The realm the server named, for the message shown when there is no password. */
  get realm(): string | null {
    return this.challenge?.realm || this.observedRealm
  }
}

function isSecureUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    // localhost is not on anyone's path, and refusing it would make testing an
    // authenticated server on your own machine impossible.
    return parsed.protocol === 'https:' || parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
  } catch {
    return false
  }
}

/**
 * What to tell the user about a 401 that survived every attempt.
 *
 * "HTTP 401" is technically the truth and practically useless: the thing the
 * person has to do next is put a username and password somewhere, so the
 * message says which site is asking, which area it named, and where to enter
 * it.
 */
export function authFailureMessage(url: string, realm: string | null, hadCredentials: boolean): string {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    host = 'that site'
  }

  const where = realm ? `${host} (${realm})` : host
  return hadCredentials
    ? `${where} rejected the saved username and password. Update them in Options - Connection.`
    : `${where} needs a username and password. Add them in Options - Connection.`
}
