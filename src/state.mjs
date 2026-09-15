import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

const STREAM_DEDUPE_MS = 60000
const SCROBBLE_DEDUPE_MS = 2 * 60 * 60 * 1000
const MAX_PLAY_RECORDS = 2000

const timestamp = value => {
  const number = Number(value)
  const date = Number.isFinite(number) && number > 0 ? new Date(number) : new Date()
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

const timeValue = value => {
  const parsed = Date.parse(value || '')
  return Number.isFinite(parsed) ? parsed : 0
}

export class GatewayState {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'state.json')
    this.tempFile = path.join(dataDir, 'state.json.tmp')
    this.catalog = new Map()
    this.favorites = new Map()
    this.favoriteAlbums = new Map()
    this.favoriteArtists = new Map()
    this.playlists = new Map()
    this.plays = new Map()
    this.nowPlaying = new Map()
    this.radios = new Map()
    this.saveQueue = Promise.resolve()
  }

  async load() {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'))
      for (const track of data.catalog || []) {
        if (track?.id) this.catalog.set(track.id, track)
      }
      for (const track of data.favorites || []) {
        if (track?.id) {
          this.favorites.set(track.id, track)
          this.catalog.set(track.id, track)
        }
      }
      for (const album of data.favoriteAlbums || []) {
        if (album?.id) this.favoriteAlbums.set(album.id, album)
      }
      for (const artist of data.favoriteArtists || []) {
        if (artist?.id) this.favoriteArtists.set(artist.id, artist)
      }
      for (const playlist of data.playlists || []) {
        if (!playlist?.id) continue
        this.playlists.set(playlist.id, playlist)
        this.remember(playlist.entry || [])
      }
      for (const play of data.plays || []) {
        if (!play?.id || !play?.track?.id) continue
        this.plays.set(play.id, play)
        this.catalog.set(play.track.id, play.track)
      }
      for (const radio of data.radios || []) {
        if (radio?.id && radio?.name && radio?.streamUrl) this.radios.set(radio.id, radio)
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn(`Could not load state: ${error.message}`)
    }
  }

  remember(tracks) {
    for (const track of tracks) {
      if (!track?.id) continue
      this.catalog.delete(track.id)
      this.catalog.set(track.id, track)
    }
    if (this.catalog.size > 5000) {
      const protectedIds = new Set([
        ...this.favorites.keys(),
        ...this.plays.keys(),
        ...[...this.playlists.values()].flatMap(playlist => (playlist.entry || []).map(track => track.id)),
      ])
      for (const id of this.catalog.keys()) {
        const track = this.catalog.get(id)
        const protectedEntity = this.favoriteAlbums.has(track?.albumId) || this.favoriteArtists.has(track?.artistId)
        if (!protectedIds.has(id) && !protectedEntity) this.catalog.delete(id)
        if (this.catalog.size <= 4000) break
      }
    }
  }

  get(id) {
    return this.catalog.get(id) || this.favorites.get(id) || this.plays.get(id)?.track
  }

  tracksByArtist(id) {
    return [...this.catalog.values()].filter(track => track.artistId === id)
  }

  tracksByAlbum(id) {
    return [...this.catalog.values()].filter(track => track.albumId === id)
  }

  findTrack(artist, title) {
    const normalize = value => String(value || '').replace(/^【[^】]+】/, '').replaceAll(/\s+/g, '').toLowerCase()
    const expectedArtist = normalize(artist)
    const expectedTitle = normalize(title)
    return [...this.catalog.values()].find(track =>
      (!expectedArtist || normalize(track.artist) === expectedArtist || normalize(track.artist).includes(expectedArtist)) &&
      (!expectedTitle || normalize(track.rawTitle || track.title) === expectedTitle || normalize(track.title) === expectedTitle))
  }

  async setFavorite(id, enabled) {
    const track = this.get(id)
    if (!track) throw new Error('Online track metadata is not available; search for it again first')
    if (enabled) this.favorites.set(id, { ...track, starred: new Date().toISOString() })
    else this.favorites.delete(id)
    await this.save()
  }

  favoriteSongs() {
    return [...this.favorites.values()]
  }

  async setFavoriteAlbum(album, enabled) {
    if (!album?.id) throw new Error('Album metadata is not available')
    if (enabled) this.favoriteAlbums.set(album.id, { ...album, starred: new Date().toISOString() })
    else this.favoriteAlbums.delete(album.id)
    await this.save()
  }

  favoriteAlbumItems() {
    return [...this.favoriteAlbums.values()]
  }

  async setFavoriteArtist(artist, enabled) {
    if (!artist?.id) throw new Error('Artist metadata is not available')
    if (enabled) this.favoriteArtists.set(artist.id, { ...artist, starred: new Date().toISOString() })
    else this.favoriteArtists.delete(artist.id)
    await this.save()
  }

  favoriteArtistItems() {
    return [...this.favoriteArtists.values()]
  }

  subscribedPlaylists() {
    return [...this.playlists.values()]
  }

  getPlaylist(id) {
    return this.playlists.get(id)
  }

  async setPlaylist(playlist) {
    this.playlists.set(playlist.id, playlist)
    this.remember(playlist.entry || [])
    await this.save()
  }

  async deletePlaylist(id) {
    this.playlists.delete(id)
    await this.save()
  }

  playback(id) {
    return this.plays.get(id)
  }

  discoverySongs() {
    const tracks = new Map()
    for (const play of this.plays.values()) tracks.set(play.id, play.track)
    for (const track of this.favorites.values()) tracks.set(track.id, track)
    for (const playlist of this.playlists.values()) {
      for (const track of playlist.entry || []) tracks.set(track.id, track)
    }
    for (const track of this.catalog.values()) tracks.set(track.id, track)
    return [...tracks.values()]
  }

  recentSongs(limit = 100) {
    return [...this.plays.values()]
      .filter(play => play.lastPlayed)
      .sort((left, right) => timeValue(right.lastPlayed) - timeValue(left.lastPlayed))
      .slice(0, limit)
      .map(play => play.track)
  }

  frequentSongs(limit = 100) {
    return [...this.plays.values()]
      .filter(play => play.playCount > 0)
      .sort((left, right) => right.playCount - left.playCount || timeValue(right.lastPlayed) - timeValue(left.lastPlayed))
      .slice(0, limit)
      .map(play => play.track)
  }

  randomSongs(limit = 10) {
    const values = this.discoverySongs().slice()
    for (let index = values.length - 1; index > 0; index--) {
      const swap = Math.floor(Math.random() * (index + 1))
      ;[values[index], values[swap]] = [values[swap], values[index]]
    }
    return values.slice(0, limit)
  }

  nowPlayingSongs() {
    const now = Date.now()
    const result = []
    for (const [id, activity] of this.nowPlaying.entries()) {
      const track = this.get(id)
      const durationMs = Math.max(60, Number(track?.duration || 0)) * 1000
      if (!track || now - activity.startedAt > Math.min(durationMs + 5 * 60 * 1000, 2 * 60 * 60 * 1000)) {
        this.nowPlaying.delete(id)
        continue
      }
      result.push({ track, ...activity })
    }
    return result.sort((left, right) => right.startedAt - left.startedAt)
  }

  async recordStream(id, client = '', username = '', isStart = true) {
    const track = this.get(id)
    if (!track) return
    const now = Date.now()
    const current = this.plays.get(id) || { id, track, playCount: 0 }
    const shouldCount = isStart && now - timeValue(current.lastStreamAt) >= STREAM_DEDUPE_MS
    const next = {
      ...current,
      id,
      track,
      playCount: Number(current.playCount || 0) + (shouldCount ? 1 : 0),
      lastStarted: isStart ? new Date(now).toISOString() : current.lastStarted,
      lastPlayed: shouldCount ? new Date(now).toISOString() : current.lastPlayed,
      lastStreamAt: isStart ? new Date(now).toISOString() : current.lastStreamAt,
      lastCountedAt: shouldCount ? new Date(now).toISOString() : current.lastCountedAt,
    }
    this.plays.set(id, next)
    const previousActivity = this.nowPlaying.get(id)
    this.nowPlaying.set(id, { startedAt: isStart ? now : previousActivity?.startedAt || now, client, username })
    this.trimPlays()
    if (shouldCount) await this.save()
  }

  async scrobble(id, { submission = true, time, client = '', username = '' } = {}) {
    const track = this.get(id)
    if (!track) return false
    const now = Date.now()
    const playedAt = timestamp(time)
    const current = this.plays.get(id) || { id, track, playCount: 0 }
    if (!submission) {
      this.nowPlaying.set(id, { startedAt: timeValue(playedAt) || now, client, username })
      this.plays.set(id, { ...current, id, track, lastStarted: playedAt })
      return true
    }
    const alreadyCountedByStream = now - timeValue(current.lastStreamAt) < SCROBBLE_DEDUPE_MS
    this.plays.set(id, {
      ...current,
      id,
      track,
      playCount: Number(current.playCount || 0) + (alreadyCountedByStream ? 0 : 1),
      lastPlayed: playedAt,
      lastCountedAt: alreadyCountedByStream ? current.lastCountedAt : playedAt,
    })
    this.trimPlays()
    await this.save()
    return true
  }

  trimPlays() {
    if (this.plays.size <= MAX_PLAY_RECORDS) return
    const removable = [...this.plays.values()]
      .filter(play => !this.favorites.has(play.id))
      .sort((left, right) => timeValue(left.lastPlayed) - timeValue(right.lastPlayed))
    for (const play of removable) {
      this.plays.delete(play.id)
      if (this.plays.size <= MAX_PLAY_RECORDS) break
    }
  }

  radioStations() {
    return [...this.radios.values()]
  }

  async createRadio({ name, streamUrl, homePageUrl = '' }) {
    const radio = {
      id: `radio:local:${randomUUID()}`,
      name: String(name).trim(),
      streamUrl: String(streamUrl).trim(),
      homePageUrl: String(homePageUrl).trim(),
    }
    this.radios.set(radio.id, radio)
    await this.save()
    return radio
  }

  async updateRadio(id, changes) {
    const current = this.radios.get(id)
    if (!current) return false
    this.radios.set(id, {
      ...current,
      ...(changes.name != null ? { name: String(changes.name).trim() } : {}),
      ...(changes.streamUrl != null ? { streamUrl: String(changes.streamUrl).trim() } : {}),
      ...(changes.homePageUrl != null ? { homePageUrl: String(changes.homePageUrl).trim() } : {}),
    })
    await this.save()
    return true
  }

  async deleteRadio(id) {
    const deleted = this.radios.delete(id)
    if (deleted) await this.save()
    return deleted
  }

  async save() {
    const operation = this.saveQueue.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true })
      const data = {
        version: 4,
        favorites: this.favoriteSongs(),
        favoriteAlbums: this.favoriteAlbumItems(),
        favoriteArtists: this.favoriteArtistItems(),
        playlists: this.subscribedPlaylists(),
        plays: [...this.plays.values()],
        radios: this.radioStations(),
        catalog: [...this.catalog.values()].slice(-500),
      }
      await writeFile(this.tempFile, JSON.stringify(data, null, 2), 'utf8')
      await rename(this.tempFile, this.file)
    })
    this.saveQueue = operation.catch(() => {})
    return operation
  }
}
