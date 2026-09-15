import { createCipheriv, createHash } from 'node:crypto'

export const PLATFORM_LABELS = Object.freeze({
  kw: '酷我',
  kg: '酷狗',
  wy: '网易云',
  tx: 'QQ音乐',
  mg: '咪咕',
})
const QUALITY_ORDER = ['128k', '320k', 'flac', 'flac24bit']

const asArray = value => Array.isArray(value) ? value : value == null ? [] : [value]
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback
const text = value => String(value ?? '').replace(/<[^>]*>/g, '').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'").trim()
const names = (items, ...keys) => asArray(items).map(item => {
  if (typeof item === 'string') return text(item)
  for (const key of keys) if (item?.[key]) return text(item[key])
  return ''
}).filter(Boolean).join('、')

const highestQuality = qualities => QUALITY_ORDER.findLast(value => qualities.includes(value)) || '128k'
const interval = value => {
  const seconds = Math.max(0, Math.round(number(value)))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const tail = String(seconds % 60).padStart(2, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${tail}` : `${minutes}:${tail}`
}
const qualityFields = (qualities, sizes = {}) => {
  const quality = highestQuality(qualities)
  return {
    quality,
    suffix: quality.startsWith('flac') ? 'flac' : 'mp3',
    contentType: quality.startsWith('flac') ? 'audio/flac' : 'audio/mpeg',
    bitRate: quality === '128k' ? 128 : quality === '320k' ? 320 : quality === 'flac24bit' ? 2000 : 1000,
    bitDepth: quality === 'flac24bit' ? 24 : quality === 'flac' ? 16 : undefined,
    size: number(sizes[quality]) || undefined,
  }
}

export const encodeCatalogId = value => Buffer.from(JSON.stringify(value)).toString('base64url')
export const decodeCatalogId = value => JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'))

export const makeCatalogTrack = (source, musicInfo, metadata) => {
  const qualities = metadata.qualities?.length ? metadata.qualities : ['128k']
  const duration = Math.max(0, Math.round(number(metadata.duration)))
  const normalizedMusicInfo = {
    ...musicInfo,
    source,
    name: text(musicInfo?.name || metadata.title),
    singer: text(musicInfo?.singer || metadata.artist),
    albumName: text(musicInfo?.albumName || metadata.album),
    interval: text(musicInfo?.interval) || interval(duration),
    img: musicInfo?.img ?? metadata.coverUrl ?? null,
    lrc: musicInfo?.lrc ?? null,
    otherSource: musicInfo?.otherSource ?? null,
    _types: musicInfo?._types || {},
    typeUrl: musicInfo?.typeUrl || {},
  }
  return {
    id: encodeCatalogId({ v: 1, source, musicInfo: normalizedMusicInfo }),
    title: text(metadata.title),
    artist: text(metadata.artist) || '未知歌手',
    album: text(metadata.album),
    duration,
    coverUrl: metadata.coverUrl || undefined,
    source,
    sourceLabel: PLATFORM_LABELS[source],
    ...qualityFields(qualities, metadata.sizes),
  }
}
const track = makeCatalogTrack

export async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: 'application/json, text/plain, */*',
      'user-agent': 'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 lx-melobridge/0.4',
      ...options.headers,
    },
    signal: AbortSignal.timeout(options.timeoutMs || 12000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const raw = await response.text()
  try { return JSON.parse(raw) } catch { throw new Error('Upstream returned non-JSON data') }
}

function kuwoQualities(info) {
  const qualities = []
  const sizes = {}
  for (const part of String(info.N_MINFO || '').split(';')) {
    const match = part.match(/level:(\w+),bitrate:(\d+),format:(\w+),size:([\w.]+)/)
    if (!match) continue
    const quality = match[2] === '4000' ? 'flac24bit' : match[2] === '2000' ? 'flac' : match[2] === '320' ? '320k' : match[2] === '128' ? '128k' : null
    if (quality) {
      qualities.push(quality)
      sizes[quality] = match[4]
    }
  }
  return { qualities, sizes }
}

async function searchKuwo(query, offset, limit) {
  const page = Math.floor(offset / limit)
  const url = new URL('https://search.kuwo.cn/r.s')
  Object.entries({ client: 'kt', all: query, pn: page, rn: limit, uid: '794762570', ver: 'kwplayer_ar_9.2.2.1', vipver: '1', show_copyright_off: '1', newver: '1', ft: 'music', cluster: '0', strategy: '2012', encoding: 'utf8', rformat: 'json', vermerge: '1', mobi: '1', issubtitle: '1' }).forEach(([key, value]) => url.searchParams.set(key, value))
  const body = await fetchJson(url)
  const items = asArray(body.abslist).map(info => {
    const songmid = text(info.MUSICRID).replace(/^MUSIC_/, '')
    if (!songmid) return null
    const extra = kuwoQualities(info)
    const musicInfo = { source: 'kw', songmid, albumId: text(info.ALBUMID), name: text(info.SONGNAME), singer: text(info.ARTIST), albumName: text(info.ALBUM), types: extra.qualities.map(type => ({ type })) }
    return track('kw', musicInfo, { title: info.SONGNAME, artist: info.ARTIST, album: info.ALBUM, duration: info.DURATION, ...extra })
  }).filter(Boolean)
  return { items, total: number(body.TOTAL, items.length) }
}

function kugouQualityData(info) {
  const pairs = [
    ['128k', info.FileSize, info.FileHash],
    ['320k', info.HQFileSize, info.HQFileHash],
    ['flac', info.SQFileSize, info.SQFileHash],
    ['flac24bit', info.ResFileSize, info.ResFileHash],
  ]
  const qualities = []
  const sizes = {}
  const types = []
  const typeMap = {}
  for (const [type, rawSize, hash] of pairs) {
    const size = number(rawSize)
    if (!size || !hash) continue
    qualities.push(type)
    sizes[type] = size
    types.push({ type, size, hash })
    typeMap[type] = { size, hash }
  }
  return { qualities, sizes, types, typeMap }
}

function mapKugou(info) {
  const extra = kugouQualityData(info)
  const hash = text(info.FileHash)
  if (!hash) return null
  const artist = names(info.Singers, 'name', 'Name') || text(info.SingerName)
  const musicInfo = { source: 'kg', songmid: info.Audioid, hash, albumId: info.AlbumID, name: text(info.SongName), singer: artist, albumName: text(info.AlbumName), types: extra.types, _types: extra.typeMap }
  return track('kg', musicInfo, { title: info.SongName, artist, album: info.AlbumName, duration: info.Duration, ...extra })
}

async function searchKugou(query, offset, limit) {
  const page = Math.floor(offset / limit) + 1
  const url = new URL('https://songsearch.kugou.com/song_search_v2')
  Object.entries({ keyword: query, page, pagesize: limit, userid: '0', clientver: '', platform: 'WebFilter', filter: '2', iscorrection: '1', privilege_filter: '0', area_code: '1' }).forEach(([key, value]) => url.searchParams.set(key, value))
  const body = await fetchJson(url)
  const seen = new Set()
  const raw = asArray(body.data?.lists).flatMap(info => [info, ...asArray(info.Grp)])
  const items = raw.map(mapKugou).filter(item => item && !seen.has(item.id) && seen.add(item.id))
  return { items: items.slice(0, limit), total: number(body.data?.total, items.length) }
}

function qqQualityData(file = {}) {
  const pairs = [['128k', file.size_128mp3], ['320k', file.size_320mp3], ['flac', file.size_flac], ['flac24bit', file.size_hires]]
  const qualities = []
  const sizes = {}
  for (const [type, rawSize] of pairs) if (number(rawSize)) { qualities.push(type); sizes[type] = number(rawSize) }
  return { qualities, sizes }
}

async function searchQq(query, offset, limit) {
  const page = Math.floor(offset / limit) + 1
  const url = new URL('https://c.y.qq.com/soso/fcgi-bin/client_search_cp')
  Object.entries({ p: page, n: limit, w: query, format: 'json', new_json: '1' }).forEach(([key, value]) => url.searchParams.set(key, value))
  const body = await fetchJson(url, { headers: { referer: 'https://y.qq.com/' } })
  const items = asArray(body.data?.song?.list).map(info => {
    const songmid = text(info.mid || info.songmid)
    if (!songmid) return null
    const artist = names(info.singer, 'name')
    const album = info.album || {}
    const albumId = text(album.mid || info.albummid)
    const extra = qqQualityData(info.file)
    const coverUrl = albumId ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumId}.jpg` : undefined
    const musicInfo = { source: 'tx', songmid, songId: info.id, albumId, albumMid: albumId, strMediaMid: info.file?.media_mid, name: text(info.title || info.songname), singer: artist, albumName: text(album.name || info.albumname), types: extra.qualities.map(type => ({ type })) }
    return track('tx', musicInfo, { title: info.title || info.songname, artist, album: album.name || info.albumname, duration: info.interval, coverUrl, ...extra })
  }).filter(Boolean)
  return { items, total: number(body.data?.song?.totalnum, items.length) }
}

function neteaseQualityData(info) {
  const pairs = [['128k', info.lMusic || info.l], ['320k', info.hMusic || info.h], ['flac', info.sqMusic || info.sq], ['flac24bit', info.hr]]
  const qualities = []
  const sizes = {}
  for (const [type, value] of pairs) if (value) { qualities.push(type); sizes[type] = number(value.size) }
  return { qualities, sizes }
}

async function searchNetease(query, offset, limit) {
  // LX Desktop moved from the retired web search endpoint to NetEase's EAPI
  // song-list endpoint. The old endpoint now returns HTTP 405 and silently
  // removes NetEase from the cross-platform fallback candidates.
  const apiPath = '/api/search/song/list/page'
  const data = {
    keyword: query,
    needCorrect: '1',
    channel: 'typing',
    offset,
    scene: 'normal',
    total: offset === 0,
    limit,
  }
  const textData = JSON.stringify(data)
  const digest = createHash('md5').update(`nobody${apiPath}use${textData}md5forencrypt`).digest('hex')
  const plaintext = `${apiPath}-36cd479b6b5-${textData}-36cd479b6b5-${digest}`
  const cipher = createCipheriv('aes-128-ecb', Buffer.from('e82ckenh8dichen8'), null)
  const params = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]).toString('hex').toUpperCase()
  const body = await fetchJson('http://interface.music.163.com/eapi/batch', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36',
      origin: 'https://music.163.com',
    },
    body: new URLSearchParams({ params }),
  })
  const items = asArray(body.data?.resources).map(resource => resource?.baseInfo?.simpleSongData).filter(Boolean).map(info => {
    if (!info.id) return null
    const artist = names(info.artists || info.ar, 'name')
    const album = info.album || info.al || {}
    const extra = neteaseQualityData(info)
    const musicInfo = { source: 'wy', songmid: info.id, name: text(info.name), singer: artist, albumName: text(album.name), albumId: album.id, types: extra.qualities.map(type => ({ type })) }
    return track('wy', musicInfo, { title: info.name, artist, album: album.name, duration: number(info.duration || info.dt) / 1000, coverUrl: album.picUrl, ...extra })
  }).filter(Boolean)
  return { items, total: number(body.data?.totalCount, items.length) }
}

function miguQualityData(info) {
  const qualities = []
  const sizes = {}
  for (const format of asArray(info.audioFormats || info.newRateFormats)) {
    const type = format.formatType === 'PQ' ? '128k' : format.formatType === 'HQ' ? '320k' : format.formatType === 'SQ' ? 'flac' : ['ZQ', 'ZQ24'].includes(format.formatType) ? 'flac24bit' : null
    if (!type) continue
    qualities.push(type)
    sizes[type] = number(format.asize ?? format.isize ?? format.size ?? format.androidSize)
  }
  return { qualities, sizes }
}

async function searchMigu(query, offset, limit) {
  const page = Math.floor(offset / limit) + 1
  const time = Date.now().toString()
  const deviceId = '963B7AA0D21511ED807EE5846EC87D20'
  const sign = createHash('md5').update(`${query}6cdc72a439cef99a3418d2a78aa28c73yyapp2d16148780a1dcc7408e06336b98cfd50${deviceId}${time}`).digest('hex')
  const url = new URL('https://jadeite.migu.cn/music_search/v3/search/searchAll')
  Object.entries({ isCorrect: '0', isCopyright: '1', searchSwitch: '{"song":1,"album":0,"singer":0,"tagSong":1,"mvSong":0,"bestShow":1,"songlist":0,"lyricSong":0}', pageSize: limit, text: query, pageNo: page, sort: '0', sid: 'USS' }).forEach(([key, value]) => url.searchParams.set(key, value))
  const body = await fetchJson(url, { headers: { uiVersion: 'A_music_3.6.1', deviceId, timestamp: time, sign, channel: '0146921' } })
  const seen = new Set()
  const items = asArray(body.songResultData?.resultList).flatMap(asArray).map(info => {
    const copyrightId = text(info.copyrightId)
    if (!info.songId || !copyrightId || seen.has(copyrightId)) return null
    seen.add(copyrightId)
    const artist = names(info.singerList || info.singers, 'name', 'singerName')
    const extra = miguQualityData(info)
    let coverUrl = text(info.img3 || info.img2 || info.img1 || asArray(info.imgItems)[0]?.img)
    if (coverUrl && !/^https?:/i.test(coverUrl)) coverUrl = `https://d.musicapp.migu.cn${coverUrl}`
    const musicInfo = { source: 'mg', songmid: info.songId, copyrightId, name: text(info.name), singer: artist, albumName: text(info.album), albumId: info.albumId, types: extra.qualities.map(type => ({ type })) }
    return track('mg', musicInfo, { title: info.name, artist, album: info.album, duration: info.duration, coverUrl, ...extra })
  }).filter(Boolean)
  return { items, total: number(body.songResultData?.totalCount, items.length) }
}

const SEARCHERS = Object.freeze({ kw: searchKuwo, kg: searchKugou, tx: searchQq, wy: searchNetease, mg: searchMigu })
// Keep the public search order stable, but prefer the currently direct and
// healthy NetEase path for playback fallback. Several source scripts route KG
// and TX through a shared third-party host, so waiting for those first can push
// a Subsonic client's stream request past its timeout.
export const FALLBACK_SOURCE_ORDER = Object.freeze(['wy', 'kg', 'tx', 'mg', 'kw'])

const searchSources = async(query, excludedSource, offset, limit, onlySource = null, order = null) => Promise.all(
  (order || Object.keys(SEARCHERS)).map(key => [key, SEARCHERS[key]])
    .filter(([key]) => !onlySource || key === onlySource)
    .filter(([key]) => key !== excludedSource)
    .map(async([key, search]) => {
      try { return { key, ok: true, ...(await search(query, offset, limit)) } }
      catch (error) { return { key, ok: false, items: [], total: 0, error: error.message } }
    }),
)

export async function searchCatalogs(query, source, offset, limit) {
  if (source && !SEARCHERS[source]) throw new Error(`Unknown source: ${source}`)
  const settled = await searchSources(query, null, offset, limit, source)
  const interleaved = []
  const longest = Math.max(0, ...settled.map(result => result.items.length))
  for (let index = 0; index < longest; index++) {
    for (const result of settled) if (result.items[index]) interleaved.push(result.items[index])
  }
  return {
    items: interleaved,
    total: settled.reduce((sum, result) => sum + result.total, 0),
    sources: settled.map(({ key, ok, error }) => ({ key, label: PLATFORM_LABELS[key], ok, error })),
  }
}

// Mirrors LX Music Desktop's findMusic strategy: search every other platform,
// select at most one duration-compatible match from each, then rank exact matches.
export async function findAlternateCatalogTracks(musicInfo, originalSource, limit = 25) {
  const name = text(musicInfo?.name)
  const singer = text(musicInfo?.singer)
  const albumName = text(musicInfo?.albumName)
  const originalInterval = text(musicInfo?.interval)
  if (!name) return { items: [], sources: [] }

  const settled = await searchSources(`${name} ${singer}`.trim(), originalSource, 0, limit, null, FALLBACK_SOURCE_ORDER)
  const items = rankAlternateCatalogTracks(
    settled.map(result => result.items),
    { name, singer, albumName, interval: originalInterval },
  )
  const sourcePriority = new Map(FALLBACK_SOURCE_ORDER.map((source, index) => [source, index]))
  items.sort((left, right) => (sourcePriority.get(left.source) ?? 99) - (sourcePriority.get(right.source) ?? 99))
  return {
    items,
    sources: settled.map(({ key, ok, error }) => ({ key, label: PLATFORM_LABELS[key], ok, error })),
  }
}

// Fast-path used by playback: search one preferred platform without waiting
// for unrelated slow/dead catalog endpoints. It retains the same LX matching
// rules and returns at most one candidate for that platform.
export async function findAlternateCatalogTrackForSource(musicInfo, originalSource, targetSource, limit = 25) {
  const name = text(musicInfo?.name)
  const singer = text(musicInfo?.singer)
  const albumName = text(musicInfo?.albumName)
  const originalInterval = text(musicInfo?.interval)
  if (!name || !SEARCHERS[targetSource] || targetSource === originalSource) return { item: null, sources: [] }

  const settled = await searchSources(`${name} ${singer}`.trim(), originalSource, 0, limit, targetSource)
  const items = rankAlternateCatalogTracks(
    settled.map(result => result.items),
    { name, singer, albumName, interval: originalInterval },
  )
  return {
    item: items[0] || null,
    sources: settled.map(({ key, ok, error }) => ({ key, label: PLATFORM_LABELS[key], ok, error })),
  }
}

export function rankAlternateCatalogTracks(lists, target) {
  const singerSeparator = /、|&|;|；|\/|,|，|\|/
  const sortSinger = value => {
    const singer = text(value)
    return singerSeparator.test(singer)
      ? singer.split(singerSeparator).sort((left, right) => left.localeCompare(right)).join('、')
      : singer
  }
  const filterText = value => text(value).replace(/\s|'|\.|,|，|&|"|、|\(|\)|（|）|`|~|-|<|>|\||\/|\]|\[|!|！/g, '').toLowerCase()
  const toSeconds = value => {
    if (!value) return 0
    if (typeof value === 'number') return Math.max(0, value)
    const parts = String(value).split(':')
    let result = 0
    let unit = 1
    while (parts.length) {
      result += Number.parseInt(parts.pop(), 10) * unit
      unit *= 60
    }
    return Number.isFinite(result) ? result : 0
  }

  const expected = {
    name: filterText(target?.name),
    singer: filterText(sortSinger(target?.singer)),
    album: filterText(target?.albumName),
    interval: text(target?.interval),
    seconds: toSeconds(target?.interval),
  }
  const includesName = value => expected.name.includes(value) || value.includes(expected.name)
  const includesSinger = value => expected.singer ? expected.singer.includes(value) || value.includes(expected.singer) : true
  const equalsAlbum = value => expected.album ? expected.album === value : true
  const equalsDuration = value => Math.abs((expected.seconds || value) - (value || expected.seconds)) < 5
  const decorate = item => ({
    item,
    name: filterText(item.title),
    singer: filterText(sortSinger(item.artist)),
    album: filterText(item.album),
    interval: interval(item.duration),
    seconds: toSeconds(item.duration),
  })

  const candidates = asArray(lists).map(list => {
    const compatible = asArray(list).map(decorate).filter(item => equalsDuration(item.seconds))
    return compatible.find(item => item.name === expected.name && includesSinger(item.singer))
      || compatible.find(item => item.singer === expected.singer && includesName(item.name))
      || compatible.find(item => equalsAlbum(item.album) && includesSinger(item.singer) && includesName(item.name))
      || null
  }).filter(Boolean)

  const ranked = []
  const take = predicate => {
    const group = []
    for (let index = candidates.length - 1; index >= 0; index--) {
      if (!predicate(candidates[index])) continue
      group.push(candidates[index].item)
      candidates.splice(index, 1)
    }
    group.reverse()
    ranked.push(...group)
  }
  take(item => item.singer === expected.singer && item.name === expected.name && item.interval === expected.interval)
  take(item => item.name === expected.name && item.singer === expected.singer && item.album === expected.album)
  take(item => item.singer === expected.singer && item.name === expected.name)
  take(item => item.name === expected.name && item.interval === expected.interval)
  take(item => item.singer === expected.singer && item.interval === expected.interval)
  take(item => item.interval === expected.interval)
  take(item => item.name === expected.name)
  take(item => item.singer === expected.singer)
  take(item => item.album === expected.album)
  return [...ranked, ...candidates.map(item => item.item)]
}
