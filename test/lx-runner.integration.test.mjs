import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { createUtils, LxSourceRuntime, selectSourceQuality, validateInit } from '../lx-source-runner/src/runtime.mjs'

test('LX runtime accepts safe extension sources used by community scripts', () => {
  assert.doesNotThrow(() => validateInit({
    sources: {
      qsvip: { name: '汽水音乐', type: 'music', actions: ['musicSearch', 'musicUrl', 'lyric'], qualitys: ['24bit', '320k'] },
      git: { name: '扩展源', type: 'music', actions: ['musicUrl'], qualitys: ['128k'] },
    },
  }))
  assert.throws(() => validateInit({
    sources: { 'bad source': { name: '非法键', type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } },
  }), /Invalid source key/)
})

test('LX runtime maps canonical 24-bit requests to source quality aliases', () => {
  assert.equal(selectSourceQuality(['24bit', 'flac', '320k'], [], 'flac24bit'), '24bit')
  assert.equal(selectSourceQuality(['flac24bit', '320k'], [{ type: '24bit' }], 'flac24bit'), 'flac24bit')
  assert.equal(selectSourceQuality(['128k'], [{ type: 'flac' }, { type: '128k' }], 'flac'), '128k')
})

test('LX crypto accepts short and full AES algorithm names', () => {
  const crypto = createUtils().crypto
  const key = Buffer.from('1234567890abcdef')
  const shortName = crypto.aesEncrypt(Buffer.from('hello'), 'ecb', key, '')
  const fullName = crypto.aesEncrypt(Buffer.from('hello'), 'aes-128-ecb', key, '')
  assert.deepEqual(fullName, shortName)
})

test('LX RSA helper matches Desktop raw block encryption', () => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 })
  const crypto = createUtils().crypto
  const first = crypto.rsaEncrypt(Buffer.from('lx-source'), publicKey)
  const second = crypto.rsaEncrypt(Buffer.from('lx-source'), publicKey)
  assert.equal(first.length, 128)
  assert.deepEqual(first, second)
})

test('LX request parses JSON returned as text/plain like LX Desktop', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'lx-melobridge-request-'))
  const sources = join(root, 'sources')
  const data = join(root, 'data')
  await mkdir(sources)
  let observedUserAgent = ''
  let observedQuery = ''
  const upstream = createHttpServer((req, res) => {
    observedUserAgent = req.headers['user-agent'] || ''
    observedQuery = new URL(req.url, 'http://localhost').searchParams.get('from') || ''
    const body = JSON.stringify({ data: [{ url: 'https://media.example/from-json.mp3' }] })
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  })
  await new Promise((resolve, reject) => upstream.listen(0, '127.0.0.1', resolve).once('error', reject))
  await writeFile(join(sources, 'json.js'), requestJsonScript(`http://127.0.0.1:${upstream.address().port}/url`))
  const port = await freePort()
  const child = spawn(process.execPath, ['lx-source-runner/src/server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env, PORT: String(port), SOURCE_DIR: sources, DATA_DIR: data,
      ACTIVE_SOURCE: 'json.js', RESOLVER_TOKEN: 'runner-token',
      ALLOW_SOURCE_PRIVATE_NETWORK: 'true', VERIFY_MEDIA_URL: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(async() => {
    child.kill()
    await closeHttp(upstream)
    await rm(root, { recursive: true, force: true })
  })
  await waitReady(`http://127.0.0.1:${port}/healthz`, child)
  const response = await fetch(`http://127.0.0.1:${port}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer runner-token' },
    body: JSON.stringify({ source: 'wy', quality: '128k', musicInfo: { songmid: '42' } }),
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).url, 'https://media.example/from-json.mp3')
  assert.match(observedUserAgent, /^Needle\/3\.2\.0 \(Node\.js .+; win32 x64\)$/)
  assert.equal(observedQuery, 'lx')
})

test('LX runtime downloads lyrics returned as an HTTP URL', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'lx-melobridge-lyric-url-'))
  const sourceFile = join(root, 'lyric-url.js')
  const upstream = createHttpServer((_req, res) => {
    const body = '[00:01.00]远程歌词\n[00:02.50]第二行'
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  })
  await new Promise((resolve, reject) => upstream.listen(0, '127.0.0.1', resolve).once('error', reject))
  await writeFile(sourceFile, lyricUrlScript(`http://127.0.0.1:${upstream.address().port}/song.lrc`))
  const runtime = new LxSourceRuntime({ filename: sourceFile, allowPrivateNetwork: true, resolveTimeoutMs: 2000 })
  t.after(async () => {
    runtime.dispose()
    await closeHttp(upstream)
    await rm(root, { recursive: true, force: true })
  })
  await runtime.initialize()
  const result = await runtime.lyric({ source: 'mg', musicInfo: { songmid: '42' } })
  assert.equal(result.lyric, '[00:01.00]远程歌词\n[00:02.50]第二行')
})

test('LX runner loads, resolves, and hot-switches source scripts', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'lx-melobridge-runner-'))
  const sources = join(root, 'sources')
  const data = join(root, 'data')
  await mkdir(sources)
  await writeFile(join(sources, 'a.js'), sourceScript('测试源A', 'a'))
  await writeFile(join(sources, 'b.js'), sourceScript('测试源B', 'b'))
  await writeFile(join(sources, 'broken-background.js'), brokenBackgroundScript())
  const port = await freePort()
  const child = spawn(process.execPath, ['lx-source-runner/src/server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env, PORT: String(port), SOURCE_DIR: sources, DATA_DIR: data,
      ACTIVE_SOURCE: 'a.js', RESOLVER_TOKEN: 'runner-token',
      ADMIN_USER: 'admin', ADMIN_PASSWORD: 'admin-pass',
      ALLOW_SOURCE_PRIVATE_NETWORK: 'true',
      VERIFY_MEDIA_URL: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(async () => { child.kill(); await rm(root, { recursive: true, force: true }) })
  await waitReady(`http://127.0.0.1:${port}/healthz`, child)
  const initialHealth = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()
  assert.equal(initialHealth.version, '0.5.6')

  const headers = { 'content-type': 'application/json', authorization: 'Bearer runner-token' }
  const first = await fetch(`http://127.0.0.1:${port}/resolve`, {
    method: 'POST', headers,
    body: JSON.stringify({ source: 'kw', quality: 'flac', musicInfo: { songmid: '42', types: [{ type: 'flac' }, { type: '128k' }] } }),
  })
  assert.equal(first.status, 200)
  assert.equal((await first.json()).url, 'https://media.example/a/42-128k.mp3')
  const cached = await fetch(`http://127.0.0.1:${port}/resolve`, {
    method: 'POST', headers,
    body: JSON.stringify({ source: 'kw', quality: 'flac', musicInfo: { songmid: '42', types: [{ type: 'flac' }, { type: '128k' }] } }),
  })
  assert.equal((await cached.json()).cached, true)
  const refreshed = await fetch(`http://127.0.0.1:${port}/resolve`, {
    method: 'POST', headers,
    body: JSON.stringify({ source: 'kw', quality: 'flac', refresh: true, musicInfo: { songmid: '42', types: [{ type: 'flac' }, { type: '128k' }] } }),
  })
  assert.equal((await refreshed.json()).cached, undefined)

  const unauthorizedPage = await fetch(`http://127.0.0.1:${port}/`)
  assert.equal(unauthorizedPage.status, 401)
  const page = await fetch(`http://127.0.0.1:${port}/`, {
    headers: { authorization: `Basic ${Buffer.from('admin:admin-pass').toString('base64')}` },
  })
  assert.match(await page.text(), /测试源A/)

  const selected = await fetch(`http://127.0.0.1:${port}/select`, {
    method: 'POST', headers, body: JSON.stringify({ filename: 'b.js' }),
  })
  assert.equal(selected.status, 200)
  assert.equal((await selected.json()).active, 'b.js')
  const lyric = await fetch(`http://127.0.0.1:${port}/lyric`, {
    method: 'POST', headers,
    body: JSON.stringify({ source: 'kw', musicInfo: { songmid: '42' } }),
  })
  assert.equal(lyric.status, 200)
  assert.equal((await lyric.json()).lyric, '[00:01.00]测试歌词 b')
  const second = await fetch(`http://127.0.0.1:${port}/resolve`, {
    method: 'POST', headers,
    body: JSON.stringify({ source: 'kw', quality: '128k', musicInfo: { songmid: '42' } }),
  })
  assert.equal((await second.json()).url, 'https://media.example/b/42-128k.mp3')

  const selectedBroken = await fetch(`http://127.0.0.1:${port}/select`, {
    method: 'POST', headers, body: JSON.stringify({ filename: 'broken-background.js' }),
  })
  assert.equal(selectedBroken.status, 200)
  await new Promise(resolve => setTimeout(resolve, 250))
  const healthAfterBackgroundFailure = await fetch(`http://127.0.0.1:${port}/healthz`)
  assert.equal(healthAfterBackgroundFailure.status, 200)
  assert.equal((await healthAfterBackgroundFailure.json()).version, '0.5.6')
  assert.equal(child.exitCode, null)
})

test('LX runner falls back from anti-hotlink audio and promotes the working script', { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'lx-melobridge-fallback-'))
  const sources = join(root, 'sources')
  const data = join(root, 'data')
  await mkdir(sources)

  const antiAudio = Buffer.concat([
    Buffer.from('ID3'),
    Buffer.alloc(24),
    Buffer.from('防盗链打击音', 'utf16le'),
    Buffer.alloc(256),
  ])
  const goodAudio = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(4093)])
  const requests = { bad: 0, good: 0 }
  const mediaServer = createHttpServer((req, res) => {
    const kind = req.url.includes('bad') ? 'bad' : 'good'
    requests[kind]++
    const body = kind === 'bad' ? antiAudio : goodAudio
    res.writeHead(206, {
      'content-type': 'audio/mpeg',
      'content-length': body.length,
      'content-range': `bytes 0-${body.length - 1}/${body.length}`,
      'accept-ranges': 'bytes',
    })
    res.end(body)
  })
  await new Promise((resolve, reject) => mediaServer.listen(0, '127.0.0.1', resolve).once('error', reject))
  const mediaPort = mediaServer.address().port
  await writeFile(join(sources, 'bad.js'), sourceScriptUrl('失效源', `http://127.0.0.1:${mediaPort}/bad.mp3`))
  await writeFile(join(sources, 'good.js'), sourceScriptUrl('可用源', `http://127.0.0.1:${mediaPort}/good.mp3`))

  const port = await freePort()
  const child = spawn(process.execPath, ['lx-source-runner/src/server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port), SOURCE_DIR: sources, DATA_DIR: data,
      ACTIVE_SOURCE: 'bad.js', FALLBACK_SOURCES: 'good.js',
      AUTO_SCRIPT_FALLBACK: 'true',
      RESOLVER_TOKEN: 'runner-token', ALLOW_SOURCE_PRIVATE_NETWORK: 'true',
      VERIFY_MEDIA_URL: 'true', SOURCE_ATTEMPT_TIMEOUT_MS: '2000', MEDIA_PROBE_TIMEOUT_MS: '2000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(async () => {
    child.kill()
    await closeHttp(mediaServer)
    await rm(root, { recursive: true, force: true })
  })
  await waitReady(`http://127.0.0.1:${port}/healthz`, child)

  const headers = { 'content-type': 'application/json', authorization: 'Bearer runner-token' }
  const body = JSON.stringify({ source: 'kw', quality: '128k', musicInfo: { songmid: '42', name: '测试歌曲' } })
  const first = await fetch(`http://127.0.0.1:${port}/resolve`, { method: 'POST', headers, body })
  const firstText = await first.text()
  assert.equal(first.status, 200, firstText)
  const firstResult = JSON.parse(firstText)
  assert.equal(firstResult.url, `http://127.0.0.1:${mediaPort}/good.mp3`)
  assert.equal(firstResult.sourceScript, 'good.js')
  assert.equal(firstResult.fallbackFrom, 'bad.js')

  const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()
  assert.equal(health.active, 'good.js')
  assert.equal(health.lastResolution.ok, true)
  assert.equal(health.lastResolution.failedAttempts.length, 1)

  const second = await fetch(`http://127.0.0.1:${port}/resolve`, { method: 'POST', headers, body })
  const secondResult = await second.json()
  assert.equal(secondResult.cached, true)
  assert.deepEqual(requests, { bad: 1, good: 1 })
})

function sourceScript(name, marker) {
  return `/**\n * @name ${name}\n * @version 1.0.0\n */
const { EVENT_NAMES, on, send } = globalThis.lx
let mediaResolved = false
on(EVENT_NAMES.request, ({ action, info }) => {
  if (action === 'lyric') return Promise.resolve(mediaResolved ? { lyric: '[00:01.00]测试歌词 ${marker}' } : null)
  mediaResolved = true
  return Promise.resolve('https://media.example/${marker}/' + info.musicInfo.songmid + '-' + info.type + '.mp3')
})
console.group('source initialized')
console.groupEnd()
send(EVENT_NAMES.inited, { sources: { kw: { name: '酷我', type: 'music', actions: ['musicUrl', 'lyric'], qualitys: ['128k'] } } })`
}

function sourceScriptUrl(name, url) {
  return `/**
 * @name ${name}
 * @version 1.0.0
 */
const { EVENT_NAMES, on, send } = globalThis.lx
on(EVENT_NAMES.request, () => Promise.resolve(${JSON.stringify(url)}))
send(EVENT_NAMES.inited, { sources: { kw: { name: '酷我', type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } } })`
}

function brokenBackgroundScript() {
  return `/**
 * @name 后台请求失败测试源
 * @version 1.0.0
 */
const { EVENT_NAMES, on, send, request } = globalThis.lx
on(EVENT_NAMES.request, () => Promise.resolve('https://media.example/fallback.mp3'))
send(EVENT_NAMES.inited, { sources: { kw: { name: '酷我', type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } } })
setTimeout(() => request('http://127.0.0.1:1/unreachable', {}, async error => { if (error) throw error }), 10)`
}

function requestJsonScript(url) {
  return `/**
 * @name JSON 请求兼容测试源
 * @version 1.0.0
 */
const { EVENT_NAMES, on, send, request } = globalThis.lx
on(EVENT_NAMES.request, () => new Promise((resolve, reject) => {
  request(${JSON.stringify(url)}, { query: { from: 'lx' } }, (error, _response, body) => {
    if (error) return reject(error)
    resolve(body.data[0].url)
  })
}))
send(EVENT_NAMES.inited, { sources: { wy: { name: '网易云', type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } } })`
}

function lyricUrlScript(url) {
  return `/**
 * @name 远程歌词测试源
 * @version 1.0.0
 */
const { EVENT_NAMES, on, send } = globalThis.lx
on(EVENT_NAMES.request, ({ action }) => Promise.resolve(action === 'lyric' ? { lyric: ${JSON.stringify(url)} } : 'https://media.example/song.mp3'))
send(EVENT_NAMES.inited, { sources: { mg: { name: '咪咕', type: 'music', actions: ['musicUrl', 'lyric'], qualitys: ['128k'] } } })`
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

async function closeHttp(server) {
  await new Promise(resolve => server.close(resolve))
}

async function waitReady(url, child) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode != null) throw new Error(`runner exited with code ${child.exitCode}`)
    try { if ((await fetch(url)).ok) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('runner did not start')
}
