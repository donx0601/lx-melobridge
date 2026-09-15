import { createServer } from 'node:http'
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { LxSourceRuntime, assertPublicHost, parseMetadata } from './runtime.mjs'

const port = positive(process.env.PORT, 3200)
const sourceDir = path.resolve(process.env.SOURCE_DIR || '/sources')
const dataDir = path.resolve(process.env.DATA_DIR || '/data')
const stateFile = path.join(dataDir, 'lx-source-runner.json')
const token = String(process.env.RESOLVER_TOKEN || '')
const adminUser = String(process.env.ADMIN_USER || 'admin')
const adminPassword = String(process.env.ADMIN_PASSWORD || 'change-me')
const adminBasePathValue = String(process.env.ADMIN_BASE_PATH || '').trim().replace(/^\/+|\/+$/g, '')
const adminBasePath = adminBasePathValue ? `/${adminBasePathValue}` : ''
const allowPrivateNetwork = process.env.ALLOW_SOURCE_PRIVATE_NETWORK === 'true'
const autoScriptFallback = process.env.AUTO_SCRIPT_FALLBACK === 'true'
const verifyMediaUrl = process.env.VERIFY_MEDIA_URL !== 'false'
const mediaProbeSources = new Set(String(process.env.MEDIA_PROBE_SOURCES || 'kw').split(',').map(value => value.trim()).filter(Boolean))
const fallbackSources = String(process.env.FALLBACK_SOURCES || '').split(',').map(value => value.trim()).filter(Boolean)
const maxSourceAttempts = positive(process.env.MAX_SOURCE_ATTEMPTS, 5)
const sourceAttemptTimeoutMs = positive(process.env.SOURCE_ATTEMPT_TIMEOUT_MS, 8000)
const mediaProbeTimeoutMs = positive(process.env.MEDIA_PROBE_TIMEOUT_MS, 8000)
const resolveCacheTtlMs = positive(process.env.RESOLVE_CACHE_TTL_MS, 120000)
const lyricCacheTtlMs = positive(process.env.LYRIC_CACHE_TTL_MS, 3600000)
const sourceWarmupUrls = String(process.env.SOURCE_WARMUP_URLS || 'https://interface3.music.163.com/').split(',').map(value => value.trim()).filter(Boolean)
const runnerVersion = '0.5.5'
let active = null
let activeFilename = null
let lastError = null
let lastResolution = null
const resolveCache = new Map()
const pendingResolutions = new Map()
const lyricCache = new Map()

process.on('unhandledRejection', error => {
  lastError = `Source background task failed: ${conciseError(error)}`
  console.error(`[LX source background error] ${conciseError(error)}`)
})

await loadInitial()

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, status())
    if (req.method === 'GET' && url.pathname === '/') return admin(req, res)
    if (req.method === 'GET' && url.pathname === '/scripts') {
      if (!authorizedApi(req)) return json(res, 401, { error: 'Unauthorized' })
      return json(res, 200, { items: await listScripts(), active: activeFilename })
    }
    if (req.method === 'POST' && url.pathname === '/select') {
      if (!authorizedApi(req)) return json(res, 401, { error: 'Unauthorized' })
      const body = await readJson(req)
      return json(res, 200, await selectScript(body.filename))
    }
    if (req.method === 'POST' && url.pathname === '/select-form') {
      if (!authorizedBasic(req, res)) return
      const form = new URLSearchParams((await readBody(req)).toString('utf8'))
      await selectScript(form.get('filename'))
      res.writeHead(303, { location: `${adminBasePath}/`, 'cache-control': 'no-store' })
      return res.end()
    }
    if (req.method === 'POST' && url.pathname === '/resolve') {
      if (!authorizedApi(req)) return json(res, 401, { error: 'Unauthorized' })
      if (!active) return json(res, 503, { error: lastError || 'No active LX source script' })
      return json(res, 200, await resolveRequest(await readJson(req)))
    }
    if (req.method === 'POST' && url.pathname === '/lyric') {
      if (!authorizedApi(req)) return json(res, 401, { error: 'Unauthorized' })
      if (!active) return json(res, 503, { error: lastError || 'No active LX source script' })
      return json(res, 200, await lyricRequest(await readJson(req)))
    }
    return json(res, 404, { error: 'Not found' })
  } catch (error) {
    console.error(error)
    return json(res, 500, { error: error.message })
  }
})

server.listen(port, '0.0.0.0', () => {
  console.log(`lx-melobridge source runner ${runnerVersion} listening on http://0.0.0.0:${port}`)
  void warmSourceNetworks()
})

async function warmSourceNetworks() {
  await Promise.allSettled(sourceWarmupUrls.map(async value => {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return
    await assertPublicHost(url.hostname, allowPrivateNetwork)
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
    await response.body?.cancel().catch(() => {})
  }))
}

async function loadInitial() {
  let saved = null
  try { saved = JSON.parse(await readFile(stateFile, 'utf8')).active } catch {}
  // ACTIVE_SOURCE is a bootstrap default. Once the user selects a script, the
  // persisted choice must survive container recreation.
  const requested = String(saved || process.env.ACTIVE_SOURCE || '')
  if (!requested) {
    lastError = 'No active source selected'
    return
  }
  try { await loadScript(requested, false) } catch (error) {
    lastError = error.message
    console.error(`Could not load ${requested}: ${error.message}`)
  }
}

async function selectScript(filename) {
  const info = await loadScript(filename, true)
  return { ok: true, active: activeFilename, info }
}

async function loadScript(rawFilename, persist) {
  const filename = safeFilename(rawFilename)
  const candidate = await initializeScript(filename)
  const info = candidate.info
  if (persist) await persistActive(filename)
  const previous = active
  active = candidate
  activeFilename = filename
  lastError = null
  lastResolution = null
  resolveCache.clear()
  lyricCache.clear()
  previous?.dispose()
  console.log(`Active LX source: ${info.name} (${filename})`)
  return info
}

async function initializeScript(filename) {
  const safe = safeFilename(filename)
  const fullPath = path.resolve(sourceDir, safe)
  if (path.dirname(fullPath) !== sourceDir || path.extname(fullPath).toLowerCase() !== '.js') throw new Error('Only .js files directly inside SOURCE_DIR can be selected')
  const candidate = new LxSourceRuntime({
    filename: fullPath,
    allowPrivateNetwork,
    resolveTimeoutMs: sourceAttemptTimeoutMs,
  })
  await candidate.initialize()
  return candidate
}

async function persistActive(filename) {
  await mkdir(dataDir, { recursive: true })
  await writeFile(stateFile, JSON.stringify({ active: filename }, null, 2), 'utf8')
}

async function resolveRequest(input) {
  const cacheKey = JSON.stringify({
    source: String(input?.source || ''),
    quality: String(input?.quality || ''),
    musicInfo: input?.musicInfo || {},
  })
  if (input?.refresh) resolveCache.delete(cacheKey)
  const cached = resolveCache.get(cacheKey)
  if (!input?.refresh && cached && cached.expiresAt > Date.now()) return { ...cached.value, cached: true }
  if (cached) resolveCache.delete(cacheKey)
  if (pendingResolutions.has(cacheKey)) return pendingResolutions.get(cacheKey)

  const pending = resolveWithFallback(input).then(value => {
    resolveCache.set(cacheKey, { value, expiresAt: Date.now() + resolveCacheTtlMs })
    return value
  }).finally(() => pendingResolutions.delete(cacheKey))
  pendingResolutions.set(cacheKey, pending)
  return pending
}

async function lyricRequest(input) {
  const cacheKey = JSON.stringify({
    source: String(input?.source || ''),
    musicInfo: input?.musicInfo || {},
  })
  const cached = lyricCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return { ...cached.value, cached: true }
  if (cached) lyricCache.delete(cacheKey)

  const startedWith = activeFilename
  const attempts = []
  const candidates = [{ filename: activeFilename, runtime: active, temporary: false }]
  if (autoScriptFallback && maxSourceAttempts > 1) {
    const filenames = await fallbackCandidates(activeFilename)
    for (const filename of filenames.slice(0, maxSourceAttempts - 1)) candidates.push({ filename, runtime: null, temporary: true })
  }

  for (const candidate of candidates) {
    let runtime = candidate.runtime
    try {
      if (!runtime) runtime = await initializeScript(candidate.filename)
      const result = await lyricFromRuntime(runtime, input)
      if (candidate.temporary) {
        await persistActive(candidate.filename)
        const previous = active
        active = runtime
        activeFilename = candidate.filename
        candidate.temporary = false
        previous?.dispose()
        resolveCache.clear()
        lyricCache.clear()
        console.log(`[LX lyric fallback] switched ${startedWith} -> ${candidate.filename} after ${attempts.length} failed attempt(s)`)
      }
      const value = { ...result, sourceScript: candidate.filename, fallbackFrom: candidate.filename === startedWith ? null : startedWith }
      lyricCache.set(cacheKey, { value, expiresAt: Date.now() + lyricCacheTtlMs })
      lastError = null
      return value
    } catch (error) {
      attempts.push({ filename: candidate.filename, error: conciseError(error) })
      console.warn(`[LX lyric fallback] ${candidate.filename} failed: ${conciseError(error)}`)
    } finally {
      if (candidate.temporary) runtime?.dispose()
    }
  }
  const summary = attempts.map(item => `${item.filename}: ${item.error}`).join('; ')
  const error = new Error(`All LX source scripts failed to return lyrics (${summary})`)
  lastError = error.message
  throw error
}

async function lyricFromRuntime(runtime, input) {
  const sourceInfo = runtime.info?.sources?.[String(input?.source || '')]
  if (!sourceInfo?.actions?.includes('lyric')) throw new Error(`Source script does not support lyrics for: ${String(input?.source || '')}`)
  try {
    return await runtime.lyric(input)
  } catch (firstError) {
    // Some LX scripts return lyrics cached as a side effect of musicUrl.
    if (!sourceInfo.actions?.includes('musicUrl')) throw firstError
    await runtime.resolve(input)
    return runtime.lyric(input)
  }
}

async function resolveWithFallback(input) {
  const startedWith = activeFilename
  const attempts = []
  try {
    const result = await resolveAndVerify(active, input)
    recordResolution(input, activeFilename, startedWith, attempts)
    return { ...result, sourceScript: activeFilename }
  } catch (error) {
    attempts.push({ filename: activeFilename, error: conciseError(error) })
    console.warn(`[LX fallback] ${activeFilename} failed: ${conciseError(error)}`)
  }

  if (!autoScriptFallback || maxSourceAttempts <= 1) {
    const error = activeSourceFailed(input, attempts[0])
    lastError = error.message
    lastResolution = {
      ok: false,
      at: new Date().toISOString(),
      source: String(input?.source || ''),
      track: trackLabel(input),
      sourceScript: activeFilename,
      failedAttempts: attempts,
    }
    throw error
  }
  const filenames = await fallbackCandidates(activeFilename)
  for (const filename of filenames.slice(0, maxSourceAttempts - 1)) {
    let candidate = null
    try {
      candidate = await initializeScript(filename)
      const result = await resolveAndVerify(candidate, input)
      await persistActive(filename)
      const previous = active
      active = candidate
      activeFilename = filename
      candidate = null
      previous?.dispose()
      resolveCache.clear()
      lastError = null
      console.log(`[LX fallback] switched ${startedWith} -> ${filename} after ${attempts.length} failed attempt(s)`)
      recordResolution(input, filename, startedWith, attempts)
      return { ...result, sourceScript: filename, fallbackFrom: startedWith }
    } catch (error) {
      attempts.push({ filename, error: conciseError(error) })
      console.warn(`[LX fallback] ${filename} failed: ${conciseError(error)}`)
    } finally {
      candidate?.dispose()
    }
  }
  const error = allSourcesFailed(input, attempts)
  lastError = error.message
  lastResolution = {
    ok: false,
    at: new Date().toISOString(),
    source: String(input?.source || ''),
    track: trackLabel(input),
    attempts,
  }
  throw error
}

async function fallbackCandidates(current) {
  const available = (await listScripts()).map(item => item.filename)
    .filter(filename => filename !== current && !filename.toLowerCase().startsWith('example-'))
  return [...new Set([
    ...fallbackSources.filter(filename => available.includes(filename)),
    ...available.sort((left, right) => left.localeCompare(right, 'zh-CN')),
  ])]
}

async function resolveAndVerify(runtime, input) {
  const result = await runtime.resolve(input)
  if (verifyMediaUrl && (mediaProbeSources.has('*') || mediaProbeSources.has(String(input?.source || '')))) await verifyMedia(result)
  return result
}

async function verifyMedia(result) {
  let url = new URL(result.url)
  const headers = Object.fromEntries(Object.entries(result.headers || {}).map(([name, value]) => [name, String(value)]))
  if (!Object.keys(headers).some(name => name.toLowerCase() === 'range')) headers.range = 'bytes=0-4095'
  let response
  for (let redirects = 0; redirects <= 5; redirects++) {
    await assertPublicHost(url.hostname, allowPrivateNetwork)
    response = await fetch(url, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(mediaProbeTimeoutMs),
    })
    if (![301, 302, 303, 307, 308].includes(response.status)) break
    const location = response.headers.get('location')
    if (!location) throw new Error('Media probe redirect omitted Location')
    url = new URL(location, url)
    if (redirects === 5) throw new Error('Media probe exceeded redirect limit')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`Media probe returned HTTP ${response.status}`)
  }
  const bytes = await readPrefix(response.body, 4096)
  const contentType = String(response.headers.get('content-type') || '').toLowerCase()
  const antiTheftText = Buffer.from('防盗链打击音', 'utf16le')
  if (bytes.includes(antiTheftText)) throw new Error('Media probe detected Kuwo anti-hotlink audio')
  if (!looksLikeAudio(bytes) && !contentType.startsWith('audio/') && !contentType.includes('octet-stream')) {
    throw new Error(`Media probe returned non-audio content: ${contentType || 'unknown'}`)
  }
}

async function readPrefix(body, limit) {
  if (!body) return Buffer.alloc(0)
  const reader = body.getReader()
  const chunks = []
  let size = 0
  try {
    while (size < limit) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      chunks.push(chunk.subarray(0, Math.min(chunk.length, limit - size)))
      size += Math.min(chunk.length, limit - size)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks, size)
}

function looksLikeAudio(buffer) {
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from('ID3'))) return true
  if (buffer.length >= 4 && ['fLaC', 'OggS', 'RIFF'].some(signature => buffer.subarray(0, 4).equals(Buffer.from(signature)))) return true
  if (buffer.length >= 12 && buffer.subarray(4, 8).equals(Buffer.from('ftyp'))) return true
  if (buffer.length >= 2 && buffer[0] === 0xff && ((buffer[1] & 0xe0) === 0xe0 || (buffer[1] & 0xf6) === 0xf0)) return true
  return false
}

function recordResolution(input, filename, startedWith, attempts) {
  lastError = null
  lastResolution = {
    ok: true,
    at: new Date().toISOString(),
    source: String(input?.source || ''),
    track: trackLabel(input),
    sourceScript: filename,
    fallbackFrom: filename === startedWith ? null : startedWith,
    failedAttempts: attempts,
  }
}

function trackLabel(input) {
  return String(input?.musicInfo?.name || input?.musicInfo?.songmid || 'unknown').slice(0, 160)
}

function allSourcesFailed(input, attempts) {
  const summary = attempts.map(item => `${item.filename}: ${item.error}`).join('; ')
  return new Error(`All LX source scripts failed for ${String(input?.source || 'unknown')} ${trackLabel(input)} (${summary})`)
}

function activeSourceFailed(input, attempt) {
  return new Error(`Active LX source failed for ${String(input?.source || 'unknown')} ${trackLabel(input)} (${attempt?.filename || activeFilename}: ${attempt?.error || 'unknown error'})`)
}

async function listScripts() {
  let entries = []
  try { entries = await readdir(sourceDir, { withFileTypes: true }) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return Promise.all(entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.js')).map(async entry => {
    try {
      const metadata = parseMetadata(await readFile(path.join(sourceDir, entry.name), 'utf8'))
      return { filename: entry.name, ...metadata }
    } catch (error) { return { filename: entry.name, error: error.message } }
  }))
}

async function admin(req, res) {
  if (!authorizedBasic(req, res)) return
  const scripts = await listScripts()
  const options = scripts.map(item => `<option value="${escapeHtml(item.filename)}"${item.filename === activeFilename ? ' selected' : ''}>${escapeHtml(item.name)} — ${escapeHtml(item.filename)}</option>`).join('')
  const sources = active?.info?.sources ? Object.keys(active.info.sources).join('、') : '无'
  const body = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>洛雪音源切换</title><style>body{font:16px/1.6 system-ui;max-width:560px;margin:36px auto;padding:0 18px;color:#172033}h1{font-size:24px}.card{padding:18px;border:1px solid #d7ddea;border-radius:14px;background:#f8faff}select,button{width:100%;box-sizing:border-box;font:inherit;padding:12px;border:1px solid #bbc3d3;border-radius:10px;background:white}button{margin-top:16px;background:#246bfd;color:#fff;border:0;font-weight:700}.muted{color:#637083;font-size:14px}.error{color:#b42318}</style><h1>洛雪音源脚本</h1><div class="card"><div>当前：<strong>${escapeHtml(active?.info?.name || '未选择')}</strong></div><div>文件：${escapeHtml(activeFilename || '-')}</div><div>支持：${escapeHtml(sources)}</div>${lastError ? `<div class="error">${escapeHtml(lastError)}</div>` : ''}</div><p class="muted">把 .js 文件放进服务器的 sources 目录，再在这里选择。只有脚本初始化成功才会替换当前脚本。</p><form method="post" action="${escapeHtml(adminBasePath)}/select-form"><select name="filename" required>${options}</select><button type="submit">切换并立即生效</button></form></html>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
  res.end(body)
}

function status() {
  return {
    ok: Boolean(active),
    version: runnerVersion,
    active: activeFilename,
    script: active?.info || null,
    lastError,
    lastResolution,
    allowPrivateNetwork,
    autoScriptFallback,
    verifyMediaUrl,
    mediaProbeSources: [...mediaProbeSources],
    sourceWarmupUrls,
    fallbackSources,
    maxSourceAttempts,
    resolveCacheEntries: resolveCache.size,
    lyricCacheEntries: lyricCache.size,
  }
}

function conciseError(error) {
  const message = String(error?.message || error || 'Unknown error')
  const causeCode = String(error?.cause?.code || '')
  const causeMessage = String(error?.cause?.message || '')
  return [message, causeCode, causeMessage].filter((value, index, values) => value && values.indexOf(value) === index).join(' | ')
}

function authorizedApi(req) {
  return !token || req.headers.authorization === `Bearer ${token}`
}

function authorizedBasic(req, res) {
  const encoded = String(req.headers.authorization || '').match(/^Basic\s+(.+)$/i)?.[1]
  const decoded = Buffer.from(encoded || '', 'base64').toString('utf8')
  const separator = decoded.indexOf(':')
  if (separator >= 0 && decoded.slice(0, separator) === adminUser && decoded.slice(separator + 1) === adminPassword) return true
  res.writeHead(401, { 'www-authenticate': 'Basic realm="LX Source Runner"', 'content-type': 'text/plain; charset=utf-8' })
  res.end('Authentication required')
  return false
}

function safeFilename(value) {
  const filename = String(value || '').trim()
  if (!filename || filename !== path.basename(filename) || filename.includes('\0')) throw new Error('Invalid source filename')
  return filename
}

async function readJson(req) {
  try { return JSON.parse((await readBody(req)).toString('utf8') || '{}') }
  catch { throw new Error('Invalid JSON body') }
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1024 * 1024) throw new Error('Request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function positive(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback
}

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' })
  res.end(body)
}
