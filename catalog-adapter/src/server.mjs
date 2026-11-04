import { createServer } from 'node:http'
import { decodeCatalogId, FALLBACK_SOURCE_ORDER, findAlternateCatalogTrackForSource, searchCatalogs } from './catalogs.mjs'
import { getPlaylistDetail, searchPlaylists } from './playlists.mjs'
import { getChartDetail, listCharts } from './charts.mjs'
import { fetchCatalogLyrics } from './lyrics.mjs'

const port = positive(process.env.PORT, 3100)
const resolverUrl = String(process.env.RESOLVER_URL || '').replace(/\/$/, '')
const resolverToken = String(process.env.RESOLVER_TOKEN || '')
const resolverTimeoutMs = positive(process.env.RESOLVER_TIMEOUT_MS, 60000)
const resolverAttemptTimeoutMs = positive(process.env.RESOLVER_ATTEMPT_TIMEOUT_MS, 10000)
const platformFallback = process.env.PLATFORM_FALLBACK !== 'false'
const fastPlatformFallback = process.env.FAST_PLATFORM_FALLBACK !== 'false'
const maxPlatformAttempts = positive(process.env.MAX_PLATFORM_ATTEMPTS, 5)
const resolveCacheTtlMs = positive(process.env.RESOLVE_CACHE_TTL_MS, 120000)
const adapterVersion = '0.5.6'
let lastResolution = null
const resolutionCache = new Map()

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    if (url.pathname === '/healthz') return await health(res)
    if (url.pathname === '/search') return await search(res, url)
    if (url.pathname === '/playlist/search') return await playlistSearch(res, url)
    if (url.pathname === '/playlist/detail') return await playlistDetail(res, url)
    if (url.pathname === '/chart/list') return await chartList(res, url)
    if (url.pathname === '/chart/detail') return await chartDetail(res, url)
    if (url.pathname.startsWith('/lyric/')) return await lyric(res, url)
    if (url.pathname.startsWith('/resolve/')) return await resolve(res, url)
    return json(res, 404, { error: 'Not found' })
  } catch (error) {
    console.error(error)
    return json(res, 500, { error: error.message })
  }
})

server.listen(port, '0.0.0.0', () => console.log(`lx-melobridge catalog adapter ${adapterVersion} listening on http://0.0.0.0:${port}`))

async function health(res) {
  let resolver = { configured: Boolean(resolverUrl), ok: false }
  if (resolverUrl) {
    try {
      const response = await fetch(`${resolverUrl}/healthz`, {
        headers: resolverToken ? { authorization: `Bearer ${resolverToken}` } : {},
        signal: AbortSignal.timeout(3000),
      })
      const detail = await response.json().catch(() => ({}))
      resolver = { configured: true, ok: response.ok, status: response.status, ...detail }
    } catch (error) {
      resolver = { configured: true, ok: false, error: error.message }
    }
  }
  return json(res, 200, { ok: true, version: adapterVersion, resolver, sources: ['kw', 'kg', 'wy', 'tx', 'mg'], platformFallback, fastPlatformFallback, maxPlatformAttempts, resolveCacheTtlMs, resolveCacheEntries: resolutionCache.size, lastResolution })
}

async function search(res, url) {
  const query = String(url.searchParams.get('q') || '').trim()
  if (!query) return json(res, 400, { error: 'q is required' })
  const source = String(url.searchParams.get('source') || '').trim().toLowerCase() || null
  const offset = Math.max(0, Number(url.searchParams.get('offset') || 0))
  const limit = Math.max(1, Math.min(positive(url.searchParams.get('limit'), 20), 50))
  return json(res, 200, await searchCatalogs(query, source, offset, limit))
}

async function playlistSearch(res, url) {
  const query = String(url.searchParams.get('q') || '').trim()
  if (!query) return json(res, 400, { error: 'q is required' })
  const source = String(url.searchParams.get('source') || '').trim().toLowerCase() || null
  const offset = Math.max(0, Number(url.searchParams.get('offset') || 0))
  const limit = Math.max(1, Math.min(positive(url.searchParams.get('limit'), 20), 50))
  return json(res, 200, await searchPlaylists(query, source, offset, limit))
}

async function playlistDetail(res, url) {
  const source = String(url.searchParams.get('source') || '').trim().toLowerCase()
  const id = String(url.searchParams.get('id') || '').trim()
  if (!source || !id) return json(res, 400, { error: 'source and id are required' })
  return json(res, 200, await getPlaylistDetail(source, id))
}

async function chartList(res, url) {
  const source = String(url.searchParams.get('source') || '').trim().toLowerCase() || null
  return json(res, 200, { items: await listCharts(source) })
}

async function chartDetail(res, url) {
  const source = String(url.searchParams.get('source') || '').trim().toLowerCase()
  const id = String(url.searchParams.get('id') || '').trim()
  const limit = positive(url.searchParams.get('limit'), 100)
  if (!source || !id) return json(res, 400, { error: 'source and id are required' })
  return json(res, 200, await getChartDetail(source, id, limit))
}

async function resolve(res, url) {
  if (!resolverUrl) return json(res, 501, { error: 'RESOLVER_URL is not configured' })
  const encoded = decodeURIComponent(url.pathname.slice('/resolve/'.length))
  const decoded = decodeCatalogId(encoded)
  const quality = url.searchParams.get('quality') || '128k'
  const refresh = url.searchParams.get('refresh') === 'true'
  const cacheKey = `${encoded}\n${quality}`
  if (refresh) resolutionCache.delete(cacheKey)
  const cached = resolutionCache.get(cacheKey)
  if (!refresh && cached?.expiresAt > Date.now()) return json(res, 200, { ...cached.value, cached: true })
  if (cached) resolutionCache.delete(cacheKey)

  const attempts = []
  let alternateSources = []
  let lastResult = null
  const original = { source: decoded.source, musicInfo: decoded.musicInfo, original: true }
  const alternateOrder = FALLBACK_SOURCE_ORDER.filter(source => source !== decoded.source)
  const steps = []
  // A source script can serialize simultaneous requests internally. Instead of
  // racing two calls through one script runtime, fast mode tries the healthy WY
  // equivalent first for non-WY tracks, then falls back to the requested source.
  if (platformFallback && fastPlatformFallback && decoded.musicInfo?.name && decoded.source !== 'wy') {
    steps.push({ type: 'alternate', source: 'wy' })
  }
  steps.push({ type: 'original', source: decoded.source })
  if (platformFallback && decoded.musicInfo?.name) {
    for (const source of alternateOrder) {
      if (!steps.some(step => step.source === source)) steps.push({ type: 'alternate', source })
    }
  }

  for (const step of steps.slice(0, maxPlatformAttempts)) {
    const outcome = step.type === 'original'
      ? { candidate: original, result: await requestResolver(original, quality, refresh), sources: [] }
      : await resolveAlternate(decoded, step.source, quality, refresh)
    alternateSources.push(...outcome.sources)
    lastResult = outcome.result
    if (lastResult.ok && outcome.candidate?.musicInfo) return resolved(res, decoded, outcome.candidate, lastResult, attempts, cacheKey)
    recordFailure(attempts, step.source, lastResult, decoded)
    if ([401, 403].includes(lastResult.status)) break
  }

  lastResolution = {
    ok: false,
    at: new Date().toISOString(),
    track: String(decoded.musicInfo?.name || decoded.musicInfo?.songmid || 'unknown'),
    requestedSource: decoded.source,
    attempts,
    catalogSources: alternateSources,
  }
  const status = lastResult?.status >= 400 && lastResult?.status < 600 ? lastResult.status : 502
  return json(res, status, {
    error: 'All matched platform sources failed',
    attempts,
    catalogSources: alternateSources,
  })
}

async function lyric(res, url) {
  const encoded = decodeURIComponent(url.pathname.slice('/lyric/'.length))
  const decoded = decodeCatalogId(encoded)
  const attempts = []
  const steps = [{ source: decoded.source, musicInfo: decoded.musicInfo, original: true }]
  if (platformFallback && decoded.musicInfo?.name) {
    for (const source of FALLBACK_SOURCE_ORDER) {
      if (source !== decoded.source) steps.push({ source, original: false })
    }
  }

  for (const step of steps.slice(0, maxPlatformAttempts)) {
    let candidate = step
    if (!step.original) {
      try {
        const found = await findAlternateCatalogTrackForSource(decoded.musicInfo, decoded.source, step.source)
        if (!found.item) {
          attempts.push({ source: step.source, ok: false, error: 'No duration-compatible catalog match' })
          continue
        }
        const alternate = decodeCatalogId(found.item.id)
        candidate = { source: alternate.source, musicInfo: alternate.musicInfo, original: false }
      } catch (error) {
        attempts.push({ source: step.source, ok: false, error: error.message })
        continue
      }
    }
    let directError
    const direct = await fetchCatalogLyrics(candidate.source, candidate.musicInfo).catch(error => {
      directError = error.message
      return null
    })
    const result = !direct && resolverUrl ? await requestResolverEndpoint('/lyric', candidate, '') : null
    const value = direct || (result?.ok ? parseJson(result.body) : null)
    if (typeof value?.lyric === 'string' && value.lyric.trim()) {
      return json(res, 200, {
        ...value,
        resolvedSource: candidate.source,
        fallbackFrom: candidate.original ? null : decoded.source,
        platformAttempts: [...attempts, { source: candidate.source, ok: true, via: direct ? 'catalog' : 'script' }],
      })
    }
    attempts.push({ source: candidate.source, ok: false, error: result?.error || directError || 'No lyrics returned' })
  }
  return json(res, 404, { error: 'No lyrics found', attempts })
}

async function resolveAlternate(decoded, source, quality, refresh = false) {
  try {
    const found = await findAlternateCatalogTrackForSource(decoded.musicInfo, decoded.source, source)
    if (!found.item) return { candidate: { source, original: false }, result: { ok: false, status: 404, error: 'No duration-compatible catalog match' }, sources: found.sources }
    const candidate = decodeCatalogId(found.item.id)
    const normalized = { source: candidate.source, musicInfo: candidate.musicInfo, original: false }
    return { candidate: normalized, result: await requestResolver(normalized, quality, refresh), sources: found.sources }
  } catch (error) {
    return { candidate: { source, original: false }, result: { ok: false, status: 502, error: error.message }, sources: [{ key: source, ok: false, error: error.message }] }
  }
}

function recordFailure(attempts, source, result, decoded) {
  const failure = { source: source || 'unknown', ok: false, status: result?.status || 502, error: result?.error || 'Unknown resolver failure' }
  attempts.push(failure)
  console.warn(`[LX platform fallback] ${String(decoded.musicInfo?.name || 'unknown')} ${failure.source} failed: ${failure.error}`)
}

function resolved(res, requested, candidate, result, failedAttempts, cacheKey) {
  const value = parseJson(result.body) || { url: result.body }
  const platformAttempts = [...failedAttempts, { source: candidate.source, ok: true }]
  const output = {
    ...value,
    resolvedSource: candidate.source,
    fallbackFrom: candidate.original ? null : requested.source,
    platformAttempts,
  }
  lastResolution = {
    ok: true,
    at: new Date().toISOString(),
    track: String(requested.musicInfo?.name || requested.musicInfo?.songmid || 'unknown'),
    requestedSource: requested.source,
    resolvedSource: candidate.source,
    attempts: platformAttempts,
  }
  if (!candidate.original) console.log(`[LX platform fallback] ${lastResolution.track}: ${requested.source} -> ${candidate.source}`)
  resolutionCache.set(cacheKey, { value: output, expiresAt: Date.now() + resolveCacheTtlMs })
  return json(res, 200, output)
}

async function requestResolver(candidate, quality, refresh = false) {
  return requestResolverEndpoint('/resolve', candidate, quality, refresh)
}

async function requestResolverEndpoint(path, candidate, quality, refresh = false) {
  try {
    const response = await fetch(`${resolverUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(resolverToken ? { authorization: `Bearer ${resolverToken}` } : {}),
      },
      body: JSON.stringify({ source: candidate.source, musicInfo: candidate.musicInfo, ...(quality ? { quality } : {}), ...(refresh ? { refresh: true } : {}) }),
      signal: AbortSignal.timeout(Math.min(resolverTimeoutMs, resolverAttemptTimeoutMs)),
    })
    const body = await response.text()
    return {
      ok: response.ok,
      status: response.status,
      body,
      error: response.ok ? null : parseJson(body)?.error || `Resolver returned HTTP ${response.status}`,
    }
  } catch (error) {
    return { ok: false, status: 502, body: '', error: error.message }
  }
}

function parseJson(value) {
  try { return JSON.parse(value) } catch { return null }
}

function positive(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback
}

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' })
  res.end(body)
}
