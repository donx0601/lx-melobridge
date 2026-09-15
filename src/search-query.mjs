const PLATFORM_ALIASES = Object.freeze({
  kw: 'kw',
  酷我: 'kw',
  kg: 'kg',
  酷狗: 'kg',
  wy: 'wy',
  网易: 'wy',
  网易云: 'wy',
  tx: 'tx',
  qq: 'tx',
  QQ: 'tx',
  qq音乐: 'tx',
  QQ音乐: 'tx',
  mg: 'mg',
  咪咕: 'mg',
})

export function parseSearchQuery(input) {
  let query = String(input || '').trim()
  let source = null
  let provider = null

  const providerMatch = query.match(/^provider:([a-z0-9][a-z0-9_-]{0,31})\s+/i)
  if (providerMatch) {
    provider = providerMatch[1].toLowerCase()
    query = query.slice(providerMatch[0].length).trim()
  }

  const explicitSource = query.match(/^source:([^\s:]+)\s+/i)
  if (explicitSource) {
    source = PLATFORM_ALIASES[explicitSource[1]] || PLATFORM_ALIASES[explicitSource[1].toLowerCase()] || null
    if (source) query = query.slice(explicitSource[0].length).trim()
  }

  if (!source) {
    const shorthand = query.match(/^@?([^\s:]+):?\s*(.+)$/)
    if (shorthand) {
      const alias = PLATFORM_ALIASES[shorthand[1]] || PLATFORM_ALIASES[shorthand[1].toLowerCase()]
      if (alias && shorthand[2].trim()) {
        source = alias
        query = shorthand[2].trim()
      }
    }
  }

  return { query, source, provider }
}
