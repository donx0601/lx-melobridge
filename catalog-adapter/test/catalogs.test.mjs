import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { decodeCatalogId, encodeCatalogId, makeCatalogTrack, rankAlternateCatalogTracks } from '../src/catalogs.mjs'
import { fetchCatalogLyrics } from '../src/lyrics.mjs'

test('catalog lyrics decode the compressed line-timed response', async () => {
  const result = await fetchCatalogLyrics('kw', { songmid: '42' }, async url => {
    assert.equal(url.hostname, 'newlyric.kuwo.cn')
    const query = Buffer.from(url.search.slice(1), 'base64')
    const key = Buffer.from('yeelion')
    for (let index = 0; index < query.length; index++) query[index] ^= key[index % key.length]
    assert.match(query.toString(), /&rid=MUSIC_42$/)
    const lyric = Buffer.concat([Buffer.from('[01:01.200]'), Buffer.from('b2e2cad4', 'hex')])
    return new Response(Buffer.concat([Buffer.from('tp=content\r\n\r\n'), deflateSync(lyric)]))
  })
  assert.equal(result.lyric, '[01:01.200]测试')
})

test('catalog lyrics fetch the LRC using the exact recording hash', async () => {
  const hash = 'ab'.repeat(16)
  const result = await fetchCatalogLyrics('kg', { hash }, async url => {
    if (url.pathname === '/search') {
      assert.equal(url.searchParams.get('hash'), hash)
      return Response.json({ candidates: [{ id: '42', accesskey: 'fixture' }] })
    }
    assert.equal(url.searchParams.get('fmt'), 'lrc')
    return Response.json({ fmt: 'lrc', content: Buffer.from('[00:01.00]测试歌词').toString('base64') })
  })
  assert.equal(result.lyric, '[00:01.00]测试歌词')
})

test('catalog lyrics keep timed translations and treat empty lyrics as a miss', async () => {
  const result = await fetchCatalogLyrics('wy', { songmid: '42' }, async () => Response.json({
    lrc: { lyric: '[00:01]Original' }, tlyric: { lyric: '[00:01]译文' },
  }))
  assert.equal(result.tlyric, '[00:01]译文')
  assert.equal(await fetchCatalogLyrics('wy', { songmid: '42' }, async () => Response.json({ lrc: { lyric: '[ti:Test]\n[00:01]' } })), null)
})

test('opaque catalog ids preserve LX musicInfo', () => {
  const value = { v: 1, source: 'kg', musicInfo: { hash: 'ABC', songmid: 123, name: '七里香' } }
  assert.deepEqual(decodeCatalogId(encodeCatalogId(value)), value)
})

test('catalog ids include the LX interval used for source matching', () => {
  const item = makeCatalogTrack('kw', { songmid: '42', name: '听闻爱情 (Live)', singer: '张信哲&杨丞琳' }, {
    title: '听闻爱情 (Live)', artist: '张信哲&杨丞琳', album: '天赐的声音', duration: 250, qualities: ['128k'],
  })
  const decoded = decodeCatalogId(item.id)
  assert.equal(decoded.musicInfo.interval, '4:10')
  assert.equal(decoded.musicInfo.albumName, '天赐的声音')
})

test('alternate platform ranking mirrors LX title singer album and duration rules', () => {
  const target = { name: '听闻爱情 (Live)', singer: '张信哲&杨丞琳', albumName: '天赐的声音', interval: '4:10' }
  const result = rankAlternateCatalogTracks([
    [candidate('kg', '听闻爱情 Live', '张信哲、杨丞琳', '别的专辑', 250)],
    [candidate('wy', '听闻爱情 Live版', '杨丞琳&张信哲', '天赐的声音', 250)],
    [candidate('tx', '听闻爱情 (Live)', '张信哲&杨丞琳', '天赐的声音', 290)],
    [candidate('mg', '听闻爱情', '不相关歌手', '天赐的声音', 250)],
  ], target)
  assert.deepEqual(result.map(item => item.source), ['kg', 'wy'])
})

function candidate(source, title, artist, album, duration) {
  return { source, title, artist, album, duration, id: source }
}
