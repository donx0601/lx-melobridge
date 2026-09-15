export const remoteSongId = (providerKey, itemId) =>
  `remote:${providerKey}:${Buffer.from(String(itemId)).toString('base64url')}`

export const remoteCoverId = songId => `cover:${songId}`

const remoteEntityId = (kind, value) =>
  `${kind}:remote:${Buffer.from(JSON.stringify(value)).toString('base64url')}`

export const remoteArtistId = (providerKey, source, name) =>
  remoteEntityId('artist', { providerKey, source, name: String(name) })

export const remoteAlbumId = (providerKey, source, name, artist) =>
  remoteEntityId('album', { providerKey, source, name: String(name), artist: String(artist) })

export const remotePlaylistId = (providerKey, source, itemId) =>
  `playlist:remote:${providerKey}:${Buffer.from(JSON.stringify({ source, itemId: String(itemId) })).toString('base64url')}`

export const remotePlaylistCoverId = playlistId => `cover:${playlistId}`

export function parseRemoteSongId(id) {
  const match = /^remote:([a-z0-9][a-z0-9_-]{0,31}):([A-Za-z0-9_-]+)$/.exec(String(id || ''))
  if (!match) return null
  try {
    return { providerKey: match[1], itemId: Buffer.from(match[2], 'base64url').toString('utf8') }
  } catch {
    return null
  }
}

function parseRemoteEntityId(kind, id) {
  const match = new RegExp(`^${kind}:remote:([A-Za-z0-9_-]+)$`).exec(String(id || ''))
  if (!match) return null
  try {
    const decoded = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'))
    if (!decoded.providerKey || !decoded.source || !decoded.name) return null
    return decoded
  } catch { return null }
}

export const parseRemoteArtistId = id => parseRemoteEntityId('artist', id)
export const parseRemoteAlbumId = id => parseRemoteEntityId('album', id)

export function parseRemotePlaylistId(id) {
  const match = /^playlist:remote:([a-z0-9][a-z0-9_-]{0,31}):([A-Za-z0-9_-]+)$/.exec(String(id || ''))
  if (!match) return null
  try {
    const decoded = JSON.parse(Buffer.from(match[2], 'base64url').toString('utf8'))
    if (!decoded.source || decoded.itemId == null) return null
    return { providerKey: match[1], source: String(decoded.source), itemId: String(decoded.itemId) }
  } catch { return null }
}

export function normalizeArray(value) {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

export function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export function xmlNode(name, value) {
  if (Array.isArray(value)) return value.map(item => xmlNode(name, item)).join('')
  if (value == null) return ''
  if (typeof value !== 'object') return `<${name}>${escapeXml(value)}</${name}>`
  const attributes = []
  const children = []
  let textContent = ''
  for (const [key, child] of Object.entries(value)) {
    if (child == null) continue
    if (typeof child === 'object') children.push(xmlNode(key, child))
    else if ((name === 'line' || name === 'lyrics') && key === 'value') textContent = escapeXml(child)
    else attributes.push(` ${key}="${escapeXml(child)}"`)
  }
  return children.length || textContent
    ? `<${name}${attributes.join('')}>${textContent}${children.join('')}</${name}>`
    : `<${name}${attributes.join('')}/>`
}

export function subsonicXml(root) {
  const attributes = []
  const children = []
  for (const [key, value] of Object.entries(root)) {
    if (value != null && typeof value === 'object') children.push(xmlNode(key, value))
    else attributes.push(` ${key}="${escapeXml(value)}"`)
  }
  return `<?xml version="1.0" encoding="UTF-8"?><subsonic-response xmlns="http://subsonic.org/restapi"${attributes.join('')}>${children.join('')}</subsonic-response>`
}

export function injectXmlNodes(xml, container, nodeName, values) {
  const nodes = normalizeArray(values).map(value => xmlNode(nodeName, value)).join('')
  if (!nodes) return xml
  const selfClosing = new RegExp(`<${container}([^>]*)\\s*/>`)
  if (selfClosing.test(xml)) return xml.replace(selfClosing, `<${container}$1>${nodes}</${container}>`)
  const closing = `</${container}>`
  return xml.includes(closing) ? xml.replace(closing, `${nodes}${closing}`) : xml
}
