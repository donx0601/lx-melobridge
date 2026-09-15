import test from 'node:test'
import assert from 'node:assert/strict'
import { injectXmlNodes, parseRemotePlaylistId, parseRemoteSongId, remotePlaylistId, remoteSongId, subsonicXml } from '../src/codec.mjs'

test('remote ids round-trip unicode provider ids', () => {
  const id = remoteSongId('demo', '歌曲/123')
  assert.deepEqual(parseRemoteSongId(id), { providerKey: 'demo', itemId: '歌曲/123' })
})

test('remote playlist ids round-trip platform and provider ids', () => {
  const id = remotePlaylistId('catalog', 'wy', '歌单/123')
  assert.deepEqual(parseRemotePlaylistId(id), { providerKey: 'catalog', source: 'wy', itemId: '歌单/123' })
})

test('XML serializer escapes attributes and injector supports empty containers', () => {
  const root = subsonicXml({ status: 'ok', version: '1.16.1', song: { id: '1', title: 'A&B' } })
  assert.match(root, /title="A&amp;B"/)
  const merged = injectXmlNodes('<subsonic-response><searchResult3/></subsonic-response>', 'searchResult3', 'song', [{ id: '2', title: '在线' }])
  assert.match(merged, /<searchResult3><song id="2" title="在线"\/><\/searchResult3>/)
})
