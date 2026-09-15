import { remoteAlbumId, remoteArtistId, remoteCoverId, remotePlaylistCoverId, remotePlaylistId, remoteSongId } from './codec.mjs'
import { fetchJson } from './network.mjs'

const cleanText = (value, fallback = '') => String(value ?? fallback).trim()
const finiteNumber = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback
const SOURCE_LABELS = Object.freeze({
  kw: '酷我',
  kg: '酷狗',
  wy: '网易云',
  tx: 'QQ音乐',
  mg: '咪咕',
})
const QUALITY_LABELS = Object.freeze({
  '320k': 'HQ',
  flac: 'SQ',
  flac24bit: '24bit',
  '24bit': '24bit',
  hires: 'Hi-Res',
  master: 'Master',
  atmos: 'Atmos',
  atmos_plus: 'Atmos',
})
const QUALITY_ORDER = ['128k', '320k', 'flac', 'flac24bit']
const SOURCE_CODES_BY_LABEL = Object.freeze(Object.fromEntries(
  Object.entries(SOURCE_LABELS).map(([code, label]) => [label.toLowerCase(), code]),
))

const optionalPositive = value => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : undefined
}

const normalizeBitRate = raw => {
  const value = optionalPositive(raw.bitRate ?? raw.bitrate)
  if (value == null) return 0
  return value > 10000 ? Math.round(value / 1000) : value
}

export class ProviderRegistry {
  constructor(configs, labelMode, showQualityLabel = true, onlinePlaybackQuality = '320k', options = {}) {
    this.providers = new Map(configs.filter(provider => provider.enabled).map(provider => [provider.key, provider]))
    this.labelMode = labelMode
    this.showQualityLabel = showQualityLabel
    this.onlinePlaybackQuality = onlinePlaybackQuality
    this.lyricCache = new Map()
    this.resolveCache = new Map()
    this.pendingResolutions = new Map()
    this.prefetchQueue = []
    this.queuedPrefetchIds = new Set()
    this.activePrefetches = 0
    this.resolveCacheTtlMs = Math.max(1000, Number(options.resolveCacheTtlMs || 900000))
    this.prefetchConcurrency = Math.max(1, Math.min(3, Number(options.prefetchConcurrency || 2)))
    this.prefetchStats = { completed: 0, failed: 0, lastCompletedAt: null, lastError: null }
    this.chartCache = { expiresAt: 0, items: [] }
    this.status = new Map(configs.map(provider => [provider.key, {
      key: provider.key,
      label: provider.label,
      enabled: provider.enabled,
      ok: null,
      lastError: null,
    }]))
  }

  listStatus() {
    return [...this.status.values()]
  }

  resolutionStatus() {
    this.pruneResolveCache()
    return {
      cacheTtlMs: this.resolveCacheTtlMs,
      cacheEntries: this.resolveCache.size,
      queued: this.prefetchQueue.length,
      active: this.activePrefetches,
      completed: this.prefetchStats.completed,
      failed: this.prefetchStats.failed,
      lastCompletedAt: this.prefetchStats.lastCompletedAt,
      lastError: this.prefetchStats.lastError,
    }
  }

  get(key) {
    return this.providers.get(key)
  }

  async searchAll(query, offset, limit, selection = {}) {
    const selectedProviders = [...this.providers.values()].filter(provider => !selection.provider || provider.key === selection.provider)
    const tasks = selectedProviders.map(provider => this.searchOne(provider, query, offset, limit, selection.source))
    const results = await Promise.all(tasks)
    return results.flat()
  }

  async searchOne(provider, query, offset, limit, sourceFilter = null) {
    const status = this.status.get(provider.key)
    try {
      const url = new URL(provider.searchPath, `${provider.baseUrl}/`)
      url.searchParams.set('q', query)
      url.searchParams.set('offset', String(offset))
      url.searchParams.set('limit', String(limit))
      if (sourceFilter) url.searchParams.set('source', sourceFilter)
      const body = await fetchJson(url, { headers: provider.headers, timeoutMs: provider.timeoutMs })
      if (!Array.isArray(body.items)) throw new Error('Search response must contain an items array')
      const tracks = body.items
        .map(raw => this.toTrack(provider, raw))
        .filter(track => track && (!sourceFilter || !track.sourceCode || track.sourceCode === sourceFilter))
        .slice(0, limit)
      status.ok = true
      status.lastError = null
      status.lastSuccessAt = new Date().toISOString()
      return tracks
    } catch (error) {
      status.ok = false
      status.lastError = error.message
      status.lastFailureAt = new Date().toISOString()
      console.warn(`Provider ${provider.key} search failed: ${error.message}`)
      return []
    }
  }

  async searchPlaylists(query, source = null, offset = 0, limit = 20) {
    const tasks = [...this.providers.values()].map(async provider => {
      try {
        const url = new URL(provider.playlistSearchPath, `${provider.baseUrl}/`)
        url.searchParams.set('q', query)
        url.searchParams.set('offset', String(offset))
        url.searchParams.set('limit', String(limit))
        if (source) url.searchParams.set('source', source)
        const body = await fetchJson(url, { headers: provider.headers, timeoutMs: provider.timeoutMs })
        return Array.isArray(body.items) ? body.items.map(raw => this.toPlaylist(provider, raw)).filter(Boolean) : []
      } catch (error) {
        console.warn(`Provider ${provider.key} playlist search failed: ${error.message}`)
        return []
      }
    })
    return (await Promise.all(tasks)).flat()
  }

  async listCharts(source = null) {
    if (this.chartCache.expiresAt > Date.now()) {
      return source ? this.chartCache.items.filter(item => item.sourceCode === source) : this.chartCache.items
    }
    const tasks = [...this.providers.values()].map(async provider => {
      try {
        const url = new URL(provider.chartListPath, `${provider.baseUrl}/`)
        const body = await fetchJson(url, { headers: provider.headers, timeoutMs: provider.timeoutMs })
        return Array.isArray(body.items)
          ? body.items.map(raw => this.toPlaylist(provider, { ...raw, id: `chart:${raw.id}` })).filter(Boolean)
          : []
      } catch (error) {
        console.warn(`Provider ${provider.key} chart list failed: ${error.message}`)
        return []
      }
    })
    const items = (await Promise.all(tasks)).flat()
    const ttl = items.some(item => !item.coverUrl) ? 60 * 1000 : 6 * 60 * 60 * 1000
    this.chartCache = { expiresAt: Date.now() + ttl, items }
    return source ? items.filter(item => item.sourceCode === source) : items
  }

  cachedChart(id) {
    return this.chartCache.items.find(item => item.id === id) || null
  }

  toPlaylist(provider, raw) {
    const itemId = cleanText(raw.id)
    const name = cleanText(raw.title || raw.name)
    const sourceCode = cleanText(raw.source || raw.platform).toLowerCase()
    if (!itemId || !name || !SOURCE_LABELS[sourceCode]) return null
    const id = remotePlaylistId(provider.key, sourceCode, itemId)
    return {
      id,
      providerKey: provider.key,
      providerItemId: itemId,
      sourceCode,
      sourceLabel: SOURCE_LABELS[sourceCode],
      name: `【${SOURCE_LABELS[sourceCode]}】${name}`,
      rawName: name,
      comment: cleanText(raw.description),
      owner: cleanText(raw.creator),
      public: true,
      readonly: true,
      songCount: Math.max(0, Math.round(finiteNumber(raw.trackCount))),
      duration: 0,
      coverUrl: cleanText(raw.coverUrl),
      coverArt: raw.coverUrl ? remotePlaylistCoverId(id) : undefined,
      created: new Date().toISOString(),
      changed: new Date().toISOString(),
    }
  }

  async fetchPlaylist(remote) {
    const provider = this.get(remote.providerKey)
    if (!provider) throw new Error(`Provider is unavailable: ${remote.providerKey}`)
    const isChart = remote.itemId.startsWith('chart:')
    const itemId = isChart ? remote.itemId.slice('chart:'.length) : remote.itemId
    const url = new URL(isChart ? provider.chartDetailPath : provider.playlistDetailPath, `${provider.baseUrl}/`)
    url.searchParams.set('source', remote.source)
    url.searchParams.set('id', itemId)
    if (isChart) url.searchParams.set('limit', '100')
    const body = await fetchJson(url, { headers: provider.headers, timeoutMs: Math.max(provider.timeoutMs, 30000) })
    if (!Array.isArray(body.items)) throw new Error('Playlist detail omitted items')
    const metadata = body.playlist || { id: itemId, source: remote.source, title: itemId }
    const base = this.toPlaylist(provider, { ...metadata, id: remote.itemId })
    if (isChart) {
      const index = this.chartCache.items.findIndex(item => item.id === base.id)
      if (index >= 0) this.chartCache.items[index] = { ...this.chartCache.items[index], ...base }
    }
    const entry = body.items.map(raw => this.toTrack(provider, raw)).filter(Boolean)
    return {
      ...base,
      songCount: entry.length,
      duration: entry.reduce((sum, track) => sum + track.duration, 0),
      changed: new Date().toISOString(),
      entry,
    }
  }

  toTrack(provider, raw) {
    const itemId = cleanText(raw.id)
    const rawTitle = cleanText(raw.title || raw.name)
    if (!itemId || !rawTitle) return null
    const id = remoteSongId(provider.key, itemId)
    const sourceValue = cleanText(raw.source || raw.platform)
    const sourceCode = SOURCE_LABELS[sourceValue]
      ? sourceValue
      : SOURCE_CODES_BY_LABEL[sourceValue.toLowerCase()] || ''
    const sourceLabel = cleanText(raw.sourceLabel, SOURCE_LABELS[sourceCode] || sourceCode || provider.label).slice(0, 40)
    const originalAlbum = cleanText(raw.album)
    const sourceQuality = cleanText(raw.quality, `${normalizeBitRate(raw) || 128}k`).toLowerCase()
    const sourceQualityIndex = Math.max(0, QUALITY_ORDER.indexOf(sourceQuality))
    const configuredQualityIndex = QUALITY_ORDER.indexOf(this.onlinePlaybackQuality)
    const quality = this.onlinePlaybackQuality === 'source'
      ? sourceQuality
      : QUALITY_ORDER[Math.min(sourceQualityIndex, Math.max(0, configuredQualityIndex))]
    const sourceMatchesPlayback = sourceQuality === quality
    const qualityLabel = cleanText(sourceMatchesPlayback ? raw.qualityLabel : null, QUALITY_LABELS[quality.toLowerCase()] || '').slice(0, 20)
    const visibleLabel = this.showQualityLabel && qualityLabel ? `${sourceLabel}·${qualityLabel}` : sourceLabel
    const title = this.labelMode === 'prefix' ? `【${visibleLabel}】${rawTitle}` : rawTitle
    const artist = cleanText(raw.artist, '未知歌手')
    const albumName = originalAlbum || '在线音乐'
    const album = this.labelMode === 'album' ? `【${sourceLabel}】${albumName}` : albumName
    const lossless = quality === 'flac' || quality === 'flac24bit'
    const suffix = this.onlinePlaybackQuality === 'source' ? cleanText(raw.suffix, lossless ? 'flac' : 'mp3').replace(/^\./, '') : (lossless ? 'flac' : 'mp3')
    const bitDepth = lossless ? optionalPositive(raw.bitDepth) || (quality === 'flac24bit' ? 24 : 16) : undefined
    return {
      id,
      providerKey: provider.key,
      providerItemId: itemId,
      sourceCode,
      sourceLabel,
      rawTitle,
      title,
      album,
      albumId: remoteAlbumId(provider.key, sourceCode, album, artist),
      artist,
      artistId: remoteArtistId(provider.key, sourceCode, artist),
      isDir: false,
      coverArt: raw.coverUrl ? remoteCoverId(id) : undefined,
      coverUrl: raw.coverUrl ? cleanText(raw.coverUrl) : undefined,
      duration: Math.max(0, Math.round(finiteNumber(raw.duration))),
      bitRate: quality === '128k' ? 128 : quality === '320k' ? 320 : normalizeBitRate(raw) || 1000,
      bitDepth,
      samplingRate: sourceMatchesPlayback ? optionalPositive(raw.samplingRate) : undefined,
      channelCount: sourceMatchesPlayback ? optionalPositive(raw.channelCount) : undefined,
      size: sourceMatchesPlayback ? optionalPositive(raw.size) : undefined,
      contentType: this.onlinePlaybackQuality === 'source' ? cleanText(raw.contentType, suffix === 'flac' ? 'audio/flac' : 'audio/mpeg') : (lossless ? 'audio/flac' : 'audio/mpeg'),
      suffix,
      quality,
      qualityLabel,
      path: `online/${provider.key}/${itemId}.${suffix}`,
      type: 'music',
      mediaType: 'song',
      isVideo: false,
      created: new Date().toISOString(),
    }
  }

  async resolve(track, { refresh = false } = {}) {
    const provider = this.get(track.providerKey)
    if (!provider) throw new Error(`Provider is unavailable: ${track.providerKey}`)
    const cacheKey = `${track.id}\n${track.quality || ''}`
    if (refresh) this.resolveCache.delete(cacheKey)
    const cached = this.resolveCache.get(cacheKey)
    if (!refresh && cached?.expiresAt > Date.now()) return { ...cached.value, cached: true }
    if (cached) this.resolveCache.delete(cacheKey)
    if (this.pendingResolutions.has(cacheKey)) return this.pendingResolutions.get(cacheKey)

    const pending = this.resolveOne(provider, track, refresh).then(value => {
      this.resolveCache.set(cacheKey, { value, expiresAt: Date.now() + this.resolveCacheTtlMs })
      return value
    }).finally(() => this.pendingResolutions.delete(cacheKey))
    this.pendingResolutions.set(cacheKey, pending)
    return pending
  }

  async resolveOne(provider, track, refresh) {
    const status = this.status.get(provider.key)
    try {
      const encodedId = encodeURIComponent(track.providerItemId)
      const path = provider.resolvePath.includes('{id}')
        ? provider.resolvePath.replaceAll('{id}', encodedId)
        : provider.resolvePath
      const url = new URL(path, `${provider.baseUrl}/`)
      if (!provider.resolvePath.includes('{id}')) url.searchParams.set('id', track.providerItemId)
      if (track.quality) url.searchParams.set('quality', track.quality)
      if (refresh) url.searchParams.set('refresh', 'true')
      const body = await fetchJson(url, { headers: provider.headers, timeoutMs: provider.timeoutMs })
      if (!body.url) throw new Error('Resolve response omitted url')
      status.ok = true
      status.lastError = null
      status.lastSuccessAt = new Date().toISOString()
      return {
        url: String(body.url),
        headers: Object.fromEntries(Object.entries(body.headers || {}).map(([name, value]) => [name, String(value)])),
        resolvedSource: body.resolvedSource ? String(body.resolvedSource) : track.sourceCode,
        fallbackFrom: body.fallbackFrom ? String(body.fallbackFrom) : null,
      }
    } catch (error) {
      status.ok = false
      status.lastError = error.message
      status.lastFailureAt = new Date().toISOString()
      throw error
    }
  }

  prefetch(tracks) {
    this.pruneResolveCache()
    for (const track of tracks) {
      if (!track?.id || !this.providers.has(track.providerKey)) continue
      const cacheKey = `${track.id}\n${track.quality || ''}`
      if (this.resolveCache.get(cacheKey)?.expiresAt > Date.now()) continue
      if (this.pendingResolutions.has(cacheKey) || this.queuedPrefetchIds.has(track.id)) continue
      this.prefetchQueue.push(track)
      this.queuedPrefetchIds.add(track.id)
    }
    this.drainPrefetchQueue()
  }

  drainPrefetchQueue() {
    while (this.activePrefetches < this.prefetchConcurrency && this.prefetchQueue.length) {
      const track = this.prefetchQueue.shift()
      this.queuedPrefetchIds.delete(track.id)
      this.activePrefetches++
      void this.resolve(track).then(() => {
        this.prefetchStats.completed++
        this.prefetchStats.lastCompletedAt = new Date().toISOString()
        this.prefetchStats.lastError = null
        console.log(`[Online prefetch ready] title="${track.rawTitle}" artist="${track.artist}"`)
      }).catch(error => {
        this.prefetchStats.failed++
        this.prefetchStats.lastError = error.message
        console.warn(`[Online prefetch failed] title="${track.rawTitle}" artist="${track.artist}": ${error.message}`)
      }).finally(() => {
        this.activePrefetches--
        this.drainPrefetchQueue()
      })
    }
  }

  pruneResolveCache() {
    const now = Date.now()
    for (const [key, value] of this.resolveCache.entries()) {
      if (value.expiresAt <= now) this.resolveCache.delete(key)
    }
  }

  async lyrics(track) {
    const cached = this.lyricCache.get(track.id)
    if (cached?.expiresAt > Date.now()) return cached.value
    if (cached) this.lyricCache.delete(track.id)
    const provider = this.get(track.providerKey)
    if (!provider) throw new Error(`Provider is unavailable: ${track.providerKey}`)
    const encodedId = encodeURIComponent(track.providerItemId)
    const path = provider.lyricPath.includes('{id}')
      ? provider.lyricPath.replaceAll('{id}', encodedId)
      : provider.lyricPath
    const url = new URL(path, `${provider.baseUrl}/`)
    if (!provider.lyricPath.includes('{id}')) url.searchParams.set('id', track.providerItemId)
    const body = await fetchJson(url, { headers: provider.headers, timeoutMs: provider.timeoutMs })
    const value = Object.fromEntries(['lyric', 'tlyric', 'rlyric', 'lxlyric']
      .filter(key => typeof body[key] === 'string' && body[key].trim())
      .map(key => [key, body[key]]))
    if (!value.lyric) throw new Error('Provider returned no lyrics')
    this.lyricCache.set(track.id, { value, expiresAt: Date.now() + 3600000 })
    return value
  }
}

export function subsonicTrack(track) {
  const hidden = new Set(['providerKey', 'providerItemId', 'sourceCode', 'sourceLabel', 'rawTitle', 'coverUrl', 'quality', 'qualityLabel'])
  return Object.fromEntries(Object.entries(track).filter(([key, value]) => !hidden.has(key) && value != null))
}

export function subsonicPlaylist(playlist, includeEntries = false) {
  const hidden = new Set(['providerKey', 'providerItemId', 'sourceCode', 'sourceLabel', 'rawName', 'coverUrl'])
  return Object.fromEntries(Object.entries(playlist).filter(([key, value]) =>
    !hidden.has(key) && value != null && (includeEntries || key !== 'entry')))
}
