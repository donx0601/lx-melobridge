import { readFile } from 'node:fs/promises'

const numberEnv = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`)
  return value
}

export const config = {
  port: numberEnv('PORT', 4780),
  gatewayUser: process.env.GATEWAY_USER || 'test',
  gatewayPassword: process.env.GATEWAY_PASSWORD || 'change-me',
  navidromeUrl: (process.env.NAVIDROME_URL || '').replace(/\/$/, ''),
  navidromeUser: process.env.NAVIDROME_USER || process.env.GATEWAY_USER || 'test',
  navidromePassword: process.env.NAVIDROME_PASSWORD || process.env.GATEWAY_PASSWORD || 'change-me',
  providersFile: process.env.PROVIDERS_FILE || '/config/providers.json',
  dataDir: process.env.DATA_DIR || '/data',
  sourceLabelMode: process.env.SOURCE_LABEL_MODE || 'prefix',
  showQualityLabel: process.env.SHOW_QUALITY_LABEL !== 'false',
  onlinePlaybackQuality: process.env.ONLINE_PLAYBACK_QUALITY || '320k',
  allowPrivateStreams: process.env.ALLOW_PRIVATE_STREAMS === 'true',
  maxSearchItemsPerProvider: numberEnv('MAX_SEARCH_ITEMS_PER_PROVIDER', 30),
  resolveCacheTtlMs: numberEnv('RESOLVE_CACHE_TTL_MS', 900000),
  prefetchNextTracks: Math.min(5, Math.round(numberEnv('PREFETCH_NEXT_TRACKS', 3))),
  prefetchConcurrency: Math.min(3, Math.round(numberEnv('PREFETCH_CONCURRENCY', 2))),
  playbackContextTtlMs: numberEnv('PLAYBACK_CONTEXT_TTL_MS', 3600000),
}

if (!['prefix', 'album', 'none'].includes(config.sourceLabelMode)) {
  throw new Error('SOURCE_LABEL_MODE must be prefix, album, or none')
}
if (!['128k', '320k', 'flac', 'flac24bit', 'source'].includes(config.onlinePlaybackQuality)) {
  throw new Error('ONLINE_PLAYBACK_QUALITY must be 128k, 320k, flac, flac24bit, or source')
}

export async function loadProviders() {
  let parsed
  try {
    parsed = JSON.parse(await readFile(config.providersFile, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.warn(`Providers file not found: ${config.providersFile}; online search disabled`)
      return []
    }
    throw new Error(`Cannot read providers file: ${error.message}`)
  }
  if (!Array.isArray(parsed)) throw new Error('providers.json must contain an array')

  const keys = new Set()
  return parsed.map((raw, index) => {
    const key = String(raw.key || '')
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(key)) throw new Error(`Invalid provider key at index ${index}`)
    if (keys.has(key)) throw new Error(`Duplicate provider key: ${key}`)
    keys.add(key)
    const baseUrl = new URL(raw.baseUrl)
    if (!['http:', 'https:'].includes(baseUrl.protocol)) throw new Error(`Unsupported provider URL: ${baseUrl}`)
    const headers = Object.fromEntries(Object.entries(raw.headers || {}).map(([name, value]) => [name, String(value)]))
    return {
      key,
      label: String(raw.label || key),
      enabled: raw.enabled !== false,
      baseUrl: baseUrl.toString().replace(/\/$/, ''),
      searchPath: String(raw.searchPath || '/search'),
      resolvePath: String(raw.resolvePath || '/resolve/{id}'),
      lyricPath: String(raw.lyricPath || '/lyric/{id}'),
      playlistSearchPath: String(raw.playlistSearchPath || '/playlist/search'),
      playlistDetailPath: String(raw.playlistDetailPath || '/playlist/detail'),
      chartListPath: String(raw.chartListPath || '/chart/list'),
      chartDetailPath: String(raw.chartDetailPath || '/chart/detail'),
      timeoutMs: Math.max(1000, Math.min(Number(raw.timeoutMs || 10000), 60000)),
      headers,
    }
  })
}
