import { inflateSync } from 'node:zlib'

const numericId = /^\d+$/
const kuwoKey = Buffer.from('yeelion')

export async function fetchCatalogLyrics(source, musicInfo, fetcher = fetch) {
  const signal = AbortSignal.timeout(3500)
  async function get(endpoint, params, headers = {}) {
    const url = new URL(endpoint)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    const response = await fetcher(url, { signal, headers })
    if (!response.ok) throw new Error(`Lyrics upstream returned HTTP ${response.status}`)
    return response.json()
  }

  const id = String(musicInfo?.songmid ?? '')
  switch (source) {
    case 'kw': {
      if (!numericId.test(id)) return null
      // Request the line-timed format. The response is a header followed by zlib data.
      const query = Buffer.from(`user=12345,web,web,web&requester=localhost&req=1&rid=MUSIC_${id}`)
      for (let index = 0; index < query.length; index++) query[index] ^= kuwoKey[index % kuwoKey.length]
      const url = new URL(`https://newlyric.kuwo.cn/newlyric.lrc?${query.toString('base64')}`)
      const response = await fetcher(url, { signal })
      if (!response.ok) throw new Error(`Lyrics upstream returned HTTP ${response.status}`)
      const payload = Buffer.from(await response.arrayBuffer())
      const headerEnd = payload.indexOf('\r\n\r\n')
      if (headerEnd < 0 || payload.toString('ascii', 0, 10) !== 'tp=content') return null
      const lyric = new TextDecoder('gb18030').decode(inflateSync(payload.subarray(headerEnd + 4), { maxOutputLength: 2_000_000 }))
      return normalize(lyric)
    }
    case 'wy': {
      if (!numericId.test(id)) return null
      const body = await get('https://music.163.com/api/song/lyric', { id, lv: -1, tv: -1, rv: -1 }, { referer: 'https://music.163.com/' })
      return normalize(body?.lrc?.lyric, body?.tlyric?.lyric, body?.romalrc?.lyric)
    }
    case 'kg': {
      const hash = String(musicInfo?.hash ?? '')
      if (!/^[a-f0-9]{32}$/i.test(hash)) return null
      const headers = { 'user-agent': 'KuGou2012-9020-ExpandSearchManager' }
      const search = await get('https://lyrics.kugou.com/search', {
        ver: 1, man: 'yes', client: 'pc', hash, keyword: musicInfo.name || '', lrctxt: 1,
      }, headers)
      const candidate = search?.candidates?.[0]
      if (!candidate?.id || !candidate.accesskey) return null
      const body = await get('https://lyrics.kugou.com/download', {
        ver: 1, client: 'pc', id: candidate.id, accesskey: candidate.accesskey, fmt: 'lrc', charset: 'utf8',
      }, headers)
      return body?.fmt === 'lrc' && typeof body.content === 'string'
        ? normalize(Buffer.from(body.content, 'base64').toString('utf8')) : null
    }
    default:
      return null
  }
}

function normalize(lyric, tlyric, rlyric) {
  if (typeof lyric !== 'string' || !/^\s*(?:\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\])+\s*[^\s\[]/m.test(lyric)) return null
  return { lyric: lyric.trim(), tlyric: typeof tlyric === 'string' ? tlyric.trim() : '', rlyric: typeof rlyric === 'string' ? rlyric.trim() : '' }
}
