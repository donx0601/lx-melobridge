import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'

test('direct resolver authenticates and selects requested quality', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'lx-melobridge-resolver-'))
  const port = await freePort()
  const mapFile = join(dir, 'media-map.json')
  await writeFile(mapFile, JSON.stringify({ tracks: [{
    source: 'kg', match: { songmid: '42' }, qualities: {
      '128k': { url: 'https://media.example/song.mp3' },
      flac: { url: 'https://media.example/song.flac', headers: { Referer: 'https://example.com/' } },
    },
  }] }))

  const child = spawn(process.execPath, ['resolver-template/src/server.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), MEDIA_MAP_FILE: mapFile, RESOLVER_TOKEN: 'test-token' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(async () => { child.kill(); await rm(dir, { recursive: true, force: true }) })
  await waitForHealth(`http://127.0.0.1:${port}/healthz`)

  const unauthorized = await fetch(`http://127.0.0.1:${port}/resolve`, { method: 'POST', body: '{}' })
  assert.equal(unauthorized.status, 401)
  const response = await fetch(`http://127.0.0.1:${port}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
    body: JSON.stringify({ source: 'kg', musicInfo: { songmid: 42 }, quality: 'flac' }),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    url: 'https://media.example/song.flac', headers: { Referer: 'https://example.com/' },
  })
})

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

async function waitForHealth(url) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try { if ((await fetch(url)).ok) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('resolver did not start')
}
