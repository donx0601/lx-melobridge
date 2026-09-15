import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'

export async function fetchJson(url, { headers = {}, timeoutMs = 10000 } = {}) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('Provider returned invalid JSON')
  }
}

const privateIpv4 = address => {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part))) return true
  const [a, b] = parts
  return a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
}

const privateIpv6 = address => {
  const normalized = address.toLowerCase()
  if (normalized === '::' || normalized === '::1') return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  if (/^fe[89ab]/.test(normalized)) return true
  if (normalized.startsWith('::ffff:')) {
    const embedded = normalized.slice('::ffff:'.length)
    return isIP(embedded) === 4 ? privateIpv4(embedded) : true
  }
  return false
}

export async function assertSafeMediaUrl(input, allowPrivate = false) {
  const url = new URL(input)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Unsupported media protocol: ${url.protocol}`)
  if (allowPrivate) return url
  if (['localhost', 'localhost.localdomain'].includes(url.hostname.toLowerCase())) throw new Error('Private media host rejected')
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname, family: isIP(url.hostname) }]
    : await lookup(url.hostname, { all: true, verbatim: true })
  if (!addresses.length) throw new Error('Media hostname did not resolve')
  for (const { address, family } of addresses) {
    if ((family === 4 && privateIpv4(address)) || (family === 6 && privateIpv6(address))) {
      throw new Error(`Private media address rejected: ${address}`)
    }
  }
  return url
}

const forwardedResponseHeaders = [
  'content-type', 'content-length', 'content-range', 'accept-ranges',
  'etag', 'last-modified', 'cache-control', 'content-disposition',
]

export async function proxyMedia(req, res, inputUrl, providerHeaders, options = {}) {
  let response = await requestMedia(req, inputUrl, providerHeaders, options)
  if ([401, 403, 404, 410].includes(response.status) && typeof options.refresh === 'function') {
    await response.body?.cancel().catch(() => {})
    const refreshed = await options.refresh(response.status)
    response = await requestMedia(req, refreshed.url, refreshed.headers || {}, options)
  }

  const headers = {}
  for (const name of forwardedResponseHeaders) {
    const value = response.headers.get(name)
    if (value != null) headers[name] = value
  }
  if (!headers['accept-ranges']) headers['accept-ranges'] = 'bytes'
  res.writeHead(response.status, headers)
  if (req.method === 'HEAD' || !response.body) return res.end()
  Readable.fromWeb(response.body).on('error', error => res.destroy(error)).pipe(res)
}

async function requestMedia(req, inputUrl, providerHeaders, options) {
  let url = await assertSafeMediaUrl(inputUrl, options.allowPrivate)
  const requestHeaders = { ...providerHeaders }
  if (req.headers.range) requestHeaders.range = req.headers.range
  if (req.headers['user-agent'] && !requestHeaders['user-agent'] && !requestHeaders['User-Agent']) {
    requestHeaders['user-agent'] = req.headers['user-agent']
  }

  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(url, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: requestHeaders,
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs || 30000),
    })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get('location')
    await response.body?.cancel().catch(() => {})
    if (!location) throw new Error('Media redirect omitted Location')
    url = await assertSafeMediaUrl(new URL(location, url).toString(), options.allowPrivate)
    if (redirects === 5) throw new Error('Too many media redirects')
  }
  throw new Error('Media request failed')
}
