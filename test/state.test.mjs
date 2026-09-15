import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewayState } from '../src/state.mjs'

const track = {
  id: 'remote:test:dHJhY2stMQ',
  providerKey: 'test',
  providerItemId: 'track-1',
  title: '测试歌曲',
  rawTitle: '测试歌曲',
  artist: '测试歌手',
  artistId: 'artist:remote:test',
  album: '测试专辑',
  albumId: 'album:remote:test',
  duration: 180,
}

test('play history, rankings, and radios persist without double-counting range requests', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'lx-melobridge-state-test-'))
  const state = new GatewayState(dataDir)
  state.remember([track])

  await state.recordStream(track.id, 'ios', 'music', true)
  await state.recordStream(track.id, 'ios', 'music', false)
  await state.scrobble(track.id, { submission: true, client: 'ios', username: 'music' })
  await state.setFavorite(track.id, true)
  await state.setFavoriteAlbum({ id: track.albumId, name: track.album, artist: track.artist }, true)
  await state.setFavoriteArtist({ id: track.artistId, name: track.artist, albumCount: 1 }, true)
  const radio = await state.createRadio({ name: '测试电台', streamUrl: 'https://radio.example/live.mp3' })

  assert.equal(state.playback(track.id).playCount, 1)
  assert.equal(state.recentSongs()[0].id, track.id)
  assert.equal(state.frequentSongs()[0].id, track.id)
  assert.equal(state.nowPlayingSongs()[0].track.id, track.id)

  const saved = JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8'))
  assert.equal(saved.version, 4)
  assert.equal(saved.favoriteAlbums.length, 1)
  assert.equal(saved.favoriteArtists.length, 1)
  assert.equal(saved.plays.length, 1)
  assert.equal(saved.radios.length, 1)

  const reloaded = new GatewayState(dataDir)
  await reloaded.load()
  assert.equal(reloaded.playback(track.id).playCount, 1)
  assert.equal(reloaded.favoriteSongs().length, 1)
  assert.equal(reloaded.favoriteAlbumItems()[0].name, '测试专辑')
  assert.equal(reloaded.favoriteArtistItems()[0].name, '测试歌手')
  assert.equal(reloaded.radioStations()[0].id, radio.id)
  assert.equal(reloaded.recentSongs()[0].title, '测试歌曲')
})
