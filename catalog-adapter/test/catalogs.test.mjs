import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeCatalogId, encodeCatalogId, makeCatalogTrack, rankAlternateCatalogTracks } from '../src/catalogs.mjs'

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
