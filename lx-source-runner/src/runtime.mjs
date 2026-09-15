import vm from 'node:vm'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFile } from 'node:fs/promises'
import { createCipheriv, createHash, publicEncrypt, randomBytes, constants } from 'node:crypto'
import { inflate, deflate } from 'node:zlib'
import { promisify } from 'node:util'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

const inflateAsync = promisify(inflate)
const deflateAsync = promisify(deflate)
const EVENT_NAMES = Object.freeze({ inited: 'inited', request: 'request', updateAlert: 'updateAlert' })
// LX user-source requests are made by its bundled Needle 3.2.0 client. This is
// intentionally different from the browser-like UA used by LX's own catalog
// requests; provider gateways can distinguish the two.
const LX_DESKTOP_USER_AGENT = `Needle/3.2.0 (Node.js ${process.version}; win32 x64)`

export class LxSourceRuntime {
  constructor({ filename, allowPrivateNetwork = false, initTimeoutMs = 20000, resolveTimeoutMs = 10000 }) {
    this.filename = filename
    this.allowPrivateNetwork = allowPrivateNetwork
    this.initTimeoutMs = initTimeoutMs
    this.resolveTimeoutMs = resolveTimeoutMs
    this.handlers = new Map()
    this.timers = new Set()
    this.intervals = new Set()
    this.info = null
    this.initData = null
    this.context = null
    this.resolveContext = new AsyncLocalStorage()
  }

  async initialize() {
    const rawScript = await readFile(this.filename, 'utf8')
    const metadata = parseMetadata(rawScript)
    let resolveInit
    let rejectInit
    const initialized = new Promise((resolve, reject) => { resolveInit = resolve; rejectInit = reject })
    const lx = {
      EVENT_NAMES,
      // Match LX Desktop's user-source runtime. Some source scripts branch on
      // this value when building provider requests.
      version: '2.0.0',
      env: 'desktop',
      currentScriptInfo: { ...metadata, rawScript },
      on: (event, handler) => {
        if (typeof handler !== 'function') throw new Error(`Handler for ${event} must be a function`)
        this.handlers.set(String(event), handler)
      },
      send: (event, data) => {
        if (event === EVENT_NAMES.inited) {
          try {
            validateInit(data)
            this.initData = structuredClone(data)
            resolveInit(this.initData)
          } catch (error) { rejectInit(error) }
        } else if (event === EVENT_NAMES.updateAlert) {
          console.log(`[LX source ${metadata.name}] update: ${String(data?.log || '').slice(0, 1024)}`)
        }
      },
      request: createRequest(this.allowPrivateNetwork, error => this.signalCallbackError(error)),
      utils: createUtils(),
    }
    const sandbox = {
      lx,
      Buffer,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      AbortController,
      console: sourceConsole(metadata.name),
      setTimeout: (fn, delay, ...args) => {
        const id = setTimeout(() => {
          this.timers.delete(id)
          invokeSourceTask(fn, args, metadata.name, 'timer')
        }, delay)
        this.timers.add(id)
        return id
      },
      clearTimeout: id => { clearTimeout(id); this.timers.delete(id) },
      setInterval: (fn, delay, ...args) => {
        const id = setInterval(() => invokeSourceTask(fn, args, metadata.name, 'interval'), delay)
        this.intervals.add(id)
        return id
      },
      clearInterval: id => { clearInterval(id); this.intervals.delete(id) },
    }
    this.context = vm.createContext(sandbox, { name: `lx-source:${metadata.name}` })
    try {
      new vm.Script(rawScript, { filename: this.filename }).runInContext(this.context, { timeout: 5000 })
      this.info = { ...metadata, filename: this.filename, sources: (await withTimeout(initialized, this.initTimeoutMs, 'Source initialization timed out')).sources }
      if (!this.handlers.has(EVENT_NAMES.request)) throw new Error('Source did not register the request handler')
      return this.info
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  async resolve({ source, musicInfo, quality }) {
    const result = await this.requestAction({ source, musicInfo, quality, action: 'musicUrl' })
    const url = typeof result === 'string' ? result : result?.url
    if (!url || !/^https?:\/\//i.test(url)) throw new Error('Source returned an invalid HTTP media URL')
    return { url, headers: typeof result === 'object' ? result.headers || {} : {} }
  }

  async lyric({ source, musicInfo, quality }) {
    const result = await this.requestAction({ source, musicInfo, quality, action: 'lyric' })
    const value = typeof result === 'string' ? { lyric: result } : result
    if (!value || typeof value !== 'object') throw new Error('Source returned no lyrics')
    const output = {}
    for (const key of ['lyric', 'tlyric', 'rlyric', 'lxlyric']) {
      if (typeof value[key] !== 'string' || !value[key].trim()) continue
      const lyric = await materializeLyric(value[key], this.allowPrivateNetwork, this.resolveTimeoutMs)
      if (lyric.trim()) output[key] = lyric.slice(0, 2_000_000)
    }
    if (!output.lyric) throw new Error('Source returned no lyrics')
    return output
  }

  async requestAction({ source, musicInfo, quality, action }) {
    if (!this.info) throw new Error('Source is not initialized')
    const sourceInfo = this.info.sources?.[source]
    if (!sourceInfo) throw new Error(`Active script does not support source: ${source}`)
    if (!sourceInfo.actions?.includes(action)) throw new Error(`Active script does not support ${action} for: ${source}`)
    const selectedQuality = action === 'musicUrl'
      ? selectSourceQuality(sourceInfo.qualitys, musicInfo?.types, quality)
      : String(quality || '')
    const handler = this.handlers.get(EVENT_NAMES.request)
    let rejectCallbackError
    const callbackError = new Promise((_, reject) => { rejectCallbackError = reject })
    const result = await withTimeout(Promise.race([
      Promise.resolve().then(() => this.resolveContext.run({ reject: rejectCallbackError }, () => handler({
        source,
        action,
        info: { type: selectedQuality, musicInfo: structuredClone(musicInfo || {}) },
      }))),
      callbackError,
    ]), this.resolveTimeoutMs, 'Source resolve timed out')
    return result
  }

  signalCallbackError(error) {
    this.resolveContext.getStore()?.reject(error)
  }

  dispose() {
    for (const id of this.timers) clearTimeout(id)
    for (const id of this.intervals) clearInterval(id)
    this.timers.clear()
    this.intervals.clear()
    this.handlers.clear()
    this.context = null
  }
}

async function materializeLyric(rawValue, allowPrivateNetwork, timeoutMs) {
  const value = String(rawValue).trim()
  if (!/^https?:\/\/\S+$/i.test(value)) return value
  let url = new URL(value)
  for (let redirects = 0; redirects <= 5; redirects++) {
    await assertPublicHost(url.hostname, allowPrivateNetwork)
    const response = await fetch(url, {
      headers: { 'User-Agent': LX_DESKTOP_USER_AGENT },
      redirect: 'manual',
      signal: AbortSignal.timeout(Math.max(1000, Math.min(Number(timeoutMs || 10000), 60000))),
    })
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      url = new URL(response.headers.get('location'), url)
      continue
    }
    if (!response.ok) throw new Error(`Lyric URL returned HTTP ${response.status}`)
    const declaredSize = Number(response.headers.get('content-length') || 0)
    if (declaredSize > 2_000_000) throw new Error('Lyric URL response is too large')
    const body = Buffer.from(await response.arrayBuffer())
    if (body.length > 2_000_000) throw new Error('Lyric URL response is too large')
    const text = body.toString('utf8').replace(/^\uFEFF/, '').trim()
    if (/^\s*<(?:!doctype|html)\b/i.test(text)) throw new Error('Lyric URL returned an HTML page')
    try {
      const parsed = JSON.parse(text)
      if (typeof parsed === 'string') return parsed.trim()
      if (typeof parsed?.lyric === 'string') return parsed.lyric.trim()
      if (typeof parsed?.lrc === 'string') return parsed.lrc.trim()
    } catch {}
    return text
  }
  throw new Error('Lyric URL redirected too many times')
}

function qualityEntries(values) {
  if (!Array.isArray(values)) return []
  return values.map(value => String(typeof value === 'string' ? value : value?.type || '').trim())
    .filter(Boolean)
    .map(raw => ({ raw, canonical: canonicalQuality(raw) }))
}

function canonicalQuality(value) {
  const quality = String(value || '').trim().toLowerCase()
  if (['24bit', 'flac24', 'flac_24bit', 'flac-24bit'].includes(quality)) return 'flac24bit'
  return quality
}

export function selectSourceQuality(declaredValues, trackValues, requestedValue) {
  const declared = qualityEntries(declaredValues)
  if (!declared.length) return String(requestedValue || '128k')
  const track = new Set(qualityEntries(trackValues).map(item => item.canonical))
  const available = track.size ? declared.filter(item => track.has(item.canonical)) : declared
  const requested = canonicalQuality(requestedValue || '128k')
  const priorities = [...new Set([requested, 'flac24bit', 'hires', 'master', 'atmos', 'flac', '320k', '192k', '128k'])]
  return priorities.map(quality => available.find(item => item.canonical === quality)?.raw).find(Boolean)
    || String(requestedValue || '128k')
}

export function parseMetadata(script) {
  const field = name => script.match(new RegExp(`@${name}\\s+([^\\r\\n*]+)`))?.[1]?.trim() || ''
  return {
    name: field('name') || '未命名音源',
    description: field('description'),
    version: field('version'),
    author: field('author'),
    homepage: field('homepage'),
  }
}

export function validateInit(data) {
  if (!data || typeof data !== 'object' || !data.sources || typeof data.sources !== 'object') throw new Error('Invalid inited event: sources is required')
  const reserved = new Set(['__proto__', 'prototype', 'constructor'])
  for (const [key, value] of Object.entries(data.sources)) {
    if (reserved.has(key) || !/^[a-z][a-z0-9_-]{0,63}$/i.test(key)) throw new Error(`Invalid source key: ${key}`)
    if (value?.type !== 'music' || !Array.isArray(value.actions) || !Array.isArray(value.qualitys)) throw new Error(`Invalid source declaration: ${key}`)
  }
}

function createRequest(allowPrivateNetwork, onCallbackError = () => {}) {
  return (rawUrl, rawOptions, callback) => {
    const options = typeof rawOptions === 'function' ? {} : rawOptions || {}
    const done = typeof rawOptions === 'function' ? rawOptions : callback
    if (typeof done !== 'function') throw new Error('request callback is required')
    const controller = new AbortController()
    ;(async () => {
      try {
        const url = new URL(String(rawUrl))
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) requests are allowed')
        if (options.query && typeof options.query === 'object') {
          for (const [key, value] of Object.entries(options.query)) {
            if (Array.isArray(value)) value.forEach(item => url.searchParams.append(key, String(item)))
            else if (value != null) url.searchParams.set(key, String(value))
          }
        }
        if (process.env.DEBUG_SOURCE_REQUESTS === 'true') console.log(`[LX source request] ${url}`)
        await assertPublicHost(url.hostname, allowPrivateNetwork)
        const headers = Object.fromEntries(Object.entries(options.headers || {}).map(([key, value]) => [key, String(value)]))
        if (!hasHeader(headers, 'user-agent')) headers['User-Agent'] = LX_DESKTOP_USER_AGENT
        let body = options.body
        if (options.form) {
          body = new URLSearchParams(Object.entries(options.form).map(([key, value]) => [key, String(value)]))
          if (!hasHeader(headers, 'content-type')) headers['content-type'] = 'application/x-www-form-urlencoded'
        } else if (body && typeof body === 'object' && !Buffer.isBuffer(body) && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) {
          body = JSON.stringify(body)
          if (!hasHeader(headers, 'content-type')) headers['content-type'] = 'application/json'
        }
        const timeout = Math.max(1000, Math.min(Number(options.timeout || 15000), 60000))
        const timeoutId = setTimeout(() => controller.abort(new Error('Request timed out')), timeout)
        let response
        try {
          response = await fetch(url, { method: options.method || (body == null ? 'GET' : 'POST'), headers, body, redirect: 'follow', signal: controller.signal })
        } finally { clearTimeout(timeoutId) }
        const buffer = Buffer.from(await response.arrayBuffer())
        const contentType = response.headers.get('content-type') || ''
        let responseBody = buffer
        if (options.encoding !== null) {
          const stringBody = buffer.toString(options.encoding || 'utf8')
          // LX Desktop attempts JSON parsing for every textual response. Several
          // source services return JSON with text/plain or no Content-Type.
          try { responseBody = JSON.parse(stringBody) } catch { responseBody = stringBody }
        }
        const responseHeaders = Object.fromEntries(response.headers.entries())
        const setCookie = response.headers.getSetCookie?.()
        if (setCookie?.length) responseHeaders['set-cookie'] = setCookie
        const responseObject = {
          statusCode: response.status,
          statusMessage: response.statusText,
          headers: responseHeaders,
          body: responseBody,
          raw: buffer,
        }
        invokeRequestCallback(done, [null, responseObject, responseBody], onCallbackError)
      } catch (error) {
        invokeRequestCallback(done, [error], onCallbackError)
      }
    })()
    return () => controller.abort()
  }
}

function invokeRequestCallback(callback, args, onError) {
  try {
    const result = callback(...args)
    if (result && typeof result.then === 'function') {
      Promise.resolve(result).catch(error => {
        console.warn(`[LX source request callback] ${errorSummary(error)}`)
        onError(error)
      })
    }
  } catch (error) {
    console.warn(`[LX source request callback] ${errorSummary(error)}`)
    onError(error)
  }
}

function invokeSourceTask(callback, args, sourceName, kind) {
  try {
    const result = callback(...args)
    if (result && typeof result.then === 'function') {
      Promise.resolve(result).catch(error => console.warn(`[LX source ${sourceName} ${kind}] ${errorSummary(error)}`))
    }
  } catch (error) {
    console.warn(`[LX source ${sourceName} ${kind}] ${errorSummary(error)}`)
  }
}

function errorSummary(error) {
  const message = String(error?.message || error || 'Unknown error')
  const causeCode = String(error?.cause?.code || '')
  const causeMessage = String(error?.cause?.message || '')
  return [message, causeCode, causeMessage].filter((value, index, values) => value && values.indexOf(value) === index).join(' | ')
}

export function createUtils() {
  return {
    buffer: {
      from: (...args) => Buffer.from(...args),
      bufToString: (buffer, format = 'utf8') => Buffer.from(buffer).toString(format),
    },
    crypto: {
      md5: value => createHash('md5').update(String(value)).digest('hex'),
      randomBytes: size => randomBytes(Number(size)),
      aesEncrypt: (buffer, mode, key, iv) => {
        const keyBuffer = Buffer.from(key)
        const algorithm = normalizeAesAlgorithm(mode, keyBuffer.length)
        const cipher = createCipheriv(algorithm, keyBuffer, algorithm.endsWith('-ecb') ? null : Buffer.from(iv))
        return Buffer.concat([cipher.update(Buffer.from(buffer)), cipher.final()])
      },
      rsaEncrypt: (buffer, key) => {
        // LX Desktop left-pads the input to one 1024-bit RSA block and performs
        // the raw RSA operation. PKCS#1 padding produces a different ciphertext
        // and causes providers such as Kuwo to reject the source request.
        const input = Buffer.from(buffer)
        const padded = Buffer.concat([Buffer.alloc(128 - input.length), input])
        return publicEncrypt({ key, padding: constants.RSA_NO_PADDING }, padded)
      },
    },
    zlib: {
      inflate: buffer => inflateAsync(Buffer.from(buffer)),
      deflate: buffer => deflateAsync(Buffer.from(buffer)),
    },
  }
}

function normalizeAesAlgorithm(mode, keyLength) {
  const value = String(mode || 'cbc').trim().toLowerCase()
  if (/^aes-(128|192|256)-[a-z0-9]+$/.test(value)) return value
  if (!/^[a-z0-9]+$/.test(value)) throw new Error(`Invalid AES mode: ${value}`)
  return `aes-${keyLength * 8}-${value}`
}

export async function assertPublicHost(hostname, allowPrivate) {
  if (allowPrivate) return
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true })
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw new Error('Source request to a private network address was blocked')
}

function isPrivateAddress(address) {
  if (address === '::1' || address === '0.0.0.0' || address === '::') return true
  if (address.startsWith('10.') || address.startsWith('127.') || address.startsWith('169.254.') || address.startsWith('192.168.')) return true
  const parts = address.split('.').map(Number)
  if (parts.length === 4 && parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
  const lowered = address.toLowerCase()
  return lowered.startsWith('fc') || lowered.startsWith('fd') || lowered.startsWith('fe8') || lowered.startsWith('fe9') || lowered.startsWith('fea') || lowered.startsWith('feb')
}

function hasHeader(headers, name) {
  return Object.keys(headers).some(key => key.toLowerCase() === name)
}

function sourceConsole(name) {
  const prefix = `[LX source ${name}]`
  const timers = new Map()
  const counts = new Map()
  const write = (level, ...args) => console[level](prefix, ...args)
  return Object.freeze({
    log: (...args) => write('log', ...args),
    info: (...args) => write('info', ...args),
    warn: (...args) => write('warn', ...args),
    error: (...args) => write('error', ...args),
    debug: (...args) => write('debug', ...args),
    trace: (...args) => write('trace', ...args),
    dir: (...args) => write('dir', ...args),
    table: (...args) => write('table', ...args),
    group: (...args) => { if (args.length) write('log', ...args) },
    groupCollapsed: (...args) => { if (args.length) write('log', ...args) },
    groupEnd: () => {},
    clear: () => {},
    assert: (condition, ...args) => { if (!condition) write('warn', 'Assertion failed', ...args) },
    count: (label = 'default') => {
      const value = (counts.get(label) || 0) + 1
      counts.set(label, value)
      write('log', `${label}: ${value}`)
    },
    countReset: (label = 'default') => counts.delete(label),
    time: (label = 'default') => timers.set(label, Date.now()),
    timeLog: (label = 'default', ...args) => write('log', `${label}: ${Date.now() - (timers.get(label) || Date.now())}ms`, ...args),
    timeEnd: (label = 'default') => {
      write('log', `${label}: ${Date.now() - (timers.get(label) || Date.now())}ms`)
      timers.delete(label)
    },
  })
}

function withTimeout(promise, milliseconds, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds)
    Promise.resolve(promise).then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}
