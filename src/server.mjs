import { createServer } from 'node:http'
import { config, loadProviders } from './config.mjs'
import { injectXmlNodes, normalizeArray, parseRemoteAlbumId, parseRemoteArtistId, parseRemotePlaylistId, parseRemoteSongId, remoteCoverId } from './codec.mjs'
import { proxyMedia } from './network.mjs'
import { ProviderRegistry, subsonicPlaylist, subsonicTrack } from './providers.mjs'
import { parseSearchQuery } from './search-query.mjs'
import { GatewayState } from './state.mjs'
import {
  SERVER_VERSION, fetchNavidrome, proxyNavidrome, root,
  sendError, sendJson, sendSubsonic, sendText, sendXml, verifyAuth,
} from './subsonic.mjs'

const providers = new ProviderRegistry(await loadProviders(), config.sourceLabelMode, config.showQualityLabel, config.onlinePlaybackQuality, {
  resolveCacheTtlMs: config.resolveCacheTtlMs,
  prefetchConcurrency: config.prefetchConcurrency,
})
const state = new GatewayState(config.dataDir)
await state.load()
const playbackContexts = new Map()

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    if (url.pathname === '/healthz') {
      return sendJson(res, 200, {
        ok: true,
        version: SERVER_VERSION,
        navidromeConfigured: Boolean(config.navidromeUrl),
        onlinePlaybackQuality: config.onlinePlaybackQuality,
        onlineFavorites: state.favoriteSongs().length,
        onlineFavoriteAlbums: state.favoriteAlbumItems().length,
        onlineFavoriteArtists: state.favoriteArtistItems().length,
        onlinePlaylists: state.subscribedPlaylists().length,
        recordedOnlineSongs: state.recentSongs(5000).length,
        radioStations: state.radioStations().length,
        onlineResolution: providers.resolutionStatus(),
        providers: providers.listStatus(),
      })
    }
    if (url.pathname === '/playlists' && req.method === 'GET') return await playlistPage(req, res, url)
    if (url.pathname === '/playlists/subscribe' && req.method === 'POST') return await subscribePlaylist(req, res)
    if (url.pathname === '/playlists/refresh' && req.method === 'POST') return await refreshPlaylist(req, res)
    if (url.pathname === '/playlists/unsubscribe' && req.method === 'POST') return await unsubscribePlaylist(req, res)
    if (url.pathname === '/radios' && req.method === 'GET') return radioPage(req, res)
    if (url.pathname === '/radios/add' && req.method === 'POST') return await addRadio(req, res)
    if (url.pathname === '/radios/delete' && req.method === 'POST') return await removeRadio(req, res)
    if (url.pathname === '/') return home(res)
    if (!url.pathname.startsWith('/rest/')) return sendText(res, 404, 'Not found')

    const action = url.pathname.slice('/rest/'.length).replace(/\.view$/, '')
    const format = (url.searchParams.get('f') || 'xml').toLowerCase()
    console.log(`${new Date().toISOString()} ${req.method} ${action} f=${format}${logDetails(url.searchParams)}`)
    if (!verifyAuth(url.searchParams)) return sendError(res, format, 40, 'Wrong username or password')

    switch (action) {
      case 'ping':
        return sendSubsonic(res, format)
      case 'getLicense':
        return sendSubsonic(res, format, { license: { valid: true } })
      case 'search2':
      case 'search3':
        return await search(req, res, url, action, format)
      case 'stream':
      case 'download':
        return await stream(req, res, url, format)
      case 'getCoverArt':
        return await cover(req, res, url, format)
      case 'getSong':
        return getSong(req, res, url, format)
      case 'star':
      case 'unstar':
        return await favorite(req, res, url, action, format)
      case 'getStarred':
      case 'getStarred2':
        return await starred(req, res, url, action, format)
      case 'getPlaylists':
        return await getPlaylists(req, res, format)
      case 'getPlaylist':
        return await getPlaylist(req, res, url, format)
      case 'deletePlaylist':
        return await deletePlaylist(req, res, url, format)
      case 'getArtist':
        return await getArtist(req, res, url, format)
      case 'getAlbum':
        return await getAlbum(req, res, url, format)
      case 'getArtistInfo':
      case 'getArtistInfo2':
        if (parseRemoteArtistId(url.searchParams.get('id'))) return sendSubsonic(res, format, { [action === 'getArtistInfo2' ? 'artistInfo2' : 'artistInfo']: { biography: '', similarArtist: [] } })
        return config.navidromeUrl ? proxyNavidrome(req, res) : sendSubsonic(res, format, { [action === 'getArtistInfo2' ? 'artistInfo2' : 'artistInfo']: { biography: '', similarArtist: [] } })
      case 'getAlbumInfo':
      case 'getAlbumInfo2':
        if (parseRemoteAlbumId(url.searchParams.get('id'))) return sendSubsonic(res, format, { [action === 'getAlbumInfo2' ? 'albumInfo2' : 'albumInfo']: { notes: '', musicBrainzId: '', genres: [] } })
        return config.navidromeUrl ? proxyNavidrome(req, res) : sendSubsonic(res, format, { [action === 'getAlbumInfo2' ? 'albumInfo2' : 'albumInfo']: { notes: '', musicBrainzId: '', genres: [] } })
      case 'getSimilarSongs':
      case 'getSimilarSongs2':
        return await similarSongs(req, res, url, action, format)
      case 'getLyrics':
        return await getLyrics(req, res, url, format, false)
      case 'getLyricsBySongId':
        return await getLyrics(req, res, url, format, true)
      case 'getOpenSubsonicExtensions':
        return sendSubsonic(res, format, { openSubsonicExtensions: { openSubsonicExtension: [{ name: 'songLyrics', versions: [1] }] } })
      case 'scrobble':
        return await scrobble(req, res, url, format)
      case 'savePlayQueue':
        return savePlayQueue(req, res, url, format)
      case 'getPlayQueue':
        return getPlayQueue(req, res, url, format)
      case 'getAlbumList':
      case 'getAlbumList2':
        return await getAlbumList(req, res, url, action, format)
      case 'getRandomSongs':
        return await getRandomSongs(req, res, url, format)
      case 'getNowPlaying':
        return await getNowPlaying(req, res, url, format)
      case 'getTopSongs':
        return await getTopSongs(req, res, url, format)
      case 'getInternetRadioStations':
        return await getInternetRadioStations(req, res, format)
      case 'createInternetRadioStation':
      case 'updateInternetRadioStation':
      case 'deleteInternetRadioStation':
        return await changeInternetRadioStation(req, res, url, action, format)
      case 'getIndexes':
        return await getIndexes(req, res, format)
      case 'getArtists':
        return await getArtists(req, res, format)
      case 'getMusicFolders':
        return config.navidromeUrl ? proxyNavidrome(req, res) : sendSubsonic(res, format, { musicFolders: { musicFolder: [{ id: 'online', name: '在线音乐' }] } })
      case 'getGenres':
      case 'getSongsByGenre':
      case 'getScanStatus':
      case 'getUser':
      case 'getVideos':
      case 'getShares':
      case 'getBookmarks':
      case 'getPodcasts':
      case 'getNewestPodcasts':
        return config.navidromeUrl ? proxyNavidrome(req, res) : emptyLibrary(res, format, action)
      default:
        return config.navidromeUrl ? proxyNavidrome(req, res) : sendError(res, format, 0, `Unsupported action: ${action}`)
    }
  } catch (error) {
    console.error(error)
    if (!res.headersSent) sendText(res, 500, `Gateway error: ${error.message}`)
    else res.destroy(error)
  }
})

function emptyLibrary(res, format, action) {
  const payloads = {
    getMusicFolders: { musicFolders: { musicFolder: [] } },
    getIndexes: { indexes: { lastModified: 0, ignoredArticles: '', index: [], child: [] } },
    getArtists: { artists: { ignoredArticles: '', index: [] } },
    getAlbumList: { albumList: { album: [] } },
    getAlbumList2: { albumList2: { album: [] } },
    getRandomSongs: { randomSongs: { song: [] } },
    getGenres: { genres: { genre: [] } },
    getSongsByGenre: { songsByGenre: { song: [] } },
    getNowPlaying: { nowPlaying: { entry: [] } },
    getScanStatus: { scanStatus: { scanning: false, count: 0 } },
    getUser: { user: {
      username: config.gatewayUser,
      scrobblingEnabled: true,
      adminRole: false,
      settingsRole: false,
      downloadRole: true,
      uploadRole: false,
      playlistRole: true,
      coverArtRole: true,
      commentRole: false,
      podcastRole: false,
      streamRole: true,
      jukeboxRole: false,
      shareRole: false,
      videoConversionRole: false,
      folder: [],
    } },
    getInternetRadioStations: { internetRadioStations: { internetRadioStation: [] } },
    getVideos: { videos: { video: [] } },
    getShares: { shares: { share: [] } },
    getBookmarks: { bookmarks: { bookmark: [] } },
    getPlayQueue: { playQueue: { entry: [] } },
    getTopSongs: { topSongs: { song: [] } },
    getPodcasts: { podcasts: { channel: [] } },
    getNewestPodcasts: { newestPodcasts: { episode: [] } },
  }
  return sendSubsonic(res, format, payloads[action] || {})
}

server.listen(config.port, '0.0.0.0', () => {
  console.log(`lx-melobridge ${SERVER_VERSION} listening on http://0.0.0.0:${config.port}`)
  console.log(`Navidrome: ${config.navidromeUrl || '(not configured)'}`)
  console.log(`Enabled providers: ${providers.listStatus().filter(item => item.enabled).map(item => item.key).join(', ') || '(none)'}`)
})

async function search(req, res, url, action, format) {
  const resultKey = action === 'search3' ? 'searchResult3' : 'searchResult2'
  const rawQuery = (url.searchParams.get('query') || url.searchParams.get('any') || '').trim()
  const selection = parseSearchQuery(rawQuery)
  const query = selection.query
  const songOffset = nonNegative(url.searchParams.get('songOffset'), 0)
  const artistOffset = nonNegative(url.searchParams.get('artistOffset'), 0)
  const albumOffset = nonNegative(url.searchParams.get('albumOffset'), 0)
  const songCount = boundedCount(url.searchParams.get('songCount'), 20)
  const artistCount = boundedCount(url.searchParams.get('artistCount'), 20)
  const albumCount = boundedCount(url.searchParams.get('albumCount'), 20)
  const fetchLimit = Math.max(1, Math.min(config.maxSearchItemsPerProvider, Math.max(
    songOffset + songCount,
    artistOffset + artistCount * 3,
    albumOffset + albumCount * 3,
  )))

  const [upstreamResult, providerTracks] = await Promise.all([
    config.navidromeUrl ? fetchNavidrome(req.url, req.headers).catch(error => {
      console.warn(`Navidrome search failed: ${error.message}`)
      return null
    }) : null,
    query ? providers.searchAll(query, 0, fetchLimit, selection) : [],
  ])
  const onlineTracks = query ? providerTracks : allKnownSongs(fetchLimit)
  state.remember(onlineTracks)
  if (onlineTracks.length) await state.save()
  const visibleTracks = onlineTracks.slice(songOffset, songOffset + songCount)
  rememberPlaybackContext(url, visibleTracks)
  const onlineSongs = visibleTracks.map(withFavorite).map(subsonicTrack)
  const entities = searchEntities(onlineTracks)
  const onlineArtists = entities.artist.slice(artistOffset, artistOffset + artistCount)
  const onlineAlbums = entities.album.slice(albumOffset, albumOffset + albumCount)

  if (!upstreamResult) {
    return sendSubsonic(res, format, { [resultKey]: { artist: onlineArtists, album: onlineAlbums, song: onlineSongs } })
  }
  if (format === 'json') {
    const parsed = JSON.parse(upstreamResult.body.toString('utf8'))
    const responseRoot = parsed['subsonic-response'] || parsed.subsonicResponse
    if (!responseRoot || responseRoot.status !== 'ok') return sendJson(res, upstreamResult.status, parsed)
    responseRoot[resultKey] ||= {}
    responseRoot[resultKey].artist = normalizeArray(responseRoot[resultKey].artist)
    responseRoot[resultKey].artist.push(...onlineArtists)
    responseRoot[resultKey].album = normalizeArray(responseRoot[resultKey].album)
    responseRoot[resultKey].album.push(...onlineAlbums)
    responseRoot[resultKey].song = normalizeArray(responseRoot[resultKey].song)
    responseRoot[resultKey].song.push(...onlineSongs)
    responseRoot.type = 'lx-melobridge'
    responseRoot.serverVersion = SERVER_VERSION
    return sendJson(res, 200, parsed)
  }
  let xml = injectXmlNodes(upstreamResult.body.toString('utf8'), resultKey, 'artist', onlineArtists)
  xml = injectXmlNodes(xml, resultKey, 'album', onlineAlbums)
  xml = injectXmlNodes(xml, resultKey, 'song', onlineSongs)
  return sendXml(res, 200, xml)
}

function allKnownSongs(limit) {
  const tracks = new Map()
  for (const track of state.recentSongs(limit)) tracks.set(track.id, track)
  for (const track of state.discoverySongs()) {
    if (tracks.size >= limit) break
    if (!tracks.has(track.id)) tracks.set(track.id, track)
  }
  return [...tracks.values()]
}

function searchEntities(tracks) {
  const albumGroups = new Map()
  for (const track of tracks) {
    if (!albumGroups.has(track.albumId)) albumGroups.set(track.albumId, [])
    albumGroups.get(track.albumId).push(track)
  }
  const album = [...albumGroups.entries()].map(([id, items]) => {
    const first = items[0]
    return withAlbumFavorite(albumSummary(id, first.album, first.artist, first.artistId, items))
  })
  const artistGroups = new Map()
  for (const track of tracks) {
    if (!artistGroups.has(track.artistId)) artistGroups.set(track.artistId, { id: track.artistId, name: track.artist, albums: new Set(), coverArt: track.coverArt })
    artistGroups.get(track.artistId).albums.add(track.albumId)
  }
  const artist = [...artistGroups.values()].map(item => ({
    id: item.id,
    name: item.name,
    albumCount: item.albums.size,
    ...(item.coverArt ? { coverArt: item.coverArt } : {}),
  })).map(withArtistFavorite)
  return { artist, album }
}

async function getAlbumList(req, res, url, action, format) {
  const type = String(url.searchParams.get('type') || 'newest').toLowerCase().replaceAll(/[^a-z]/g, '')
  const size = boundedListCount(url.searchParams.get('size'), 10)
  const offset = nonNegative(url.searchParams.get('offset'), 0)
  let tracks
  if (type === 'recent' || type === 'recentlyplayed') tracks = state.recentSongs(2000)
  else if (['frequent', 'highest', 'mostplayed'].includes(type)) tracks = state.frequentSongs(2000)
  else if (type === 'starred') tracks = state.favoriteSongs()
  else tracks = state.discoverySongs()

  const groups = new Map()
  for (const track of tracks) {
    if (!groups.has(track.albumId)) groups.set(track.albumId, [])
    groups.get(track.albumId).push(track)
  }
  let albums = [...groups.entries()].map(([id, items]) => {
    const first = items[0]
    const plays = items.map(track => state.playback(track.id)).filter(Boolean)
    const played = plays.map(play => play.lastPlayed).filter(Boolean).sort().at(-1)
    const playCount = plays.reduce((sum, play) => sum + Number(play.playCount || 0), 0)
    const starred = state.favoriteAlbums.get(id)?.starred || items.map(track => state.favorites.get(track.id)?.starred).filter(Boolean).sort()[0]
    return {
      ...albumSummary(id, first.album, first.artist, first.artistId, items),
      ...(played ? { played } : {}),
      ...(playCount ? { playCount } : {}),
      ...(starred ? { starred } : {}),
    }
  })
  if (type === 'starred') {
    const knownIds = new Set(albums.map(album => album.id))
    for (const album of state.favoriteAlbumItems()) if (!knownIds.has(album.id)) albums.push(album)
  }

  if (type === 'random') shuffle(albums)
  else if (type === 'alphabeticalByName') albums.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
  else if (type === 'alphabeticalByArtist') albums.sort((left, right) => left.artist.localeCompare(right.artist, 'zh-CN'))
  else if (['frequent', 'highest', 'mostplayed'].includes(type)) albums.sort((left, right) => Number(right.playCount || 0) - Number(left.playCount || 0))
  else if (type === 'starred') albums.sort((left, right) => String(right.starred || '').localeCompare(String(left.starred || '')))
  else if (type === 'recent' || type === 'recentlyplayed') albums.sort((left, right) => String(right.played || '').localeCompare(String(left.played || '')))
  else albums.sort((left, right) => String(right.created || '').localeCompare(String(left.created || '')))

  const rootKey = action === 'getAlbumList2' ? 'albumList2' : 'albumList'
  const selected = albums.slice(offset, offset + size).map(album => action === 'getAlbumList'
    ? { ...album, parent: album.artistId || 'online', isDir: true, title: album.name, album: album.name, type: 'album' }
    : album)
  return mergeOnlineCollection(req, res, format, rootKey, 'album', selected)
}

async function getRandomSongs(req, res, url, format) {
  const size = boundedListCount(url.searchParams.get('size'), 10)
  const genre = String(url.searchParams.get('genre') || '').trim().toLowerCase()
  const fromYear = Number(url.searchParams.get('fromYear') || 0)
  const toYear = Number(url.searchParams.get('toYear') || 0)
  let songs = state.discoverySongs().filter(track =>
    (!genre || String(track.genre || '').toLowerCase() === genre) &&
    (!fromYear || Number(track.year || 0) >= fromYear) &&
    (!toYear || Number(track.year || 0) <= toYear))
  shuffle(songs)
  songs = songs.slice(0, size)
  rememberPlaybackContext(url, songs)
  songs = songs.map(withFavorite).map(subsonicTrack)
  return mergeOnlineCollection(req, res, format, 'randomSongs', 'song', songs)
}

async function getNowPlaying(req, res, _url, format) {
  const now = Date.now()
  const entries = state.nowPlayingSongs().map(activity => ({
    ...subsonicTrack(withFavorite(activity.track)),
    username: activity.username || config.gatewayUser,
    minutesAgo: Math.max(0, Math.floor((now - activity.startedAt) / 60000)),
    playerId: 0,
    ...(activity.client ? { playerName: activity.client } : {}),
  }))
  return mergeOnlineCollection(req, res, format, 'nowPlaying', 'entry', entries)
}

async function getTopSongs(req, res, url, format) {
  const artist = String(url.searchParams.get('artist') || '').trim()
  const count = boundedListCount(url.searchParams.get('count'), 50)
  let tracks = state.discoverySongs().filter(track => sameText(track.artist, artist))
  if (artist && tracks.length < count) {
    state.remember(await providers.searchAll(artist, 0, Math.min(count, config.maxSearchItemsPerProvider)))
    tracks = state.discoverySongs().filter(track => sameText(track.artist, artist))
  }
  tracks.sort((left, right) => Number(state.playback(right.id)?.playCount || 0) - Number(state.playback(left.id)?.playCount || 0))
  tracks = tracks.slice(0, count)
  rememberPlaybackContext(url, tracks)
  const songs = tracks.map(withFavorite).map(subsonicTrack)
  return mergeOnlineCollection(req, res, format, 'topSongs', 'song', songs)
}

async function getArtists(req, res, format) {
  return mergeOnlineIndexes(req, res, format, 'artists', onlineArtistIndexes())
}

async function getIndexes(req, res, format) {
  return mergeOnlineIndexes(req, res, format, 'indexes', onlineArtistIndexes())
}

function onlineArtistIndexes() {
  const groups = new Map()
  for (const track of state.discoverySongs()) {
    if (!groups.has(track.artistId)) groups.set(track.artistId, {
      id: track.artistId,
      name: track.artist,
      albums: new Set(),
      coverArt: track.coverArt,
      playCount: 0,
      played: '',
    })
    const artist = groups.get(track.artistId)
    artist.albums.add(track.albumId)
    if (!artist.coverArt && track.coverArt) artist.coverArt = track.coverArt
    const playback = state.playback(track.id)
    artist.playCount += Number(playback?.playCount || 0)
    if (playback?.lastPlayed && playback.lastPlayed > artist.played) artist.played = playback.lastPlayed
  }
  const indexed = new Map()
  for (const value of groups.values()) {
    const key = /^[a-z]/i.test(value.name) ? value.name[0].toUpperCase() : '#'
    if (!indexed.has(key)) indexed.set(key, [])
    indexed.get(key).push({
      id: value.id,
      name: value.name,
      albumCount: value.albums.size,
      ...(value.coverArt ? { coverArt: value.coverArt } : {}),
      ...(value.playCount ? { playCount: value.playCount } : {}),
      ...(value.played ? { played: value.played } : {}),
    })
  }
  return [...indexed.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))
    .map(([name, artist]) => ({ name, artist: artist.sort((left, right) =>
      Number(right.playCount || 0) - Number(left.playCount || 0) || left.name.localeCompare(right.name, 'zh-CN')) }))
}

async function similarSongs(req, res, url, action, format) {
  const id = url.searchParams.get('id') || ''
  const songId = parseRemoteSongId(id)
  const song = songId ? state.get(id) : null
  const artist = parseRemoteArtistId(id)
  const album = parseRemoteAlbumId(id)
  const parsed = song
    ? { name: song.artist, providerKey: song.providerKey, source: song.sourceCode }
    : artist || (album ? { ...album, name: album.artist || album.name } : null)
  if (songId && !song) {
    const rootKey = action === 'getSimilarSongs2' ? 'similarSongs2' : 'similarSongs'
    return sendSubsonic(res, format, { [rootKey]: { song: [] } })
  }
  if (!parsed) {
    return config.navidromeUrl
      ? proxyNavidrome(req, res)
      : sendSubsonic(res, format, { [action === 'getSimilarSongs2' ? 'similarSongs2' : 'similarSongs']: { song: [] } })
  }
  const count = boundedListCount(url.searchParams.get('count'), 50)
  const found = await providers.searchAll(parsed.name || parsed.artist, 0, Math.min(count + 1, config.maxSearchItemsPerProvider), {
    provider: parsed.providerKey,
    source: parsed.source,
  })
  state.remember(found)
  const tracks = found.filter(track => track.id !== id && track.id !== song?.id).slice(0, count)
  rememberPlaybackContext(url, tracks)
  const songs = tracks.map(withFavorite).map(subsonicTrack)
  const rootKey = action === 'getSimilarSongs2' ? 'similarSongs2' : 'similarSongs'
  return sendSubsonic(res, format, { [rootKey]: { song: songs } })
}

async function scrobble(req, res, url, format) {
  const ids = url.searchParams.getAll('id')
  const times = url.searchParams.getAll('time')
  const submissions = url.searchParams.getAll('submission')
  const client = String(url.searchParams.get('c') || '')
  const username = String(url.searchParams.get('u') || config.gatewayUser)
  const local = []
  for (let index = 0; index < ids.length; index++) {
    const id = ids[index]
    if (!parseRemoteSongId(id)) {
      local.push({ id, time: times[index] })
      continue
    }
    const rawSubmission = submissions[index] ?? submissions[0] ?? 'true'
    await state.scrobble(id, {
      submission: !['false', '0'].includes(String(rawSubmission).toLowerCase()),
      time: times[index],
      client,
      username,
    })
  }
  if (!local.length || !config.navidromeUrl) return sendSubsonic(res, format)
  const forwarded = new URL(req.url, 'http://gateway.local')
  forwarded.searchParams.delete('id')
  forwarded.searchParams.delete('time')
  for (const item of local) {
    forwarded.searchParams.append('id', item.id)
    if (item.time) forwarded.searchParams.append('time', item.time)
  }
  return proxyNavidrome(req, res, `${forwarded.pathname}${forwarded.search}`)
}

function savePlayQueue(req, res, url, format) {
  const ids = url.searchParams.getAll('id')
  const tracks = ids.map(id => state.get(id)).filter(Boolean)
  if (!tracks.length) return config.navidromeUrl ? proxyNavidrome(req, res) : sendSubsonic(res, format)
  rememberPlaybackContext(url, tracks, {
    current: String(url.searchParams.get('current') || tracks[0].id),
    position: nonNegative(url.searchParams.get('position'), 0),
    changed: new Date().toISOString(),
  })
  return sendSubsonic(res, format)
}

function getPlayQueue(req, res, url, format) {
  const context = newestPlaybackContext(url)
  if (!context) return config.navidromeUrl ? proxyNavidrome(req, res) : sendSubsonic(res, format, { playQueue: { entry: [] } })
  const entry = context.ids.map(id => state.get(id)).filter(Boolean).map(withFavorite).map(subsonicTrack)
  return sendSubsonic(res, format, { playQueue: {
    current: context.current || entry[0]?.id,
    position: context.position || 0,
    username: String(url.searchParams.get('u') || config.gatewayUser),
    changed: context.changed,
    changedBy: String(url.searchParams.get('c') || 'lx-melobridge'),
    entry,
  } })
}

function playbackContextKey(url) {
  return `${String(url.searchParams.get('u') || config.gatewayUser)}\n${String(url.searchParams.get('c') || '')}`
}

function rememberPlaybackContext(url, tracks, metadata = {}) {
  const ids = [...new Set(tracks.map(track => track?.id).filter(id => parseRemoteSongId(id)))]
  if (!ids.length) return
  prunePlaybackContexts()
  const key = playbackContextKey(url)
  const contexts = playbackContexts.get(key) || []
  const signature = ids.join('\n')
  const remaining = contexts.filter(context => context.ids.join('\n') !== signature)
  remaining.unshift({
    ids,
    current: metadata.current || null,
    position: metadata.position || 0,
    changed: metadata.changed || new Date().toISOString(),
    expiresAt: Date.now() + config.playbackContextTtlMs,
  })
  playbackContexts.set(key, remaining.slice(0, 6))
}

function newestPlaybackContext(url) {
  prunePlaybackContexts()
  return playbackContexts.get(playbackContextKey(url))?.[0] || null
}

function playbackContextNext(url, currentId, count) {
  prunePlaybackContexts()
  const contexts = playbackContexts.get(playbackContextKey(url)) || []
  const context = contexts.find(item => item.ids.includes(currentId))
  if (!context) return []
  context.current = currentId
  context.position = 0
  context.changed = new Date().toISOString()
  context.expiresAt = Date.now() + config.playbackContextTtlMs
  const index = context.ids.indexOf(currentId)
  return context.ids.slice(index + 1, index + 1 + count).map(id => state.get(id)).filter(Boolean)
}

function prunePlaybackContexts() {
  const now = Date.now()
  for (const [key, contexts] of playbackContexts.entries()) {
    const active = contexts.filter(context => context.expiresAt > now)
    if (active.length) playbackContexts.set(key, active)
    else playbackContexts.delete(key)
  }
}

async function getInternetRadioStations(req, res, format) {
  return mergeOnlineCollection(req, res, format, 'internetRadioStations', 'internetRadioStation', state.radioStations())
}

async function changeInternetRadioStation(req, res, url, action, format) {
  const id = String(url.searchParams.get('id') || '')
  if (action === 'deleteInternetRadioStation') {
    if (id.startsWith('radio:local:')) {
      await state.deleteRadio(id)
      return sendSubsonic(res, format)
    }
    return config.navidromeUrl ? proxyNavidrome(req, res) : sendError(res, format, 70, 'Radio station not found')
  }
  if (action === 'updateInternetRadioStation' && !id.startsWith('radio:local:')) {
    return config.navidromeUrl ? proxyNavidrome(req, res) : sendError(res, format, 70, 'Radio station not found')
  }
  const values = radioValues(url.searchParams)
  if (!values.ok) return sendError(res, format, 10, values.error)
  if (action === 'createInternetRadioStation') await state.createRadio(values.radio)
  else if (!await state.updateRadio(id, values.radio)) return sendError(res, format, 70, 'Radio station not found')
  return sendSubsonic(res, format)
}

async function mergeOnlineCollection(req, res, format, rootKey, itemKey, online) {
  const upstream = config.navidromeUrl ? await fetchNavidrome(req.url, req.headers).catch(error => {
    console.warn(`Navidrome ${rootKey} failed: ${error.message}`)
    return null
  }) : null
  if (!upstream) return sendSubsonic(res, format, { [rootKey]: { [itemKey]: online } })
  if (format === 'json') {
    const parsed = JSON.parse(upstream.body.toString('utf8'))
    const responseRoot = parsed['subsonic-response'] || parsed.subsonicResponse
    if (!responseRoot || responseRoot.status !== 'ok') return sendJson(res, upstream.status, parsed)
    responseRoot[rootKey] ||= {}
    responseRoot[rootKey][itemKey] = normalizeArray(responseRoot[rootKey][itemKey])
    responseRoot[rootKey][itemKey].push(...online)
    responseRoot.type = 'lx-melobridge'
    responseRoot.serverVersion = SERVER_VERSION
    return sendJson(res, 200, parsed)
  }
  return sendXml(res, 200, injectXmlNodes(upstream.body.toString('utf8'), rootKey, itemKey, online))
}

async function mergeOnlineIndexes(req, res, format, rootKey, indexes) {
  const upstream = config.navidromeUrl ? await fetchNavidrome(req.url, req.headers).catch(error => {
    console.warn(`Navidrome ${rootKey} failed: ${error.message}`)
    return null
  }) : null
  if (!upstream) return sendSubsonic(res, format, {
    [rootKey]: {
      ignoredArticles: '',
      ...(rootKey === 'indexes' ? { lastModified: Date.now(), child: [] } : {}),
      index: indexes,
    },
  })
  if (format === 'json') {
    const parsed = JSON.parse(upstream.body.toString('utf8'))
    const responseRoot = parsed['subsonic-response'] || parsed.subsonicResponse
    if (!responseRoot || responseRoot.status !== 'ok') return sendJson(res, upstream.status, parsed)
    responseRoot[rootKey] ||= {}
    responseRoot[rootKey].index = normalizeArray(responseRoot[rootKey].index)
    responseRoot[rootKey].index.push(...indexes)
    responseRoot.type = 'lx-melobridge'
    responseRoot.serverVersion = SERVER_VERSION
    return sendJson(res, 200, parsed)
  }
  return sendXml(res, 200, injectXmlNodes(upstream.body.toString('utf8'), rootKey, 'index', indexes))
}

function radioValues(params) {
  const name = String(params.get('name') || '').trim()
  const streamUrl = String(params.get('streamUrl') || '').trim()
  const homePageUrl = String(params.get('homepageUrl') || params.get('homePageUrl') || '').trim()
  if (!name) return { ok: false, error: 'Radio name is required' }
  try {
    const parsed = new URL(streamUrl)
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error()
    if (homePageUrl) {
      const page = new URL(homePageUrl)
      if (!['http:', 'https:'].includes(page.protocol)) throw new Error()
    }
  } catch {
    return { ok: false, error: 'Radio URL must use http or https' }
  }
  return { ok: true, radio: { name, streamUrl, homePageUrl } }
}

function sameText(left, right) {
  const normalize = value => String(value || '').replaceAll(/\s+/g, '').toLowerCase()
  return normalize(left) === normalize(right)
}

function shuffle(values) {
  for (let index = values.length - 1; index > 0; index--) {
    const swap = Math.floor(Math.random() * (index + 1))
    ;[values[index], values[swap]] = [values[swap], values[index]]
  }
  return values
}

async function stream(req, res, url, format) {
  const id = url.searchParams.get('id')
  const parsed = parseRemoteSongId(id)
  if (!parsed) return config.navidromeUrl ? proxyNavidrome(req, res) : sendError(res, format, 70, 'Song not found')
  const track = state.get(id)
  if (!track) return sendError(res, format, 70, 'Online metadata expired; search for the song again')
  let resolved
  try {
    resolved = await providers.resolve(track, { refresh: url.searchParams.get('refresh') === 'true' })
  } catch (error) {
    console.error(`[Online stream failed] title="${track.rawTitle}" artist="${track.artist}" source=${track.sourceCode || 'unknown'} quality=${track.quality || 'unknown'}: ${error.message}`)
    throw error
  }
  console.log(`[Online stream resolved] title="${track.rawTitle}" artist="${track.artist}" requestedSource=${track.sourceCode || 'unknown'} resolvedSource=${resolved.resolvedSource || track.sourceCode || 'unknown'} quality=${track.quality || 'unknown'} provider=${track.providerKey}`)
  const nextTracks = playbackContextNext(url, id, config.prefetchNextTracks)
  if (nextTracks.length) {
    providers.prefetch(nextTracks)
    console.log(`[Online prefetch queued] current="${track.rawTitle}" next=${nextTracks.map(item => `"${item.rawTitle}"`).join(', ')}`)
  }
  if (req.method !== 'HEAD' && url.pathname.includes('/stream')) {
    const range = String(req.headers.range || '')
    await state.recordStream(
      id,
      String(url.searchParams.get('c') || ''),
      String(url.searchParams.get('u') || config.gatewayUser),
      !range || /^bytes=0-/i.test(range),
    )
  }
  return proxyMedia(req, res, resolved.url, resolved.headers, {
    allowPrivate: config.allowPrivateStreams,
    timeoutMs: 30000,
    refresh: async status => {
      console.warn(`[Online media URL expired] title="${track.rawTitle}" status=${status}; resolving again`)
      return providers.resolve(track, { refresh: true })
    },
  })
}

async function cover(req, res, url, format) {
  const coverId = url.searchParams.get('id') || ''
  if (coverId.startsWith('cover:playlist:remote:')) {
    const playlistId = coverId.slice('cover:'.length)
    const playlist = state.getPlaylist(playlistId) || providers.cachedChart(playlistId)
    if (!playlist?.coverUrl) return sendError(res, format, 70, 'Cover not found')
    return proxyMedia(req, res, playlist.coverUrl, {}, { allowPrivate: config.allowPrivateStreams, timeoutMs: 15000 })
  }
  if (!coverId.startsWith('cover:remote:')) {
    return config.navidromeUrl ? proxyNavidrome(req, res) : sendError(res, format, 70, 'Cover not found')
  }
  const songId = coverId.slice('cover:'.length)
  const track = state.get(songId)
  if (!track?.coverUrl) return sendError(res, format, 70, 'Cover not found')
  return proxyMedia(req, res, track.coverUrl, {}, {
    allowPrivate: config.allowPrivateStreams,
    timeoutMs: 15000,
  })
}

function getSong(req, res, url, format) {
  const id = url.searchParams.get('id')
  if (!parseRemoteSongId(id)) return config.navidromeUrl ? proxyNavidrome(req, res) : sendError(res, format, 70, 'Song not found')
  const track = state.get(id)
  return track ? sendSubsonic(res, format, { song: subsonicTrack(withFavorite(track)) }) : sendError(res, format, 70, 'Song not found')
}

async function getArtist(req, res, url, format) {
  const id = url.searchParams.get('id') || ''
  const parsed = parseRemoteArtistId(id)
  if (!parsed) return config.navidromeUrl ? proxyNavidrome(req, res) : sendError(res, format, 70, 'Artist not found')
  let tracks = state.tracksByArtist(id)
  if (tracks.length < config.maxSearchItemsPerProvider) {
    const found = await providers.searchAll(parsed.name, 0, config.maxSearchItemsPerProvider, { provider: parsed.providerKey, source: parsed.source })
    state.remember(found)
    tracks = state.tracksByArtist(id)
  }
  const albums = new Map()
  for (const track of tracks) {
    if (!albums.has(track.albumId)) albums.set(track.albumId, { id: track.albumId, name: track.album, artist: track.artist, artistId: track.artistId, tracks: [] })
    albums.get(track.albumId).tracks.push(track)
  }
  const album = [...albums.values()].map(value => withAlbumFavorite(albumSummary(value.id, value.name, value.artist, value.artistId, value.tracks)))
  return sendSubsonic(res, format, { artist: withArtistFavorite({ id, name: parsed.name, albumCount: album.length, album }) })
}

async function getAlbum(req, res, url, format) {
  const id = url.searchParams.get('id') || ''
  const parsed = parseRemoteAlbumId(id)
  if (!parsed) return config.navidromeUrl ? proxyNavidrome(req, res) : sendError(res, format, 70, 'Album not found')
  let tracks = state.tracksByAlbum(id)
  if (tracks.length < config.maxSearchItemsPerProvider) {
    const found = await providers.searchAll(`${parsed.name} ${parsed.artist || ''}`.trim(), 0, config.maxSearchItemsPerProvider, { provider: parsed.providerKey, source: parsed.source })
    state.remember(found)
    tracks = state.tracksByAlbum(id)
  }
  rememberPlaybackContext(url, tracks)
  const first = tracks[0]
  const album = withAlbumFavorite(albumSummary(id, parsed.name, parsed.artist || first?.artist || '未知歌手', first?.artistId, tracks))
  return sendSubsonic(res, format, { album: { ...album, song: tracks.map(withFavorite).map(subsonicTrack) } })
}

async function getLyrics(req, res, url, format, structured) {
  const id = url.searchParams.get('id') || ''
  let track = parseRemoteSongId(id) ? state.get(id) : null
  const requestedArtist = String(url.searchParams.get('artist') || '').trim()
  const requestedTitle = String(url.searchParams.get('title') || '').trim()
  if (!track && requestedTitle) track = state.findTrack(requestedArtist, requestedTitle)
  if (!track && requestedTitle) {
    const query = requestedArtist ? `${requestedTitle} ${requestedArtist}` : requestedTitle
    state.remember(await providers.searchAll(query, 0, config.maxSearchItemsPerProvider))
    track = state.findTrack(requestedArtist, requestedTitle)
  }
  if (!track) {
    if (config.navidromeUrl) return proxyNavidrome(req, res)
    return structured
      ? sendSubsonic(res, format, { lyricsList: { structuredLyrics: [] } })
      : sendSubsonic(res, format, { lyrics: { artist: requestedArtist, title: requestedTitle, value: '' } })
  }

  let value = {}
  try {
    value = await providers.lyrics(track)
  } catch (error) {
    console.warn(`[Online lyrics failed] title="${track.rawTitle}" artist="${track.artist}": ${error.message}`)
  }
  if (!structured) {
    return sendSubsonic(res, format, { lyrics: {
      artist: track.artist,
      title: track.rawTitle,
      value: value.lyric || '',
    } })
  }
  const entries = []
  if (value.lyric) entries.push(structuredLyric(track, value.lyric))
  if (value.tlyric) entries.push(structuredLyric(track, value.tlyric))
  return sendSubsonic(res, format, { lyricsList: { structuredLyrics: entries } })
}

function structuredLyric(track, raw) {
  const timed = []
  const plain = []
  for (const sourceLine of String(raw).split(/\r?\n/)) {
    if (/^\[(?:ar|ti|al|by|offset|length):/i.test(sourceLine.trim())) continue
    const stamps = [...sourceLine.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)]
    const value = sourceLine.replaceAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g, '').trim()
    if (!value) continue
    plain.push({ value })
    for (const stamp of stamps) {
      const fraction = stamp[3] || ''
      const milliseconds = fraction.length === 3 ? Number(fraction) : fraction.length === 2 ? Number(fraction) * 10 : fraction.length === 1 ? Number(fraction) * 100 : 0
      timed.push({ start: Number(stamp[1]) * 60000 + Number(stamp[2]) * 1000 + milliseconds, value })
    }
  }
  timed.sort((left, right) => left.start - right.start)
  return {
    displayArtist: track.artist,
    displayTitle: track.rawTitle,
    lang: 'und',
    offset: 0,
    synced: timed.length > 0,
    line: timed.length ? timed : plain,
  }
}

function albumSummary(id, name, artist, artistId, tracks) {
  const duration = tracks.reduce((sum, track) => sum + Number(track.duration || 0), 0)
  return {
    id,
    name,
    artist,
    artistId,
    coverArt: tracks.find(track => track.coverArt)?.coverArt,
    songCount: tracks.length,
    duration,
    created: tracks[0]?.created || new Date().toISOString(),
  }
}

async function favorite(req, res, url, action, format) {
  const enabled = action === 'star'
  const ids = [...url.searchParams.getAll('id'), ...url.searchParams.getAll('songId')]
  const albumIds = url.searchParams.getAll('albumId')
  const artistIds = url.searchParams.getAll('artistId')
  const remoteIds = ids.filter(id => parseRemoteSongId(id))
  const remoteAlbumIds = albumIds.filter(id => parseRemoteAlbumId(id))
  const remoteArtistIds = artistIds.filter(id => parseRemoteArtistId(id))
  const localIds = ids.filter(id => !parseRemoteSongId(id))
  const localAlbumIds = albumIds.filter(id => !parseRemoteAlbumId(id))
  const localArtistIds = artistIds.filter(id => !parseRemoteArtistId(id))
  try {
    for (const id of remoteIds) await state.setFavorite(id, enabled)
    for (const id of remoteAlbumIds) await state.setFavoriteAlbum(enabled ? await favoriteAlbumMetadata(id) : { id }, enabled)
    for (const id of remoteArtistIds) await state.setFavoriteArtist(enabled ? await favoriteArtistMetadata(id) : { id }, enabled)
  } catch (error) {
    return sendError(res, format, 70, error.message)
  }
  const remoteCount = remoteIds.length + remoteAlbumIds.length + remoteArtistIds.length
  if (remoteCount) console.log(`Online favorite changed songs=${remoteIds.length} albums=${remoteAlbumIds.length} artists=${remoteArtistIds.length} starred=${enabled}`)
  if (!localIds.length && !localAlbumIds.length && !localArtistIds.length) return sendSubsonic(res, format)
  if (!config.navidromeUrl) return sendSubsonic(res, format)

  const forwarded = new URL(req.url, 'http://gateway.local')
  forwarded.searchParams.delete('id')
  forwarded.searchParams.delete('songId')
  forwarded.searchParams.delete('albumId')
  forwarded.searchParams.delete('artistId')
  for (const id of localIds) forwarded.searchParams.append('id', id)
  for (const id of localAlbumIds) forwarded.searchParams.append('albumId', id)
  for (const id of localArtistIds) forwarded.searchParams.append('artistId', id)
  return proxyNavidrome(req, res, `${forwarded.pathname}${forwarded.search}`)
}

async function starred(req, res, url, action, format) {
  const resultKey = action === 'getStarred2' ? 'starred2' : 'starred'
  const onlineSongs = state.favoriteSongs().map(subsonicTrack)
  const onlineAlbums = state.favoriteAlbumItems().map(album => action === 'getStarred'
    ? { ...album, parent: album.artistId || 'online', isDir: true, title: album.name, album: album.name, type: 'album' }
    : album)
  const onlineArtists = state.favoriteArtistItems()
  const upstreamResult = config.navidromeUrl ? await fetchNavidrome(req.url, req.headers).catch(() => null) : null
  if (!upstreamResult) return sendSubsonic(res, format, { [resultKey]: { artist: onlineArtists, album: onlineAlbums, song: onlineSongs } })
  if (format === 'json') {
    const parsed = JSON.parse(upstreamResult.body.toString('utf8'))
    const responseRoot = parsed['subsonic-response'] || parsed.subsonicResponse
    responseRoot[resultKey] ||= {}
    responseRoot[resultKey].artist = normalizeArray(responseRoot[resultKey].artist)
    responseRoot[resultKey].artist.push(...onlineArtists)
    responseRoot[resultKey].album = normalizeArray(responseRoot[resultKey].album)
    responseRoot[resultKey].album.push(...onlineAlbums)
    responseRoot[resultKey].song = normalizeArray(responseRoot[resultKey].song)
    responseRoot[resultKey].song.push(...onlineSongs)
    return sendJson(res, 200, parsed)
  }
  let xml = injectXmlNodes(upstreamResult.body.toString('utf8'), resultKey, 'artist', onlineArtists)
  xml = injectXmlNodes(xml, resultKey, 'album', onlineAlbums)
  return sendXml(res, 200, injectXmlNodes(xml, resultKey, 'song', onlineSongs))
}

async function getPlaylists(req, res, format) {
  const charts = await providers.listCharts()
  const online = [...systemPlaylists(), ...charts, ...state.subscribedPlaylists()].map(item => subsonicPlaylist(item))
  const upstream = config.navidromeUrl ? await fetchNavidrome(req.url, req.headers).catch(() => null) : null
  if (!upstream) return sendSubsonic(res, format, { playlists: { playlist: online } })
  if (format === 'json') {
    const parsed = JSON.parse(upstream.body.toString('utf8'))
    const responseRoot = parsed['subsonic-response'] || parsed.subsonicResponse
    responseRoot.playlists ||= {}
    responseRoot.playlists.playlist = normalizeArray(responseRoot.playlists.playlist)
    responseRoot.playlists.playlist.push(...online)
    return sendJson(res, 200, parsed)
  }
  return sendXml(res, 200, injectXmlNodes(upstream.body.toString('utf8'), 'playlists', 'playlist', online))
}

async function getPlaylist(req, res, url, format) {
  const id = url.searchParams.get('id') || ''
  const system = systemPlaylist(id)
  if (system) {
    rememberPlaybackContext(url, system.entry)
    const entry = system.entry.map(withFavorite).map(subsonicTrack)
    return sendSubsonic(res, format, { playlist: subsonicPlaylist({ ...system, entry }, true) })
  }
  const parsed = parseRemotePlaylistId(id)
  if (!parsed) return config.navidromeUrl ? proxyNavidrome(req, res) : sendError(res, format, 70, 'Playlist not found')
  if (parsed.itemId.startsWith('chart:')) {
    const playlist = await providers.fetchPlaylist(parsed)
    state.remember(playlist.entry || [])
    await state.save()
    rememberPlaybackContext(url, playlist.entry || [])
    const entry = (playlist.entry || []).map(withFavorite).map(subsonicTrack)
    return sendSubsonic(res, format, { playlist: subsonicPlaylist({ ...playlist, entry }, true) })
  }
  const playlist = state.getPlaylist(id)
  if (!playlist) return sendError(res, format, 70, 'Playlist not found')
  rememberPlaybackContext(url, playlist.entry || [])
  const entry = (playlist.entry || []).map(withFavorite).map(subsonicTrack)
  return sendSubsonic(res, format, { playlist: subsonicPlaylist({ ...playlist, entry }, true) })
}

async function deletePlaylist(req, res, url, format) {
  const id = url.searchParams.get('id') || ''
  if (id.startsWith('system:')) return sendError(res, format, 50, 'System playlist cannot be deleted')
  const parsed = parseRemotePlaylistId(id)
  if (parsed?.itemId.startsWith('chart:')) return sendError(res, format, 50, 'Chart playlist cannot be deleted')
  if (!parsed) return config.navidromeUrl ? proxyNavidrome(req, res) : sendError(res, format, 70, 'Playlist not found')
  await state.deletePlaylist(id)
  return sendSubsonic(res, format)
}

async function playlistPage(req, res, url) {
  if (!verifyBasic(req, res)) return
  const query = String(url.searchParams.get('q') || '').trim()
  const source = String(url.searchParams.get('source') || '').trim()
  const results = query ? await providers.searchPlaylists(query, source || null, 0, 12) : []
  const subscribed = state.subscribedPlaylists()
  const charts = await providers.listCharts(source || null)
  const sourceOptions = [['', '全部平台'], ['kw', '酷我'], ['kg', '酷狗'], ['wy', '网易云'], ['tx', 'QQ音乐'], ['mg', '咪咕']]
    .map(([value, label]) => `<option value="${value}"${source === value ? ' selected' : ''}>${label}</option>`).join('')
  const cards = (items, action) => items.map(item => `<article><div class="cover">${item.coverUrl ? `<img src="${escapeHtml(item.coverUrl)}" alt="">` : ''}</div><div class="meta"><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.owner || '未知创建者')} · ${item.songCount || 0} 首</p><p class="desc">${escapeHtml(item.comment || '')}</p><form method="post" action="/playlists/${action}"><input type="hidden" name="id" value="${escapeHtml(item.id)}"><button type="submit">${action === 'subscribe' ? '添加到音流' : action === 'refresh' ? '刷新歌曲' : '取消订阅'}</button></form>${action === 'refresh' ? `<form method="post" action="/playlists/unsubscribe"><input type="hidden" name="id" value="${escapeHtml(item.id)}"><button class="secondary" type="submit">取消订阅</button></form>` : ''}</div></article>`).join('')
  const chartCards = charts.map(item => `<article><div class="cover"></div><div class="meta"><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.owner)} · 动态更新</p><p class="desc">${escapeHtml(item.comment)}</p></div></article>`).join('')
  const body = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>在线歌单</title><style>body{font:16px/1.5 system-ui;max-width:820px;margin:28px auto;padding:0 16px;color:#172033}h1{font-size:26px}.search{display:grid;grid-template-columns:1fr 130px 90px;gap:8px}.search input,.search select,button{font:inherit;padding:10px;border:1px solid #c5ccda;border-radius:9px;background:#fff}.search button,article button{background:#246bfd;color:#fff;border:0}section{margin-top:30px}article{display:grid;grid-template-columns:92px 1fr;gap:14px;padding:14px 0;border-bottom:1px solid #e3e7ef}.cover{width:92px;height:92px;background:#eef1f7;border-radius:10px;overflow:hidden}.cover img{width:100%;height:100%;object-fit:cover}h3,p{margin:0 0 6px}.desc{color:#637083;font-size:14px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}article form{display:inline-block;margin:5px 6px 0 0}.secondary{background:#687386}@media(max-width:540px){.search{grid-template-columns:1fr 110px}.search button{grid-column:1/3}article{grid-template-columns:72px 1fr}.cover{width:72px;height:72px}}</style><h1>在线歌单与排行榜</h1><p>排行榜会自动出现在播放器的歌单页面，打开时实时获取歌曲；普通歌单仍可在这里搜索并订阅。</p><form class="search" method="get"><input name="q" value="${escapeHtml(query)}" placeholder="搜索在线歌单" required><select name="source">${sourceOptions}</select><button>搜索</button></form><section><h2>动态排行榜（${charts.length} 个）</h2>${chartCards || '<p>暂时没有可用排行榜。</p>'}</section><section><h2>已订阅的普通歌单</h2>${subscribed.length ? cards(subscribed, 'refresh') : '<p>还没有订阅在线歌单。</p>'}</section>${query ? `<section><h2>搜索结果</h2>${results.length ? cards(results, 'subscribe') : '<p>没有搜索结果。</p>'}</section>` : ''}</html>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
  res.end(body)
}

async function subscribePlaylist(req, res) {
  if (!verifyBasic(req, res)) return
  const id = (await readForm(req)).get('id') || ''
  const parsed = parseRemotePlaylistId(id)
  if (!parsed) return sendText(res, 400, 'Invalid playlist id')
  await state.setPlaylist(await providers.fetchPlaylist(parsed))
  return redirect(res, '/playlists')
}

async function refreshPlaylist(req, res) {
  if (!verifyBasic(req, res)) return
  const id = (await readForm(req)).get('id') || ''
  const parsed = parseRemotePlaylistId(id)
  if (!parsed || !state.getPlaylist(id)) return sendText(res, 404, 'Playlist not found')
  await state.setPlaylist(await providers.fetchPlaylist(parsed))
  return redirect(res, '/playlists')
}

async function unsubscribePlaylist(req, res) {
  if (!verifyBasic(req, res)) return
  const id = (await readForm(req)).get('id') || ''
  if (!parseRemotePlaylistId(id)) return sendText(res, 400, 'Invalid playlist id')
  await state.deletePlaylist(id)
  return redirect(res, '/playlists')
}

function systemPlaylists() {
  return ['system:recent', 'system:frequent', 'system:random'].map(systemPlaylist).filter(Boolean)
}

function systemPlaylist(id) {
  let name
  let entry
  if (id === 'system:recent') {
    name = '最近播放'
    entry = state.recentSongs(100)
  } else if (id === 'system:frequent') {
    name = '我的常听排行榜'
    entry = state.frequentSongs(100)
  } else if (id === 'system:random') {
    name = '随机歌曲'
    entry = state.randomSongs(100)
  } else return null
  if (!entry.length) return null
  const changed = entry.map(track => state.playback(track.id)?.lastPlayed).filter(Boolean).sort().at(-1) || new Date().toISOString()
  return {
    id,
    name,
    owner: config.gatewayUser,
    public: false,
    readonly: true,
    songCount: entry.length,
    duration: entry.reduce((sum, track) => sum + Number(track.duration || 0), 0),
    coverArt: entry.find(track => track.coverArt)?.coverArt,
    created: changed,
    changed,
    entry,
  }
}

function radioPage(req, res) {
  if (!verifyBasic(req, res)) return
  const rows = state.radioStations().map(radio => `<article><div><h3>${escapeHtml(radio.name)}</h3><p>${escapeHtml(radio.streamUrl)}</p>${radio.homePageUrl ? `<p><a href="${escapeHtml(radio.homePageUrl)}" target="_blank" rel="noreferrer">电台主页</a></p>` : ''}</div><form method="post" action="/radios/delete"><input type="hidden" name="id" value="${escapeHtml(radio.id)}"><button class="danger" type="submit">删除</button></form></article>`).join('')
  const body = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>网络电台</title><style>body{font:16px/1.5 system-ui;max-width:820px;margin:28px auto;padding:0 16px;color:#172033}form.add{display:grid;gap:10px;max-width:650px}input,button{font:inherit;padding:10px;border:1px solid #c5ccda;border-radius:9px}button{background:#246bfd;color:#fff;border:0}.danger{background:#c43d3d}article{display:flex;justify-content:space-between;gap:16px;padding:14px 0;border-bottom:1px solid #e3e7ef}h3,p{margin:0 0 6px;overflow-wrap:anywhere}.hint{color:#637083}</style><h1>网络电台</h1><p class="hint">添加真实的 HTTP 或 HTTPS 直播流地址后，支持电台接口的客户端就能显示。</p><form class="add" method="post" action="/radios/add"><input name="name" placeholder="电台名称" required><input name="streamUrl" type="url" placeholder="直播流地址（必填）" required><input name="homePageUrl" type="url" placeholder="电台主页（选填）"><button type="submit">添加电台</button></form><section><h2>已添加</h2>${rows || '<p>还没有添加电台。</p>'}</section></html>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
  res.end(body)
}

async function addRadio(req, res) {
  if (!verifyBasic(req, res)) return
  const values = radioValues(await readForm(req))
  if (!values.ok) return sendText(res, 400, values.error)
  await state.createRadio(values.radio)
  return redirect(res, '/radios')
}

async function removeRadio(req, res) {
  if (!verifyBasic(req, res)) return
  const id = String((await readForm(req)).get('id') || '')
  if (!id.startsWith('radio:local:')) return sendText(res, 400, 'Invalid radio id')
  await state.deleteRadio(id)
  return redirect(res, '/radios')
}

function withFavorite(track) {
  const favoriteTrack = state.favorites.get(track.id)
  const playback = state.playback(track.id)
  return {
    ...track,
    starred: favoriteTrack?.starred,
    ...(playback?.playCount ? { playCount: playback.playCount } : {}),
    ...(playback?.lastPlayed ? { played: playback.lastPlayed } : {}),
  }
}

function withAlbumFavorite(album) {
  const favorite = state.favoriteAlbums.get(album.id)
  return favorite?.starred ? { ...album, starred: favorite.starred } : album
}

function withArtistFavorite(artist) {
  const favorite = state.favoriteArtists.get(artist.id)
  return favorite?.starred ? { ...artist, starred: favorite.starred } : artist
}

async function favoriteAlbumMetadata(id) {
  const parsed = parseRemoteAlbumId(id)
  if (!parsed) throw new Error('Album metadata is not available')
  let tracks = state.tracksByAlbum(id)
  if (!tracks.length) {
    const found = await providers.searchAll(`${parsed.name} ${parsed.artist || ''}`.trim(), 0, config.maxSearchItemsPerProvider, {
      provider: parsed.providerKey,
      source: parsed.source,
    })
    state.remember(found)
    tracks = state.tracksByAlbum(id)
  }
  const first = tracks[0]
  return albumSummary(id, parsed.name, parsed.artist || first?.artist || '未知歌手', first?.artistId, tracks)
}

async function favoriteArtistMetadata(id) {
  const parsed = parseRemoteArtistId(id)
  if (!parsed) throw new Error('Artist metadata is not available')
  let tracks = state.tracksByArtist(id)
  if (!tracks.length) {
    state.remember(await providers.searchAll(parsed.name, 0, config.maxSearchItemsPerProvider, {
      provider: parsed.providerKey,
      source: parsed.source,
    }))
    tracks = state.tracksByArtist(id)
  }
  return {
    id,
    name: parsed.name,
    albumCount: new Set(tracks.map(track => track.albumId)).size,
    ...(tracks.find(track => track.coverArt)?.coverArt ? { coverArt: tracks.find(track => track.coverArt).coverArt } : {}),
  }
}

function logDetails(params) {
  const safeKeys = ['query', 'any', 'songCount', 'songOffset', 'id', 'albumId', 'artistId', 'type', 'offset', 'size']
  const entries = []
  for (const key of safeKeys) {
    for (const raw of params.getAll(key)) entries.push(`${key}=${JSON.stringify(raw.replaceAll(/\s+/g, ' ').slice(0, 100))}`)
  }
  return entries.length ? ` ${entries.join(' ')}` : ''
}

function nonNegative(value, fallback) {
  const number = Number(value ?? fallback)
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback
}

function boundedCount(value, fallback) {
  return Math.min(config.maxSearchItemsPerProvider, nonNegative(value, fallback))
}

function boundedListCount(value, fallback) {
  return Math.min(500, nonNegative(value, fallback))
}

function home(res) {
  const body = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>lx-melobridge</title><style>body{font:16px/1.6 system-ui;max-width:760px;margin:48px auto;padding:0 20px;color:#172033}code{background:#eef1f7;padding:2px 6px;border-radius:5px}</style><h1>lx-melobridge</h1><p>服务运行正常。</p><ul><li>版本：${SERVER_VERSION}</li><li>模式：${config.navidromeUrl ? 'Navidrome + 在线' : '纯在线'}</li><li>Navidrome：${config.navidromeUrl ? '已配置' : '未配置'}</li><li>在线收藏：${state.favoriteSongs().length}</li><li>在线歌单：${state.subscribedPlaylists().length}</li><li>播放记录：${state.recentSongs(5000).length}</li><li>网络电台：${state.radioStations().length}</li><li>已启用音源：${providers.listStatus().filter(item => item.enabled).map(item => item.label).join('、') || '无'}</li></ul><p><a href="/playlists">搜索在线歌单</a> · <a href="/radios">管理网络电台</a> · <a href="/healthz"><code>/healthz</code></a></p></html>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function verifyBasic(req, res) {
  const encoded = String(req.headers.authorization || '').match(/^Basic\s+(.+)$/i)?.[1]
  const decoded = Buffer.from(encoded || '', 'base64').toString('utf8')
  const separator = decoded.indexOf(':')
  if (separator >= 0 && decoded.slice(0, separator) === config.gatewayUser && decoded.slice(separator + 1) === config.gatewayPassword) return true
  res.writeHead(401, { 'www-authenticate': 'Basic realm="lx-melobridge"', 'content-type': 'text/plain; charset=utf-8' })
  res.end('Authentication required')
  return false
}

async function readForm(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 16384) throw new Error('Form is too large')
    chunks.push(chunk)
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

function redirect(res, location) {
  res.writeHead(303, { location, 'cache-control': 'no-store' })
  res.end()
}

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}
