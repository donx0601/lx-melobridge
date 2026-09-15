import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const listen = async handler => {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server
}

const close = server => new Promise(resolve => server.close(resolve))

test('gateway merges, streams ranges, and persists online favorites', { timeout: 20000 }, async t => {
  const media = Buffer.from('0123456789abcdef')
  let resolveFails = false
  let providerPort
  const provider = await listen((req, res) => {
    const url = new URL(req.url, 'http://provider.test')
    res.setHeader('content-type', 'application/json')
    if (url.pathname === '/search') {
      assert.ok(['七里香', '周杰伦', '七里香 周杰伦'].includes(url.searchParams.get('q')))
      return res.end(JSON.stringify({ items: [{
        id: 'kg-track-1', title: '七里香', artist: '周杰伦', album: '七里香',
        source: 'kg', duration: 299, quality: 'flac24bit', suffix: 'flac', bitDepth: 24,
      }] }))
    }
    if (url.pathname === '/playlist/search') {
      return res.end(JSON.stringify({ items: [{
        id: 'playlist-1', source: 'kg', title: '周杰伦精选', creator: '测试作者',
        trackCount: 1, coverUrl: 'https://img.example/playlist.jpg',
      }] }))
    }
    if (url.pathname === '/playlist/detail') {
      assert.equal(url.searchParams.get('source'), 'kg')
      assert.equal(url.searchParams.get('id'), 'playlist-1')
      return res.end(JSON.stringify({
        playlist: { id: 'playlist-1', source: 'kg', title: '周杰伦精选', creator: '测试作者', trackCount: 1 },
        items: [{ id: 'kg-track-1', title: '七里香', artist: '周杰伦', album: '七里香', source: 'kg', duration: 299, quality: 'flac24bit', suffix: 'flac', bitDepth: 24 }],
      }))
    }
    if (url.pathname === '/chart/list') {
      return res.end(JSON.stringify({ items: [{
        id: '8888', source: 'kg', title: 'TOP500', creator: '酷狗排行榜', trackCount: 500,
        coverUrl: `http://127.0.0.1:${providerPort}/chart-cover`,
      }] }))
    }
    if (url.pathname === '/chart/detail') {
      assert.equal(url.searchParams.get('source'), 'kg')
      assert.equal(url.searchParams.get('id'), '8888')
      return res.end(JSON.stringify({
        playlist: { id: '8888', source: 'kg', title: 'TOP500', creator: '酷狗排行榜', trackCount: 1 },
        items: [{ id: 'kg-track-1', title: '七里香', artist: '周杰伦', album: '七里香', source: 'kg', duration: 299, quality: 'flac24bit', suffix: 'flac', bitDepth: 24 }],
      }))
    }
    if (url.pathname === '/chart-cover') {
      res.setHeader('content-type', 'image/png')
      return res.end(Buffer.from('89504e470d0a1a0a', 'hex'))
    }
    if (url.pathname === '/resolve/kg-track-1') {
      assert.equal(url.searchParams.get('quality'), '320k')
      if (resolveFails) {
        res.statusCode = 500
        return res.end(JSON.stringify({ error: 'intentional resolver failure' }))
      }
      return res.end(JSON.stringify({ url: `http://127.0.0.1:${providerPort}/audio` }))
    }
    if (url.pathname === '/lyric/kg-track-1') {
      return res.end(JSON.stringify({ lyric: '[ar:周杰伦]\n[ti:七里香]\n[00:01.00]测试歌词\n[00:02.50]第二行' }))
    }
    if (url.pathname === '/audio') {
      res.setHeader('accept-ranges', 'bytes')
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d+)?$/)
      if (range) {
        const start = Number(range[1])
        const end = Math.min(Number(range[2] ?? media.length - 1), media.length - 1)
        const part = media.subarray(start, end + 1)
        res.writeHead(206, {
          'content-type': 'audio/mpeg',
          'content-length': part.length,
          'content-range': `bytes ${start}-${end}/${media.length}`,
        })
        return res.end(part)
      }
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': media.length })
      return res.end(media)
    }
    res.statusCode = 404
    res.end('{}')
  })
  providerPort = provider.address().port
  t.after(() => close(provider))

  const navidrome = await listen((req, res) => {
    const url = new URL(req.url, 'http://navidrome.test')
    assert.equal(url.searchParams.get('u'), 'nav-user')
    const action = url.pathname.split('/').pop().replace('.view', '')
    res.setHeader('content-type', 'text/xml; charset=utf-8')
    if (action === 'search3') {
      return res.end('<?xml version="1.0"?><subsonic-response status="ok" version="1.16.1"><searchResult3><song id="local-1" title="七里香（本地）" artist="周杰伦" album="七里香" duration="299"/></searchResult3></subsonic-response>')
    }
    if (action === 'getStarred2') {
      return res.end('<?xml version="1.0"?><subsonic-response status="ok" version="1.16.1"><starred2/></subsonic-response>')
    }
    if (action === 'getPlaylists') {
      return res.end('<?xml version="1.0"?><subsonic-response status="ok" version="1.16.1"><playlists><playlist id="local-playlist" name="本地歌单" songCount="1" duration="299"/></playlists></subsonic-response>')
    }
    return res.end('<?xml version="1.0"?><subsonic-response status="ok" version="1.16.1"/>')
  })
  t.after(() => close(navidrome))

  const scratch = await mkdtemp(join(tmpdir(), 'lx-melobridge-gateway-test-'))
  const providerFile = join(scratch, 'providers.json')
  await writeFile(providerFile, JSON.stringify([{
    key: 'catalog', label: '目录', enabled: true,
    baseUrl: `http://127.0.0.1:${providerPort}`,
    searchPath: '/search', resolvePath: '/resolve/{id}', lyricPath: '/lyric/{id}', timeoutMs: 2000,
  }]))

  const portProbe = await listen((_req, res) => res.end())
  const gatewayPort = portProbe.address().port
  await close(portProbe)
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(gatewayPort),
      GATEWAY_USER: 'ios-user',
      GATEWAY_PASSWORD: 'ios-pass',
      NAVIDROME_URL: `http://127.0.0.1:${navidrome.address().port}`,
      NAVIDROME_USER: 'nav-user',
      NAVIDROME_PASSWORD: 'nav-pass',
      PROVIDERS_FILE: providerFile,
      DATA_DIR: scratch,
      SOURCE_LABEL_MODE: 'prefix',
      SHOW_QUALITY_LABEL: 'true',
      ALLOW_PRIVATE_STREAMS: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => child.kill())
  await waitReady(`http://127.0.0.1:${gatewayPort}/healthz`, child)

  const auth = 'u=ios-user&p=ios-pass&v=1.16.1&c=test&f=xml'
  const searchResponse = await fetch(`http://127.0.0.1:${gatewayPort}/rest/search3.view?${auth}&query=${encodeURIComponent('七里香')}&songCount=20`)
  const xml = await searchResponse.text()
  assert.match(xml, /title="七里香（本地）"/)
  assert.match(xml, /title="【酷狗·HQ】七里香"/)
  assert.match(xml, /<artist[^>]+name="周杰伦"/)
  assert.match(xml, /<album[^>]+name="七里香"/)
  assert.match(xml, /artist="周杰伦"/)
  assert.match(xml, /duration="299"/)
  assert.match(xml, /contentType="audio\/mpeg"/)
  assert.match(xml, /suffix="mp3"/)
  assert.match(xml, /bitRate="320"/)
  assert.doesNotMatch(xml, /bitDepth=/)
  const remoteId = xml.match(/id="(remote:[^"]+)" title="【酷狗·HQ】七里香"/)?.[1]
  assert.ok(remoteId)
  const onlineSong = xml.match(/<song[^>]+title="【酷狗·HQ】七里香"[^>]*\/>/)?.[0]
  const artistId = onlineSong?.match(/artistId="([^"]+)"/)?.[1]
  const albumId = onlineSong?.match(/albumId="([^"]+)"/)?.[1]
  assert.ok(artistId)
  assert.ok(albumId)

  const artistResponse = await fetch(`http://127.0.0.1:${gatewayPort}/rest/getArtist.view?${auth}&id=${encodeURIComponent(artistId)}`)
  const artistXml = await artistResponse.text()
  assert.match(artistXml, /<artist[^>]+name="周杰伦"/)
  assert.match(artistXml, /<album[^>]+name="七里香"/)
  const albumResponse = await fetch(`http://127.0.0.1:${gatewayPort}/rest/getAlbum.view?${auth}&id=${encodeURIComponent(albumId)}`)
  const albumXml = await albumResponse.text()
  assert.match(albumXml, /<album[^>]+name="七里香"/)
  assert.match(albumXml, /<song[^>]+title="【酷狗·HQ】七里香"/)

  const legacyLyrics = await fetch(`http://127.0.0.1:${gatewayPort}/rest/getLyrics.view?${auth}&artist=${encodeURIComponent('周杰伦')}&title=${encodeURIComponent('【酷狗·HQ】七里香')}`)
  const legacyLyricsXml = await legacyLyrics.text()
  assert.match(legacyLyricsXml, /<lyrics[^>]+artist="周杰伦"[^>]*>\[ar:周杰伦\]/)
  const structuredLyrics = await fetch(`http://127.0.0.1:${gatewayPort}/rest/getLyricsBySongId.view?${auth}&id=${encodeURIComponent(remoteId)}`)
  const structuredLyricsXml = await structuredLyrics.text()
  assert.match(structuredLyricsXml, /<structuredLyrics[^>]+synced="true"/)
  assert.match(structuredLyricsXml, /<line start="1000">测试歌词<\/line>/)
  const extensions = await fetch(`http://127.0.0.1:${gatewayPort}/rest/getOpenSubsonicExtensions.view?${auth}`)
  assert.match(await extensions.text(), /name="songLyrics"/)

  const streamResponse = await fetch(`http://127.0.0.1:${gatewayPort}/rest/stream.view?${auth}&id=${encodeURIComponent(remoteId)}`, { headers: { range: 'bytes=2-5' } })
  assert.equal(streamResponse.status, 206)
  assert.equal(streamResponse.headers.get('content-range'), 'bytes 2-5/16')
  assert.equal(await streamResponse.text(), '2345')

  resolveFails = true
  const failedStream = await fetch(`http://127.0.0.1:${gatewayPort}/rest/stream.view?${auth}&id=${encodeURIComponent(remoteId)}&refresh=true`)
  assert.equal(failedStream.status, 500)
  assert.match(await failedStream.text(), /intentional resolver failure/)
  assert.equal(child.exitCode, null)
  resolveFails = false

  const starResponse = await fetch(`http://127.0.0.1:${gatewayPort}/rest/star.view?${auth}&id=${encodeURIComponent(remoteId)}`)
  assert.equal(starResponse.status, 200)
  const starAlbumResponse = await fetch(`http://127.0.0.1:${gatewayPort}/rest/star.view?${auth}&albumId=${encodeURIComponent(albumId)}`)
  assert.equal(starAlbumResponse.status, 200)
  const starArtistResponse = await fetch(`http://127.0.0.1:${gatewayPort}/rest/star.view?${auth}&artistId=${encodeURIComponent(artistId)}`)
  assert.equal(starArtistResponse.status, 200)
  const starredResponse = await fetch(`http://127.0.0.1:${gatewayPort}/rest/getStarred2.view?${auth}`)
  const starredXml = await starredResponse.text()
  assert.match(starredXml, new RegExp(`id="${remoteId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`))
  assert.match(starredXml, new RegExp(`<album[^>]+id="${albumId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]+starred="[^"]+"`))
  assert.match(starredXml, new RegExp(`<artist[^>]+id="${artistId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]+starred="[^"]+"`))
  assert.match(starredXml, /starred="[^"]+"/)
  const starredAlbumResponse = await fetch(`http://127.0.0.1:${gatewayPort}/rest/getAlbum.view?${auth}&id=${encodeURIComponent(albumId)}`)
  assert.match(await starredAlbumResponse.text(), /<album[^>]+name="七里香"[^>]+starred="[^"]+"/)

  const missingId = `remote:catalog:${Buffer.from('missing-track').toString('base64url')}`
  const missingStar = await fetch(`http://127.0.0.1:${gatewayPort}/rest/star.view?${auth}&id=${encodeURIComponent(missingId)}`)
  assert.equal(missingStar.status, 200)
  assert.match(await missingStar.text(), /status="failed"/)
  assert.equal(child.exitCode, null)

  const basic = `Basic ${Buffer.from('ios-user:ios-pass').toString('base64')}`
  const playlistSearch = await fetch(`http://127.0.0.1:${gatewayPort}/playlists?q=${encodeURIComponent('周杰伦')}`, { headers: { authorization: basic } })
  const playlistHtml = await playlistSearch.text()
  assert.match(playlistHtml, /【酷狗】周杰伦精选/)
  const playlistId = playlistHtml.match(/name="id" value="(playlist:remote:[^"]+)"/)?.[1]
  assert.ok(playlistId)
  const subscribe = await fetch(`http://127.0.0.1:${gatewayPort}/playlists/subscribe`, {
    method: 'POST', redirect: 'manual', headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id: playlistId }),
  })
  assert.equal(subscribe.status, 303)

  const playlistsResponse = await fetch(`http://127.0.0.1:${gatewayPort}/rest/getPlaylists.view?${auth}`)
  const playlistsXml = await playlistsResponse.text()
  assert.match(playlistsXml, /name="本地歌单"/)
  assert.match(playlistsXml, /name="【酷狗】周杰伦精选"/)
  const playlistResponse = await fetch(`http://127.0.0.1:${gatewayPort}/rest/getPlaylist.view?${auth}&id=${encodeURIComponent(playlistId)}`)
  const playlistXml = await playlistResponse.text()
  assert.match(playlistXml, /title="【酷狗·HQ】七里香"/)
  assert.match(playlistXml, /songCount="1"/)

  const cloudPortProbe = await listen((_req, res) => res.end())
  const cloudPort = cloudPortProbe.address().port
  await close(cloudPortProbe)
  const cloudChild = spawn(process.execPath, ['src/server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(cloudPort),
      GATEWAY_USER: 'ios-user',
      GATEWAY_PASSWORD: 'ios-pass',
      NAVIDROME_URL: '',
      PROVIDERS_FILE: providerFile,
      DATA_DIR: join(scratch, 'cloud-data'),
      SOURCE_LABEL_MODE: 'prefix',
      SHOW_QUALITY_LABEL: 'true',
      ALLOW_PRIVATE_STREAMS: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => cloudChild.kill())
  await waitReady(`http://127.0.0.1:${cloudPort}/healthz`, cloudChild)

  const cloudSearch = await fetch(`http://127.0.0.1:${cloudPort}/rest/search3.view?${auth}&query=${encodeURIComponent('七里香')}&songCount=20`)
  const cloudSearchXml = await cloudSearch.text()
  assert.match(cloudSearchXml, /title="【酷狗·HQ】七里香"/)
  assert.doesNotMatch(cloudSearchXml, /七里香（本地）/)
  const cloudRemoteId = cloudSearchXml.match(/id="(remote:[^"]+)" title="【酷狗·HQ】七里香"/)?.[1]
  assert.ok(cloudRemoteId)
  const folders = await fetch(`http://127.0.0.1:${cloudPort}/rest/getMusicFolders.view?${auth}`)
  assert.match(await folders.text(), /<musicFolder id="online" name="在线音乐"/)

  const cloudStream = await fetch(`http://127.0.0.1:${cloudPort}/rest/stream.view?${auth}&id=${encodeURIComponent(cloudRemoteId)}`)
  assert.equal(cloudStream.status, 200)
  assert.equal(await cloudStream.text(), media.toString())

  const random = await fetch(`http://127.0.0.1:${cloudPort}/rest/getRandomSongs.view?${auth}&size=10`)
  assert.match(await random.text(), /<randomSongs><song[^>]+title="【酷狗·HQ】七里香"/)
  const nowPlaying = await fetch(`http://127.0.0.1:${cloudPort}/rest/getNowPlaying.view?${auth}`)
  assert.match(await nowPlaying.text(), /<nowPlaying><entry[^>]+title="【酷狗·HQ】七里香"[^>]+username="ios-user"/)
  const albums = await fetch(`http://127.0.0.1:${cloudPort}/rest/getAlbumList2.view?${auth}&type=newest`)
  assert.match(await albums.text(), /<albumList2><album[^>]+name="七里香"/)
  const recentAlbums = await fetch(`http://127.0.0.1:${cloudPort}/rest/getAlbumList2.view?${auth}&type=recent`)
  assert.match(await recentAlbums.text(), /played="[^"]+"/)
  const legacyRecentAlbums = await fetch(`http://127.0.0.1:${cloudPort}/rest/getAlbumList.view?${auth}&type=recent`)
  const legacyRecentAlbumsXml = await legacyRecentAlbums.text()
  assert.match(legacyRecentAlbumsXml, /<albumList><album[^>]+parent="[^"]+"/)
  assert.match(legacyRecentAlbumsXml, /isDir="true"/)
  assert.match(legacyRecentAlbumsXml, /title="七里香"/)
  assert.match(legacyRecentAlbumsXml, /album="七里香"/)
  const artists = await fetch(`http://127.0.0.1:${cloudPort}/rest/getArtists.view?${auth}`)
  assert.match(await artists.text(), /<artist[^>]+name="周杰伦"[^>]+playCount="1"/)
  const indexes = await fetch(`http://127.0.0.1:${cloudPort}/rest/getIndexes.view?${auth}`)
  assert.match(await indexes.text(), /<indexes[^>]+lastModified="\d+"[^>]*><index[^>]+name="#"[^>]*><artist[^>]+name="周杰伦"/)
  const topSongs = await fetch(`http://127.0.0.1:${cloudPort}/rest/getTopSongs.view?${auth}&artist=${encodeURIComponent('周杰伦')}`)
  assert.match(await topSongs.text(), /<topSongs><song[^>]+title="【酷狗·HQ】七里香"/)
  const similar = await fetch(`http://127.0.0.1:${cloudPort}/rest/getSimilarSongs.view?${auth}&id=${encodeURIComponent(cloudRemoteId)}`)
  assert.match(await similar.text(), /<similarSongs/)

  const scrobble = await fetch(`http://127.0.0.1:${cloudPort}/rest/scrobble.view?${auth}&id=${encodeURIComponent(cloudRemoteId)}&submission=true`)
  assert.match(await scrobble.text(), /status="ok"/)
  const emptySearch = await fetch(`http://127.0.0.1:${cloudPort}/rest/search3.view?${auth}&query=&songCount=21&songOffset=0`)
  const emptySearchXml = await emptySearch.text()
  assert.match(emptySearchXml, /<searchResult3>/)
  assert.match(emptySearchXml, /<song[^>]+title="【酷狗·HQ】七里香"[^>]+playCount="1"[^>]+played="[^"]+"/)
  const cloudSong = await fetch(`http://127.0.0.1:${cloudPort}/rest/getSong.view?${auth}&id=${encodeURIComponent(cloudRemoteId)}`)
  assert.match(await cloudSong.text(), /playCount="1"/)
  const systemPlaylists = await fetch(`http://127.0.0.1:${cloudPort}/rest/getPlaylists.view?${auth}`)
  const systemPlaylistsXml = await systemPlaylists.text()
  assert.match(systemPlaylistsXml, /id="system:recent" name="最近播放"/)
  assert.match(systemPlaylistsXml, /id="system:frequent" name="我的常听排行榜"/)
  assert.match(systemPlaylistsXml, /id="system:random" name="随机歌曲"/)
  assert.match(systemPlaylistsXml, /name="【酷狗】TOP500"/)
  const chartId = systemPlaylistsXml.match(/id="(playlist:remote:[^"]+)" name="【酷狗】TOP500"/)?.[1]
  assert.ok(chartId)
  const chartCoverId = systemPlaylistsXml.match(/<playlist[^>]+id="playlist:remote:[^"]+"[^>]+name="【酷狗】TOP500"[^>]+coverArt="([^"]+)"/)?.[1]
  assert.ok(chartCoverId)
  const chartCover = await fetch(`http://127.0.0.1:${cloudPort}/rest/getCoverArt.view?${auth}&id=${encodeURIComponent(chartCoverId)}`)
  assert.equal(chartCover.status, 200)
  assert.equal(chartCover.headers.get('content-type'), 'image/png')
  assert.equal(Buffer.compare(Buffer.from(await chartCover.arrayBuffer()), Buffer.from('89504e470d0a1a0a', 'hex')), 0)
  const chartPlaylist = await fetch(`http://127.0.0.1:${cloudPort}/rest/getPlaylist.view?${auth}&id=${encodeURIComponent(chartId)}`)
  assert.match(await chartPlaylist.text(), /<playlist[^>]+name="【酷狗】TOP500"[^>]*><entry[^>]+title="【酷狗·HQ】七里香"/)
  const recentPlaylist = await fetch(`http://127.0.0.1:${cloudPort}/rest/getPlaylist.view?${auth}&id=system%3Arecent`)
  assert.match(await recentPlaylist.text(), /<playlist[^>]+name="最近播放"[^>]*><entry[^>]+title="【酷狗·HQ】七里香"/)

  const createRadio = await fetch(`http://127.0.0.1:${cloudPort}/rest/createInternetRadioStation.view?${auth}&name=${encodeURIComponent('测试电台')}&streamUrl=${encodeURIComponent('https://radio.example/live.mp3')}&homepageUrl=${encodeURIComponent('https://radio.example/')}`)
  assert.match(await createRadio.text(), /status="ok"/)
  const radios = await fetch(`http://127.0.0.1:${cloudPort}/rest/getInternetRadioStations.view?${auth}`)
  const radiosXml = await radios.text()
  assert.match(radiosXml, /name="测试电台"/)
  assert.match(radiosXml, /streamUrl="https:\/\/radio.example\/live.mp3"/)
  const radioId = radiosXml.match(/id="(radio:local:[^"]+)"/)?.[1]
  assert.ok(radioId)
  const updateRadio = await fetch(`http://127.0.0.1:${cloudPort}/rest/updateInternetRadioStation.view?${auth}&id=${encodeURIComponent(radioId)}&name=${encodeURIComponent('新名称')}&streamUrl=${encodeURIComponent('https://radio.example/live.mp3')}`)
  assert.match(await updateRadio.text(), /status="ok"/)
  const deleteRadio = await fetch(`http://127.0.0.1:${cloudPort}/rest/deleteInternetRadioStation.view?${auth}&id=${encodeURIComponent(radioId)}`)
  assert.match(await deleteRadio.text(), /status="ok"/)
  const radiosAfterDelete = await fetch(`http://127.0.0.1:${cloudPort}/rest/getInternetRadioStations.view?${auth}`)
  assert.doesNotMatch(await radiosAfterDelete.text(), /测试电台|新名称/)
})

test('gateway pre-resolves the next song in the current playback context', { timeout: 10000 }, async t => {
  const media = Buffer.from('prefetch-audio')
  const resolveHits = new Map()
  let providerPort
  const provider = await listen((req, res) => {
    const url = new URL(req.url, 'http://provider.test')
    if (url.pathname === '/search') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ items: [
        { id: 'first', title: '第一首', artist: '测试歌手', album: '连续播放', source: 'kw', duration: 180, quality: '320k' },
        { id: 'second', title: '第二首', artist: '测试歌手', album: '连续播放', source: 'kw', duration: 180, quality: '320k' },
      ] }))
    }
    if (url.pathname.startsWith('/resolve/')) {
      const id = url.pathname.split('/').pop()
      resolveHits.set(id, Number(resolveHits.get(id) || 0) + 1)
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ url: `http://127.0.0.1:${providerPort}/audio/${id}` }))
    }
    if (url.pathname.startsWith('/audio/')) {
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': media.length })
      return res.end(media)
    }
    res.writeHead(404).end()
  })
  providerPort = provider.address().port
  t.after(() => close(provider))

  const scratch = await mkdtemp(join(tmpdir(), 'lx-melobridge-prefetch-test-'))
  const providerFile = join(scratch, 'providers.json')
  await writeFile(providerFile, JSON.stringify([{
    key: 'catalog', label: '目录', enabled: true, baseUrl: `http://127.0.0.1:${providerPort}`,
    searchPath: '/search', resolvePath: '/resolve/{id}', timeoutMs: 2000,
  }]))
  const probe = await listen((_req, res) => res.end())
  const port = probe.address().port
  await close(probe)
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env, PORT: String(port), GATEWAY_USER: 'ios-user', GATEWAY_PASSWORD: 'ios-pass',
      NAVIDROME_URL: '', PROVIDERS_FILE: providerFile, DATA_DIR: scratch,
      ALLOW_PRIVATE_STREAMS: 'true', PREFETCH_NEXT_TRACKS: '1', PREFETCH_CONCURRENCY: '1',
      RESOLVE_CACHE_TTL_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => child.kill())
  await waitReady(`http://127.0.0.1:${port}/healthz`, child)
  const auth = 'u=ios-user&p=ios-pass&v=1.16.1&c=queue-test&f=xml'
  const search = await fetch(`http://127.0.0.1:${port}/rest/search3.view?${auth}&query=${encodeURIComponent('连续播放')}&songCount=20`)
  const xml = await search.text()
  const firstId = xml.match(/id="(remote:[^"]+)" title="【酷我·HQ】第一首"/)?.[1]
  const secondId = xml.match(/id="(remote:[^"]+)" title="【酷我·HQ】第二首"/)?.[1]
  assert.ok(firstId)
  assert.ok(secondId)

  const first = await fetch(`http://127.0.0.1:${port}/rest/stream.view?${auth}&id=${encodeURIComponent(firstId)}`)
  assert.equal(await first.text(), media.toString())
  await waitUntil(() => resolveHits.get('second') === 1)
  const second = await fetch(`http://127.0.0.1:${port}/rest/stream.view?${auth}&id=${encodeURIComponent(secondId)}`)
  assert.equal(await second.text(), media.toString())
  assert.equal(resolveHits.get('second'), 1)
  const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()
  assert.ok(health.onlineResolution.completed >= 1)
})

test('gateway refreshes an expired cached media URL once', { timeout: 10000 }, async t => {
  const media = Buffer.from('refreshed-audio')
  let resolveHits = 0
  let refreshHits = 0
  let providerPort
  const provider = await listen((req, res) => {
    const url = new URL(req.url, 'http://provider.test')
    if (url.pathname === '/search') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ items: [{ id: 'stale', title: '失效地址', artist: '测试歌手', source: 'kw', duration: 180, quality: '320k' }] }))
    }
    if (url.pathname === '/resolve/stale') {
      resolveHits++
      const refreshed = url.searchParams.get('refresh') === 'true'
      if (refreshed) refreshHits++
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ url: `http://127.0.0.1:${providerPort}/${refreshed ? 'audio' : 'expired'}` }))
    }
    if (url.pathname === '/expired') return res.writeHead(403).end('expired')
    if (url.pathname === '/audio') {
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': media.length })
      return res.end(media)
    }
    res.writeHead(404).end()
  })
  providerPort = provider.address().port
  t.after(() => close(provider))

  const scratch = await mkdtemp(join(tmpdir(), 'lx-melobridge-refresh-test-'))
  const providerFile = join(scratch, 'providers.json')
  await writeFile(providerFile, JSON.stringify([{
    key: 'catalog', label: '目录', enabled: true, baseUrl: `http://127.0.0.1:${providerPort}`,
    searchPath: '/search', resolvePath: '/resolve/{id}', timeoutMs: 2000,
  }]))
  const probe = await listen((_req, res) => res.end())
  const port = probe.address().port
  await close(probe)
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env, PORT: String(port), GATEWAY_USER: 'ios-user', GATEWAY_PASSWORD: 'ios-pass',
      NAVIDROME_URL: '', PROVIDERS_FILE: providerFile, DATA_DIR: scratch, ALLOW_PRIVATE_STREAMS: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => child.kill())
  await waitReady(`http://127.0.0.1:${port}/healthz`, child)
  const auth = 'u=ios-user&p=ios-pass&v=1.16.1&c=refresh-test&f=xml'
  const search = await fetch(`http://127.0.0.1:${port}/rest/search3.view?${auth}&query=${encodeURIComponent('失效地址')}&songCount=10`)
  const id = (await search.text()).match(/id="(remote:[^"]+)" title="【酷我·HQ】失效地址"/)?.[1]
  assert.ok(id)
  const stream = await fetch(`http://127.0.0.1:${port}/rest/stream.view?${auth}&id=${encodeURIComponent(id)}`)
  assert.equal(stream.status, 200)
  assert.equal(await stream.text(), media.toString())
  assert.equal(resolveHits, 2)
  assert.equal(refreshHits, 1)
})

async function waitUntil(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for background prefetch')
}

async function waitReady(url, child) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode != null) throw new Error(`Gateway exited with code ${child.exitCode}`)
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('Gateway did not become ready')
}
