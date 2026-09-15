import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

const port = positive(process.env.PORT, 3200)
const mapFile = process.env.MEDIA_MAP_FILE || '/config/media-map.json'
const token = String(process.env.RESOLVER_TOKEN || '')
let mediaMap = { tracks: [] }
let loadedAt = null

await reload()

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return json(res, 200, { ok: true, tracks: mediaMap.tracks.length, loadedAt, mapFile })
    }
    if (req.method === 'POST' && url.pathname === '/reload') {
      if (!authorized(req)) return json(res, 401, { error: 'Unauthorized' })
      await reload()
      return json(res, 200, { ok: true, tracks: mediaMap.tracks.length, loadedAt })
    }
    if (req.method === 'POST' && url.pathname === '/resolve') {
      if (!authorized(req)) return json(res, 401, { error: 'Unauthorized' })
      return resolve(req, res)
    }
    return json(res, 404, { error: 'Not found' })
  } catch (error) {
    console.error(error)
    return json(res, 500, { error: error.message })
  }
})

server.listen(port, '0.0.0.0', () => console.log(`Direct resolver listening on http://0.0.0.0:${port}`))

async function reload() {
  try {
    const parsed = JSON.parse(await readFile(mapFile, 'utf8'))
    if (!Array.isArray(parsed.tracks)) throw new Error('media map must contain a tracks array')
    mediaMap = { tracks: parsed.tracks }
    loadedAt = new Date().toISOString()
    console.log(`Loaded ${mediaMap.tracks.length} media mappings from ${mapFile}`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    console.warn(`Media map not found: ${mapFile}; resolver starts with an empty map`)
  }
}

async function resolve(req, res) {
  const body = await readJson(req)
  const source = String(body.source || '').trim().toLowerCase()
  const musicInfo = body.musicInfo && typeof body.musicInfo === 'object' ? body.musicInfo : {}
  const quality = String(body.quality || '128k').trim().toLowerCase()
  if (!source) return json(res, 400, { error: 'source is required' })

  const entry = mediaMap.tracks.find(item => item?.source === source && matches(item.match, musicInfo))
  if (!entry) return json(res, 404, { error: 'No authorized media mapping for this track' })
  const candidate = chooseQuality(entry, quality)
  if (!candidate?.url || !/^https?:\/\//i.test(candidate.url)) {
    return json(res, 502, { error: 'Mapped media URL must use http or https' })
  }
  return json(res, 200, {
    url: candidate.url,
    headers: candidate.headers || {},
    expiresAt: candidate.expiresAt,
  })
}

function chooseQuality(entry, requested) {
  const qualities = entry.qualities && typeof entry.qualities === 'object' ? entry.qualities : {}
  return qualities[requested] || entry.default || Object.values(qualities)[0]
}

function matches(match, musicInfo) {
  if (!match || typeof match !== 'object' || !Object.keys(match).length) return false
  return Object.entries(match).every(([key, value]) => String(musicInfo[key] ?? '') === String(value))
}

function authorized(req) {
  if (!token) return true
  return req.headers.authorization === `Bearer ${token}`
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1024 * 1024) throw new Error('Request body too large')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }
  catch { throw new Error('Invalid JSON body') }
}

function positive(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback
}

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' })
  res.end(body)
}
