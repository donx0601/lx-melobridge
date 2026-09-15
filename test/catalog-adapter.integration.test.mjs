import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'

test('catalog adapter survives a resolver connection failure', { timeout: 10000 }, async t => {
  const brokenResolver = createServer((req) => req.socket.destroy())
  brokenResolver.listen(0, '127.0.0.1')
  await once(brokenResolver, 'listening')
  t.after(() => brokenResolver.close())

  const portProbe = createServer((_req, res) => res.end())
  portProbe.listen(0, '127.0.0.1')
  await once(portProbe, 'listening')
  const port = portProbe.address().port
  await new Promise(resolve => portProbe.close(resolve))

  const child = spawn(process.execPath, ['catalog-adapter/src/server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      RESOLVER_URL: `http://127.0.0.1:${brokenResolver.address().port}`,
      RESOLVER_TOKEN: 'test-token',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => child.kill())
  await waitReady(`http://127.0.0.1:${port}/healthz`, child)

  const id = Buffer.from(JSON.stringify({ v: 1, source: 'kw', musicInfo: { songmid: '42' } })).toString('base64url')
  const failed = await fetch(`http://127.0.0.1:${port}/resolve/${id}?quality=128k`)
  assert.equal(failed.status, 502)
  assert.equal(child.exitCode, null)

  const health = await fetch(`http://127.0.0.1:${port}/healthz`)
  assert.equal(health.status, 200)
  assert.equal(child.exitCode, null)
})

test('catalog adapter forwards lyrics for an opaque catalog id', { timeout: 10000 }, async t => {
  const resolver = createServer(async (req, res) => {
    if (req.url === '/healthz') return res.end(JSON.stringify({ ok: true }))
    assert.equal(req.url, '/lyric')
    assert.equal(req.headers.authorization, 'Bearer test-token')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    assert.equal(input.source, 'kw')
    assert.equal(input.musicInfo.songmid, '42')
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ lyric: '[00:01.00]测试歌词' }))
  })
  resolver.listen(0, '127.0.0.1')
  await once(resolver, 'listening')
  t.after(() => resolver.close())

  const portProbe = createServer((_req, res) => res.end())
  portProbe.listen(0, '127.0.0.1')
  await once(portProbe, 'listening')
  const port = portProbe.address().port
  await new Promise(resolve => portProbe.close(resolve))
  const child = spawn(process.execPath, ['catalog-adapter/src/server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      RESOLVER_URL: `http://127.0.0.1:${resolver.address().port}`,
      RESOLVER_TOKEN: 'test-token',
      PLATFORM_FALLBACK: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => child.kill())
  await waitReady(`http://127.0.0.1:${port}/healthz`, child)
  const id = Buffer.from(JSON.stringify({ v: 1, source: 'kw', musicInfo: { songmid: '42' } })).toString('base64url')
  const response = await fetch(`http://127.0.0.1:${port}/lyric/${id}`)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).lyric, '[00:01.00]测试歌词')
})

test('catalog adapter bypasses both caches when refresh is requested', { timeout: 10000 }, async t => {
  const requests = []
  const resolver = createServer(async (req, res) => {
    if (req.url === '/healthz') return res.end(JSON.stringify({ ok: true }))
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push(input)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ url: `https://media.example/song-${requests.length}.mp3` }))
  })
  resolver.listen(0, '127.0.0.1')
  await once(resolver, 'listening')
  t.after(() => resolver.close())

  const portProbe = createServer((_req, res) => res.end())
  portProbe.listen(0, '127.0.0.1')
  await once(portProbe, 'listening')
  const port = portProbe.address().port
  await new Promise(resolve => portProbe.close(resolve))
  const child = spawn(process.execPath, ['catalog-adapter/src/server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env, PORT: String(port), RESOLVER_URL: `http://127.0.0.1:${resolver.address().port}`,
      RESOLVER_TOKEN: 'test-token', PLATFORM_FALLBACK: 'false', RESOLVE_CACHE_TTL_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => child.kill())
  await waitReady(`http://127.0.0.1:${port}/healthz`, child)
  const id = Buffer.from(JSON.stringify({ v: 1, source: 'kw', musicInfo: { songmid: '42' } })).toString('base64url')
  const first = await (await fetch(`http://127.0.0.1:${port}/resolve/${id}?quality=320k`)).json()
  const cached = await (await fetch(`http://127.0.0.1:${port}/resolve/${id}?quality=320k`)).json()
  const refreshed = await (await fetch(`http://127.0.0.1:${port}/resolve/${id}?quality=320k&refresh=true`)).json()
  assert.equal(first.url, 'https://media.example/song-1.mp3')
  assert.equal(cached.cached, true)
  assert.equal(refreshed.url, 'https://media.example/song-2.mp3')
  assert.equal(requests.length, 2)
  assert.equal(requests[1].refresh, true)
})

async function waitReady(url, child) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode != null) throw new Error(`catalog adapter exited with code ${child.exitCode}`)
    try { if ((await fetch(url)).ok) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('catalog adapter did not start')
}
