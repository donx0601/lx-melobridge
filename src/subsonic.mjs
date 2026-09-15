import { createHash, timingSafeEqual } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { config } from './config.mjs'
import { subsonicXml } from './codec.mjs'

export const API_VERSION = '1.16.1'
export const SERVER_VERSION = '0.5.5'

const safeEqual = (left, right) => {
  const a = Buffer.from(String(left))
  const b = Buffer.from(String(right))
  return a.length === b.length && timingSafeEqual(a, b)
}

export function verifyAuth(params) {
  if (!safeEqual(params.get('u') || '', config.gatewayUser)) return false
  const suppliedPassword = params.get('p')
  if (suppliedPassword != null) {
    let password = suppliedPassword
    if (password.startsWith('enc:')) {
      try { password = Buffer.from(password.slice(4), 'hex').toString('utf8') } catch { return false }
    }
    return safeEqual(password, config.gatewayPassword)
  }
  const token = params.get('t')
  const salt = params.get('s')
  if (!token || !salt) return false
  const expected = createHash('md5').update(config.gatewayPassword + salt).digest('hex')
  return safeEqual(token.toLowerCase(), expected.toLowerCase())
}

export function root(payload = {}) {
  return {
    status: 'ok',
    version: API_VERSION,
    type: 'lx-melobridge',
    serverVersion: SERVER_VERSION,
    openSubsonic: true,
    ...payload,
  }
}

export function sendSubsonic(res, format, payload = {}) {
  const data = root(payload)
  if (format === 'json') return sendJson(res, 200, { 'subsonic-response': data })
  return sendXml(res, 200, subsonicXml(data))
}

export function sendError(res, format, code, message) {
  const data = {
    status: 'failed',
    version: API_VERSION,
    type: 'lx-melobridge',
    serverVersion: SERVER_VERSION,
    error: { code, message },
  }
  if (format === 'json') return sendJson(res, 200, { 'subsonic-response': data })
  return sendXml(res, 200, subsonicXml(data))
}

export function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  res.end(body)
}

export function sendXml(res, status, value) {
  const body = Buffer.from(value)
  res.writeHead(status, {
    'content-type': 'text/xml; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  res.end(body)
}

export function sendText(res, status, value) {
  const body = Buffer.from(value)
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': body.length })
  res.end(body)
}

export function navidromeTarget(requestUrl) {
  if (!config.navidromeUrl) return null
  const target = new URL(requestUrl, `${config.navidromeUrl}/`)
  for (const key of ['u', 'p', 't', 's']) target.searchParams.delete(key)
  target.searchParams.set('u', config.navidromeUser)
  target.searchParams.set('p', `enc:${Buffer.from(config.navidromePassword).toString('hex')}`)
  return target
}

export async function fetchNavidrome(requestUrl, headers = {}) {
  const target = navidromeTarget(requestUrl)
  if (!target) return null
  const cleanHeaders = { ...headers }
  delete cleanHeaders.host
  delete cleanHeaders['accept-encoding']
  const response = await fetch(target, {
    headers: cleanHeaders,
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
  })
  return {
    status: response.status,
    headers: response.headers,
    body: Buffer.from(await response.arrayBuffer()),
  }
}

export function proxyNavidrome(req, res, requestUrl = req.url) {
  const target = navidromeTarget(requestUrl)
  if (!target) return sendText(res, 404, 'Navidrome is not configured')
  const client = target.protocol === 'https:' ? httpsRequest : httpRequest
  const headers = { ...req.headers, host: target.host }
  const upstream = client(target, { method: req.method, headers }, upstreamRes => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers)
    upstreamRes.pipe(res)
  })
  upstream.on('error', error => {
    console.error(`Navidrome proxy error: ${error.message}`)
    if (!res.headersSent) sendText(res, 502, 'Navidrome unavailable')
    else res.destroy(error)
  })
  req.pipe(upstream)
}
