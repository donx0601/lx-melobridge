import { createHash } from 'node:crypto'
import { fetchJson, makeCatalogTrack, PLATFORM_LABELS } from './catalogs.mjs'

const asArray = value => Array.isArray(value) ? value : value == null ? [] : [value]
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback
const text = value => String(value ?? '')
  .replace(/<[^>]*>/g, '')
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>')
  .replaceAll('&quot;', '"').replaceAll('&#39;', "'").trim()
const names = (items, key = 'name') => asArray(items).map(item => text(typeof item === 'string' ? item : item?.[key] || item?.title)).filter(Boolean).join('、')
const image = value => text(value).replace('{size}', '400')

export async function searchPlaylists(query, source, offset, limit) {
  const selected = source ? [[source, SEARCHERS[source]]] : Object.entries(SEARCHERS)
  if (selected.some(([, search]) => !search)) throw new Error(`Unknown source: ${source}`)
  const settled = await Promise.all(selected.map(async ([key, search]) => {
    try { return { key, ok: true, ...(await search(query, offset, limit)) } }
    catch (error) { return { key, ok: false, items: [], total: 0, error: error.message } }
  }))
  const items = []
  const longest = Math.max(0, ...settled.map(result => result.items.length))
  for (let index = 0; index < longest; index++) for (const result of settled) if (result.items[index]) items.push(result.items[index])
  return {
    items,
    total: settled.reduce((sum, result) => sum + result.total, 0),
    sources: settled.map(({ key, ok, error }) => ({ key, label: PLATFORM_LABELS[key], ok, error })),
  }
}

export async function getPlaylistDetail(source, id) {
  const getter = DETAILS[source]
  if (!getter) throw new Error(`Unknown source: ${source}`)
  return getter(String(id))
}

const playlist = (source, raw) => ({
  id: String(raw.id),
  source,
  sourceLabel: PLATFORM_LABELS[source],
  title: text(raw.title),
  creator: text(raw.creator),
  description: text(raw.description),
  coverUrl: image(raw.coverUrl),
  trackCount: Math.max(0, Math.round(number(raw.trackCount))),
  playCount: Math.max(0, Math.round(number(raw.playCount))),
})

async function searchKuwo(query, offset, limit) {
  const page = Math.floor(offset / limit)
  const url = `https://search.kuwo.cn/r.s?all=${encodeURIComponent(query)}&pn=${page}&rn=${limit}&rformat=json&encoding=utf8&ver=mbox&vipver=MUSIC_8.7.7.0_BCS37&plat=pc&devid=28156413&ft=playlist&pay=0&needliveshow=0`
  const body = parseLooseJson(await fetchText(url))
  return { items: asArray(body.abslist).map(item => playlist('kw', {
    id: item.playlistid, title: item.name, creator: item.nickname, description: item.intro,
    coverUrl: item.pic, trackCount: item.songnum, playCount: item.playcnt,
  })), total: number(body.TOTAL) }
}

async function searchKugou(query, offset, limit) {
  const page = Math.floor(offset / limit) + 1
  const body = await fetchJson(`http://msearchretry.kugou.com/api/v3/search/special?keyword=${encodeURIComponent(query)}&page=${page}&pagesize=${limit}&showtype=10&filter=0&version=7910&sver=2`)
  return { items: asArray(body.data?.info).map(item => playlist('kg', {
    id: item.specialid, title: item.specialname, creator: item.nickname, description: item.intro,
    coverUrl: item.imgurl, trackCount: item.songcount, playCount: item.playcount,
  })), total: number(body.data?.total) }
}

async function searchQq(query, offset, limit) {
  const page = Math.floor(offset / limit)
  const url = `http://c.y.qq.com/soso/fcgi-bin/client_music_search_songlist?page_no=${page}&num_per_page=${limit}&format=json&query=${encodeURIComponent(query)}&remoteplace=txt.yqq.playlist&inCharset=utf8&outCharset=utf-8`
  const body = await fetchJson(url, { headers: { referer: 'http://y.qq.com/portal/search.html' } })
  return { items: asArray(body.data?.list).map(item => playlist('tx', {
    id: item.dissid, title: item.dissname, creator: item.creator?.name, description: item.introduction,
    coverUrl: item.imgurl, trackCount: item.song_count, playCount: item.listennum,
  })), total: number(body.data?.sum) }
}

async function searchNetease(query, offset, limit) {
  const form = new URLSearchParams({ s: query, type: '1000', offset: String(offset), limit: String(limit) })
  const body = await fetchJson('https://music.163.com/api/search/get/web', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', referer: 'https://music.163.com/' }, body: form,
  })
  return { items: asArray(body.result?.playlists).map(item => playlist('wy', {
    id: item.id, title: item.name, creator: item.creator?.nickname, description: item.description,
    coverUrl: item.coverImgUrl, trackCount: item.trackCount, playCount: item.playCount,
  })), total: number(body.result?.playlistCount) }
}

async function searchMigu(query, offset, limit) {
  const page = Math.floor(offset / limit) + 1
  const time = Date.now().toString()
  const deviceId = '963B7AA0D21511ED807EE5846EC87D20'
  const sign = createHash('md5').update(`${query}6cdc72a439cef99a3418d2a78aa28c73yyapp2d16148780a1dcc7408e06336b98cfd50${deviceId}${time}`).digest('hex')
  const url = new URL('https://jadeite.migu.cn/music_search/v3/search/searchAll')
  Object.entries({ isCorrect: '1', isCopyright: '1', searchSwitch: '{"song":0,"album":0,"singer":0,"tagSong":0,"mvSong":0,"bestShow":0,"songlist":1,"lyricSong":0}', pageSize: limit, text: query, pageNo: page, sort: '0', sid: 'USS' }).forEach(([key, value]) => url.searchParams.set(key, value))
  const body = await fetchJson(url, { headers: { uiVersion: 'A_music_3.6.1', deviceId, timestamp: time, sign, channel: '0146921' } })
  return { items: asArray(body.songListResultData?.result).map(item => playlist('mg', {
    id: item.id, title: item.name, creator: item.userName, coverUrl: item.musicListPicUrl,
    trackCount: item.musicNum, playCount: item.playNum,
  })), total: number(body.songListResultData?.totalCount) }
}

async function detailKuwo(id) {
  const body = await fetchJson(`http://nplserver.kuwo.cn/pl.svc?op=getlistinfo&pid=${encodeURIComponent(id)}&pn=0&rn=1000&encode=utf8&keyset=pl2012&identity=kuwo&pcmp4=1&vipver=MUSIC_9.0.5.0_W1&newver=1`)
  const items = asArray(body.musiclist).map(mapKuwoTrack).filter(Boolean)
  return { playlist: playlist('kw', { id, title: body.title, creator: body.uname, description: body.info, coverUrl: body.pic, trackCount: body.total, playCount: body.playnum }), items, total: number(body.total, items.length) }
}

async function detailKugou(id) {
  const body = await fetchJson(`http://mobilecdn.kugou.com/api/v3/special/song?specialid=${encodeURIComponent(id)}&page=1&pagesize=1000&plat=0&version=8150`)
  const items = asArray(body.data?.info).map(mapKugouTrack).filter(Boolean)
  return { playlist: playlist('kg', { id, title: body.data?.specialname || `酷狗歌单 ${id}`, creator: body.data?.nickname, coverUrl: body.data?.imgurl, trackCount: body.data?.total || items.length }), items, total: number(body.data?.total, items.length) }
}

async function detailQq(id) {
  const url = `https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&json=1&utf8=1&onlysong=0&new_format=1&disstid=${encodeURIComponent(id)}&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0`
  const body = await fetchJson(url, { headers: { origin: 'https://y.qq.com', referer: `https://y.qq.com/n/ryqq/playlist/${id}` } })
  const info = asArray(body.cdlist)[0] || {}
  const items = asArray(info.songlist).map(mapQqTrack).filter(Boolean)
  return { playlist: playlist('tx', { id, title: info.dissname, creator: info.nickname, description: info.desc, coverUrl: info.logo, trackCount: info.songnum || items.length, playCount: info.visitnum }), items, total: items.length }
}

async function detailNetease(id) {
  const body = await fetchJson(`https://music.163.com/api/v3/playlist/detail?id=${encodeURIComponent(id)}&n=1000&s=8`, { headers: { referer: 'https://music.163.com/' } })
  const info = body.playlist || {}
  let songs = asArray(info.tracks)
  const trackIds = asArray(info.trackIds).map(item => item.id).filter(Boolean)
  if (songs.length < trackIds.length) {
    songs = []
    for (let index = 0; index < trackIds.length; index += 100) {
      const ids = trackIds.slice(index, index + 100)
      const detail = await fetchJson(`https://music.163.com/api/v3/song/detail?c=${encodeURIComponent(JSON.stringify(ids.map(songId => ({ id: songId }))))}`, { headers: { referer: 'https://music.163.com/' } })
      songs.push(...asArray(detail.songs))
    }
  }
  const items = songs.map(mapNeteaseTrack).filter(Boolean)
  return { playlist: playlist('wy', { id, title: info.name, creator: info.creator?.nickname, description: info.description, coverUrl: info.coverImgUrl, trackCount: info.trackCount || info.trackIds?.length, playCount: info.playCount }), items, total: number(info.trackCount, items.length) }
}

async function detailMigu(id) {
  const headers = { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3)', referer: 'https://m.music.migu.cn/' }
  const [firstPage, metadata] = await Promise.all([
    fetchJson(`https://app.c.nf.migu.cn/MIGUM3.0/resource/playlist/song/v2.0?pageNo=1&pageSize=50&playlistId=${encodeURIComponent(id)}`, { headers }),
    fetchJson(`https://c.musicapp.migu.cn/MIGUM3.0/resource/playlist/v2.0?playlistId=${encodeURIComponent(id)}`, { headers }).catch(() => ({})),
  ])
  const total = number(firstPage.data?.totalCount)
  const rawSongs = [...asArray(firstPage.data?.songList)]
  for (let page = 2; rawSongs.length < total && page <= Math.ceil(total / 50); page++) {
    const next = await fetchJson(`https://app.c.nf.migu.cn/MIGUM3.0/resource/playlist/song/v2.0?pageNo=${page}&pageSize=50&playlistId=${encodeURIComponent(id)}`, { headers })
    rawSongs.push(...asArray(next.data?.songList))
  }
  const info = metadata.data || {}
  const items = rawSongs.map(mapMiguTrack).filter(Boolean)
  return { playlist: playlist('mg', { id, title: info.title || `咪咕歌单 ${id}`, creator: info.ownerName, description: info.summary, coverUrl: info.imgItem?.img, trackCount: total, playCount: info.opNumItem?.playNum }), items, total: number(total, items.length) }
}

export function mapKuwoTrack(info) {
  const songmid = text(info.id || info.musicrid).replace(/^MUSIC_/, '')
  if (!songmid) return null
  const parsed = kuwoQualities(info.N_MINFO || info.MINFO)
  const formats = new Set(text(info.formats).split('|'))
  const qualities = parsed.qualities.length ? parsed.qualities : [
    formats.has('MP3128') || formats.has('WMA128') ? '128k' : null,
    formats.has('MP3H') || formats.has('OGGH') ? '320k' : null,
    formats.has('ALFLAC') ? 'flac' : null,
  ].filter(Boolean)
  const sizes = parsed.sizes
  return makeCatalogTrack('kw', { source: 'kw', songmid, albumId: text(info.albumid), name: text(info.name), singer: text(info.artist), albumName: text(info.album), types: qualities.map(type => ({ type })) }, { title: info.name, artist: info.artist, album: info.album, duration: info.duration, coverUrl: info.albumpic, qualities, sizes })
}

export function mapKugouTrack(info) {
  const hash = text(info.hash)
  if (!hash) return null
  const [fallbackSinger, ...titleParts] = text(info.filename).split(' - ')
  const artist = text(info.singername || fallbackSinger)
  const title = text(info.songname || titleParts.join(' - ') || info.remark)
  const pairs = [['128k', info.filesize, info.hash], ['320k', info['320filesize'], info['320hash']], ['flac', info.sqfilesize, info.sqhash]]
  const types = pairs.filter(([, size, value]) => number(size) && value).map(([type, size, value]) => ({ type, size: number(size), hash: value }))
  const sizes = Object.fromEntries(types.map(item => [item.type, item.size]))
  return makeCatalogTrack('kg', { source: 'kg', songmid: info.audio_id, hash, albumId: info.album_id, name: title, singer: artist, albumName: text(info.remark), types, _types: Object.fromEntries(types.map(item => [item.type, { size: item.size, hash: item.hash }])) }, { title, artist, album: info.remark, duration: info.duration, coverUrl: info.trans_param?.union_cover, qualities: types.map(item => item.type), sizes })
}

export function mapQqTrack(info) {
  const songmid = text(info.mid || info.songmid)
  if (!songmid) return null
  const artist = names(info.singer)
  const album = info.album || {}
  const pairs = [['128k', info.file?.size_128mp3], ['320k', info.file?.size_320mp3], ['flac', info.file?.size_flac], ['flac24bit', info.file?.size_hires]]
  const qualities = pairs.filter(([, size]) => number(size)).map(([quality]) => quality)
  const sizes = Object.fromEntries(pairs.filter(([, size]) => number(size)).map(([quality, size]) => [quality, number(size)]))
  return makeCatalogTrack('tx', { source: 'tx', songmid, songId: info.id, albumId: album.id, albumMid: album.mid, strMediaMid: info.file?.media_mid, name: text(info.title || info.name), singer: artist, albumName: text(album.name), types: qualities.map(type => ({ type })) }, { title: info.title || info.name, artist, album: album.name, duration: info.interval, coverUrl: album.mid ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${album.mid}.jpg` : '', qualities, sizes })
}

export function mapNeteaseTrack(info) {
  if (!info.id) return null
  const artist = names(info.ar || info.artists)
  const album = info.al || info.album || {}
  const pairs = [['128k', info.l], ['320k', info.h], ['flac', info.sq], ['flac24bit', info.hr]]
  const qualities = pairs.filter(([, value]) => value).map(([quality]) => quality)
  const sizes = Object.fromEntries(pairs.filter(([, value]) => value).map(([quality, value]) => [quality, number(value.size)]))
  return makeCatalogTrack('wy', { source: 'wy', songmid: info.id, name: text(info.name), singer: artist, albumName: text(album.name), albumId: album.id, types: qualities.map(type => ({ type })) }, { title: info.name, artist, album: album.name, duration: number(info.dt || info.duration) / 1000, coverUrl: album.picUrl, qualities, sizes })
}

export function mapMiguTrack(info) {
  const songmid = info.songId || info.id
  const copyrightId = info.copyrightId || info.copyrightID
  if (!songmid || !copyrightId) return null
  const artist = names(info.singerList || info.singers, 'name') || text(info.singer)
  const formats = asArray(info.audioFormats || info.newRateFormats || info.rateFormats)
  const qualities = formats.map(format => format.formatType === 'PQ' ? '128k' : format.formatType === 'HQ' ? '320k' : format.formatType === 'SQ' ? 'flac' : ['ZQ', 'ZQ24'].includes(format.formatType) ? 'flac24bit' : null).filter(Boolean)
  return makeCatalogTrack('mg', { source: 'mg', songmid, copyrightId, name: text(info.name || info.songName), singer: artist, albumName: text(info.album || info.albumName), albumId: info.albumId, types: qualities.map(type => ({ type })) }, { title: info.name || info.songName, artist, album: info.album || info.albumName, duration: info.duration, coverUrl: info.img3 || info.img || info.albumImgs?.[0]?.img, qualities })
}

function kuwoQualities(raw) {
  const qualities = []
  const sizes = {}
  for (const part of String(raw || '').split(';')) {
    const match = part.match(/bitrate:(\d+),format:(\w+),size:([\w.]+)/)
    if (!match) continue
    const quality = match[1] === '4000' ? 'flac24bit' : match[1] === '2000' ? 'flac' : match[1] === '320' ? '320k' : match[1] === '128' ? '128k' : null
    if (quality) { qualities.push(quality); sizes[quality] = match[3] }
  }
  return { qualities, sizes }
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 lx-melobridge/0.4' }, signal: AbortSignal.timeout(12000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.text()
}

function parseLooseJson(raw) {
  let output = ''
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] !== "'") { output += raw[index]; continue }
    output += '"'
    for (index++; index < raw.length; index++) {
      const char = raw[index]
      if (char === "'") { output += '"'; break }
      if (char === '\\') {
        const next = raw[++index]
        output += next === "'" ? "'" : `\\${next}`
      } else if (char === '"') output += '\\"'
      else if (char === '\n') output += '\\n'
      else if (char === '\r') output += '\\r'
      else output += char
    }
  }
  return JSON.parse(output.replace(/\bundefined\b/g, 'null'))
}

const SEARCHERS = Object.freeze({ kw: searchKuwo, kg: searchKugou, tx: searchQq, wy: searchNetease, mg: searchMigu })
const DETAILS = Object.freeze({ kw: detailKuwo, kg: detailKugou, tx: detailQq, wy: detailNetease, mg: detailMigu })
