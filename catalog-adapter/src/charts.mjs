import { fetchJson, PLATFORM_LABELS } from './catalogs.mjs'
import { mapKugouTrack, mapKuwoTrack, mapMiguTrack, mapNeteaseTrack, mapQqTrack } from './playlists.mjs'

const asArray = value => Array.isArray(value) ? value : value == null ? [] : [value]
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback
const text = value => String(value ?? '').trim()
const image = value => text(value).replace('{size}', '400')
let coverCache = { expiresAt: 0, values: new Map() }

// A compact, useful subset of the board definitions used by LX Music. Subsonic
// has no native "chart tabs", so every board is exposed as a read-only playlist.
export const CHARTS = Object.freeze({
  kg: [
    ['8888', 'TOP500'],
    ['6666', '飙升榜'],
    ['59703', '流行音乐榜'],
    ['52144', '抖音热歌榜'],
    ['23784', '网络红歌榜'],
  ],
  kw: [
    ['93', '飙升榜'],
    ['17', '新歌榜'],
    ['16', '热歌榜'],
    ['158', '抖音热歌榜'],
    ['187', '流行趋势榜'],
  ],
  wy: [
    ['19723756', '飙升榜'],
    ['3779629', '新歌榜'],
    ['2884035', '原创榜'],
    ['3778678', '热歌榜'],
    ['6723173524', '网络热歌榜'],
  ],
  tx: [
    ['4', '流行指数榜'],
    ['26', '热歌榜'],
    ['27', '新歌榜'],
    ['62', '飙升榜'],
    ['28', '网络歌曲榜'],
  ],
  mg: [
    ['27553319', '新歌榜'],
    ['27186466', '热歌榜'],
    ['27553408', '原创榜'],
    ['75959118', '音乐风向榜'],
    ['83176390', '国风金曲榜'],
  ],
})

export async function listCharts(source = null) {
  const selected = source ? [[source, CHARTS[source]]] : Object.entries(CHARTS)
  if (selected.some(([, values]) => !values)) throw new Error(`Unknown source: ${source}`)
  const covers = await chartCovers()
  return selected.flatMap(([sourceCode, values]) => values.map(([id, title]) => ({
    id,
    source: sourceCode,
    sourceLabel: PLATFORM_LABELS[sourceCode],
    title,
    creator: `${PLATFORM_LABELS[sourceCode]}排行榜`,
    description: '动态排行榜，打开时实时更新歌曲',
    trackCount: 100,
    coverUrl: covers.get(`${sourceCode}:${id}`),
  })))
}

export async function getChartDetail(source, id, limit = 100) {
  const definition = CHARTS[source]?.find(([chartId]) => chartId === String(id))
  if (!definition) throw new Error(`Unknown chart: ${source}/${id}`)
  const getter = DETAILS[source]
  const detail = await getter(String(id), Math.max(1, Math.min(number(limit, 100), 300)))
  const covers = await chartCovers()
  const items = detail.items.filter(Boolean)
  return {
    playlist: {
      id: String(id),
      source,
      sourceLabel: PLATFORM_LABELS[source],
      title: definition[1],
      creator: `${PLATFORM_LABELS[source]}排行榜`,
      description: '动态排行榜，打开时实时更新歌曲',
      coverUrl: detail.coverUrl || covers.get(`${source}:${id}`),
      trackCount: items.length,
    },
    items,
    total: number(detail.total, items.length),
  }
}

async function kugou(id, limit) {
  const url = `http://mobilecdnbj.kugou.com/api/v3/rank/song?version=9108&ranktype=1&plat=0&pagesize=${limit}&area_code=1&page=1&rankid=${encodeURIComponent(id)}&with_res_tag=0&show_portrait_mv=1`
  const body = await fetchJson(url)
  if (body.errcode !== 0) throw new Error(`Chart response error: ${body.error || body.errcode}`)
  return { items: asArray(body.data?.info).map(mapKugouTrack), total: body.data?.total }
}

async function kuwo(id, limit) {
  const url = `http://kbangserver.kuwo.cn/ksong.s?from=pc&fmt=json&pn=0&rn=${limit}&type=bang&data=content&id=${encodeURIComponent(id)}&show_copyright_off=0&pcmp4=1&isbang=1`
  const body = await fetchJson(url)
  return { items: asArray(body.musiclist).map(mapKuwoTrack), total: body.num, coverUrl: body.pic }
}

async function netease(id, limit) {
  const body = await fetchJson(`https://music.163.com/api/v3/playlist/detail?id=${encodeURIComponent(id)}&n=${limit}&s=8`, { headers: { referer: 'https://music.163.com/' } })
  if (body.code !== 200) throw new Error(`Chart response error: ${body.code}`)
  const info = body.playlist || {}
  let songs = asArray(info.tracks)
  const ids = asArray(info.trackIds).slice(0, limit).map(item => item.id).filter(Boolean)
  if (songs.length < ids.length) {
    songs = []
    for (let index = 0; index < ids.length; index += 100) {
      const chunk = ids.slice(index, index + 100)
      const detail = await fetchJson(`https://music.163.com/api/v3/song/detail?c=${encodeURIComponent(JSON.stringify(chunk.map(songId => ({ id: songId }))))}`, { headers: { referer: 'https://music.163.com/' } })
      songs.push(...asArray(detail.songs))
    }
  }
  return { items: songs.slice(0, limit).map(mapNeteaseTrack), total: info.trackCount, coverUrl: info.coverImgUrl }
}

async function qq(id, limit) {
  const url = `https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?topid=${encodeURIComponent(id)}&page=detail&type=top&song_begin=0&song_num=${limit}&format=json`
  const body = await fetchJson(url, { headers: { referer: 'https://y.qq.com/' } })
  if (body.code !== 0) throw new Error(`Chart response error: ${body.code}`)
  const items = asArray(body.songlist).map(item => {
    const raw = item.data || {}
    return mapQqTrack({
      id: raw.songid,
      mid: raw.songmid,
      title: raw.songname,
      singer: raw.singer,
      album: { id: raw.albumid, mid: raw.albummid, name: raw.albumname },
      file: {
        media_mid: raw.strMediaMid,
        size_128mp3: raw.size128,
        size_320mp3: raw.size320,
        size_flac: raw.sizeflac,
        size_hires: raw.size_hires,
      },
      interval: raw.interval,
    })
  })
  return { items, total: body.total_song_num, coverUrl: text(body.topinfo?.pic_v12 || body.topinfo?.pic) }
}

async function migu(id, limit) {
  const body = await fetchJson(`https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/querycontentbyId.do?columnId=${encodeURIComponent(id)}&needAll=0`, {
    headers: { referer: 'https://app.c.nf.migu.cn/', channel: '0146921' }, timeoutMs: 20000,
  })
  if (body.code !== '000000') throw new Error(`Chart response error: ${body.code}`)
  const contents = asArray(body.columnInfo?.contents).slice(0, limit)
  return {
    items: contents.map(item => mapMiguTrack(item.objectInfo)),
    total: contents.length,
    coverUrl: image(body.columnInfo?.columnPicUrl || body.columnInfo?.columnSmallpicUrl),
  }
}

const DETAILS = { kg: kugou, kw: kuwo, wy: netease, tx: qq, mg: migu }

async function chartCovers() {
  if (coverCache.expiresAt > Date.now()) return coverCache.values
  const values = new Map()
  const loaders = [loadKugouCovers, loadKuwoCovers, loadNeteaseCovers, loadQqCovers, loadMiguCovers]
  const settled = await Promise.allSettled(loaders.map(load => load()))
  for (let index = 0; index < settled.length; index++) {
    let result = settled[index]
    if (result.status !== 'fulfilled') {
      try { result = { status: 'fulfilled', value: await loaders[index]() } } catch { continue }
    }
    for (const [key, url] of result.value) if (url) values.set(key, url)
  }
  const expected = Object.values(CHARTS).reduce((total, charts) => total + charts.length, 0)
  const ttl = values.size >= expected ? 24 * 60 * 60 * 1000 : 60 * 1000
  coverCache = { expiresAt: Date.now() + ttl, values }
  return values
}

async function loadKugouCovers() {
  const body = await fetchJson('http://mobilecdnbj.kugou.com/api/v5/rank/list?version=9108&plat=0&showtype=2&parentid=0&apiver=6&area_code=1&withsong=1')
  const values = asArray(body.data?.info).map(item => [`kg:${item.rankid}`, image(item.img_cover || item.img_9 || item.banner_9)])
  const present = new Set(values.map(([key]) => key))
  const missing = CHARTS.kg.filter(([id]) => !present.has(`kg:${id}`))
  const fallback = await Promise.all(missing.map(async ([id]) => {
    try {
      const detail = await fetchJson(`http://mobilecdnbj.kugou.com/api/v3/rank/song?version=9108&ranktype=1&plat=0&pagesize=1&area_code=1&page=1&rankid=${encodeURIComponent(id)}&with_res_tag=0`)
      const first = asArray(detail.data?.info)[0] || {}
      return [`kg:${id}`, image(first.album_sizable_cover || first.trans_param?.union_cover)]
    } catch { return [`kg:${id}`, ''] }
  }))
  return [...values, ...fallback]
}

async function loadKuwoCovers() {
  const body = await fetchJson('http://qukudata.kuwo.cn/q.k?op=query&cont=tree&node=2&pn=0&rn=1000&fmt=json&level=2')
  return deepItems(body.child).filter(item => item.sourceid).map(item => [`kw:${item.sourceid}`, image(item.pic)])
}

async function loadNeteaseCovers() {
  const body = await fetchJson('https://music.163.com/api/toplist/detail', { headers: { referer: 'https://music.163.com/' } })
  return asArray(body.list).map(item => [`wy:${item.id}`, image(item.coverImgUrl)])
}

async function loadQqCovers() {
  const body = await fetchJson('https://c.y.qq.com/v8/fcg-bin/fcg_myqq_toplist.fcg?g_tk=1928093487&inCharset=utf-8&outCharset=utf-8&notice=0&format=json&uin=0&needNewCode=1&platform=h5', { headers: { referer: 'https://y.qq.com/' } })
  return asArray(body.data?.topList).map(item => [`tx:${item.id}`, image(item.picUrl)])
}

async function loadMiguCovers() {
  const body = await fetchJson('https://app.c.nf.migu.cn/pc/bmw/rank/rank-index/v1.0', {
    headers: { referer: 'https://app.c.nf.migu.cn/', channel: '0146921' }, timeoutMs: 20000,
  })
  const items = deepItems(body.data).filter(item => item.rankId)
  const values = items.map(item => [`mg:${item.rankId}`, image(item.imageUrl)])
  if (!values.some(([key]) => key === 'mg:75959118')) {
    try {
      const detail = await fetchJson('https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/querycontentbyId.do?columnId=75959118&needAll=0', {
        headers: { referer: 'https://app.c.nf.migu.cn/', channel: '0146921' }, timeoutMs: 20000,
      })
      values.push(['mg:75959118', image(detail.columnInfo?.columnPicUrl || detail.columnInfo?.columnSmallpicUrl)])
    } catch {}
  }
  return values
}

function deepItems(value, output = [], seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return output
  seen.add(value)
  if (!Array.isArray(value)) output.push(value)
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) for (const item of child) deepItems(item, output, seen)
    else deepItems(child, output, seen)
  }
  return output
}
