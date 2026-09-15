import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { ProviderRegistry } from '../src/providers.mjs'
import { assertSafeMediaUrl } from '../src/network.mjs'

test('provider search maps metadata and adds a visible source prefix', async t => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url.startsWith('/search')) {
      return res.end(JSON.stringify({ items: [{
        id: 'track-1', title: '晴天', artist: '歌手', album: '专辑',
        source: 'wy',
        duration: 200, bitRate: 128, suffix: 'mp3', quality: '128k',
      }] }))
    }
    if (req.url.startsWith('/resolve/track-1')) {
      return res.end(JSON.stringify({ url: 'https://cdn.example/song.mp3' }))
    }
    res.statusCode = 404
    res.end('{}')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const port = server.address().port
  const registry = new ProviderRegistry([{
    key: 'demo', label: '测试平台', enabled: true,
    baseUrl: `http://127.0.0.1:${port}`, searchPath: '/search',
    resolvePath: '/resolve/{id}', timeoutMs: 2000, headers: {},
  }], 'prefix')

  const tracks = await registry.searchAll('晴天', 0, 20)
  assert.equal(tracks.length, 1)
  assert.equal(tracks[0].title, '【网易云】晴天')
  assert.equal(tracks[0].sourceLabel, '网易云')
  assert.equal(tracks[0].providerItemId, 'track-1')
  const resolved = await registry.resolve(tracks[0])
  assert.equal(resolved.url, 'https://cdn.example/song.mp3')
})

test('provider resolution cache is reused and can be force-refreshed', async t => {
  let resolveHits = 0
  let refreshHits = 0
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://provider.test')
    res.setHeader('content-type', 'application/json')
    if (url.pathname === '/search') {
      return res.end(JSON.stringify({ items: [{ id: 'track-cache', title: '缓存测试', source: 'kw', quality: '320k' }] }))
    }
    if (url.pathname === '/resolve/track-cache') {
      resolveHits++
      if (url.searchParams.get('refresh') === 'true') refreshHits++
      return res.end(JSON.stringify({ url: `https://cdn.example/song-${resolveHits}.mp3` }))
    }
    res.writeHead(404).end('{}')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const registry = new ProviderRegistry([{
    key: 'demo', label: '测试', enabled: true,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    searchPath: '/search', resolvePath: '/resolve/{id}', timeoutMs: 2000, headers: {},
  }], 'prefix', true, '320k', { resolveCacheTtlMs: 60000 })
  const [track] = await registry.searchAll('缓存测试', 0, 10)

  assert.equal((await registry.resolve(track)).url, 'https://cdn.example/song-1.mp3')
  assert.equal((await registry.resolve(track)).url, 'https://cdn.example/song-1.mp3')
  assert.equal(resolveHits, 1)
  assert.equal((await registry.resolve(track, { refresh: true })).url, 'https://cdn.example/song-2.mp3')
  assert.equal(resolveHits, 2)
  assert.equal(refreshHits, 1)
})

test('all LX platform source codes have stable visible labels', () => {
  const registry = new ProviderRegistry([{
    key: 'lx', label: '洛雪', enabled: true,
    baseUrl: 'http://provider.invalid', searchPath: '/search',
    resolvePath: '/resolve/{id}', timeoutMs: 2000, headers: {},
  }], 'prefix')
  const expected = {
    kw: '酷我',
    kg: '酷狗',
    wy: '网易云',
    tx: 'QQ音乐',
    mg: '咪咕',
  }
  for (const [source, label] of Object.entries(expected)) {
    const track = registry.toTrack(registry.get('lx'), { id: `${source}-1`, title: '测试歌曲', source })
    assert.equal(track.sourceLabel, label)
    assert.equal(track.title, `【${label}】测试歌曲`)
  }
})

test('rich audio metadata is preserved when source quality mode is requested', () => {
  const registry = new ProviderRegistry([{
    key: 'lx', label: '洛雪', enabled: true,
    baseUrl: 'http://provider.invalid', searchPath: '/search',
    resolvePath: '/resolve/{id}', timeoutMs: 2000, headers: {},
  }], 'prefix', true, 'source')
  const track = registry.toTrack(registry.get('lx'), {
    id: 'kg-24', title: '七里香', artist: '周杰伦', album: '七里香', source: 'kg',
    duration: 299, quality: 'flac24bit', suffix: 'flac', bitrate: 2304000,
    bitDepth: 24, samplingRate: 96000, channelCount: 2, size: 86123456,
  })
  assert.equal(track.title, '【酷狗·24bit】七里香')
  assert.equal(track.artist, '周杰伦')
  assert.equal(track.album, '七里香')
  assert.equal(track.duration, 299)
  assert.equal(track.bitRate, 2304)
  assert.equal(track.bitDepth, 24)
  assert.equal(track.samplingRate, 96000)
  assert.equal(track.channelCount, 2)
  assert.equal(track.size, 86123456)
})

test('online playback defaults to an MP3-compatible quality cap', () => {
  const registry = new ProviderRegistry([{
    key: 'lx', label: '洛雪', enabled: true,
    baseUrl: 'http://provider.invalid', searchPath: '/search',
    resolvePath: '/resolve/{id}', timeoutMs: 2000, headers: {},
  }], 'prefix', true)
  const track = registry.toTrack(registry.get('lx'), {
    id: 'kw-flac', title: '听闻爱情 (Live)', source: 'kw',
    quality: 'flac', suffix: 'flac', contentType: 'audio/flac', bitRate: 1000, bitDepth: 16,
  })
  assert.equal(track.title, '【酷我·HQ】听闻爱情 (Live)')
  assert.equal(track.quality, '320k')
  assert.equal(track.suffix, 'mp3')
  assert.equal(track.contentType, 'audio/mpeg')
  assert.equal(track.bitRate, 320)
  assert.equal(track.bitDepth, undefined)
})

test('media URL guard rejects private addresses by default', async () => {
  await assert.rejects(assertSafeMediaUrl('http://127.0.0.1/audio.mp3'), /Private/)
  const allowed = await assertSafeMediaUrl('http://127.0.0.1/audio.mp3', true)
  assert.equal(allowed.hostname, '127.0.0.1')
})
