import { readFile, writeFile, access } from 'node:fs/promises'
import path from 'node:path'
import { inflate } from 'node:zlib'
import { promisify } from 'node:util'

const inflateAsync = promisify(inflate)

const [sourceId, outputArg] = process.argv.slice(2)
if (!sourceId || !outputArg) {
  console.error('Usage: node scripts/export-lx-desktop-source.mjs <source-id> <output-file>')
  process.exit(2)
}

const appData = process.env.APPDATA
if (!appData) throw new Error('APPDATA is unavailable')
const databaseFile = path.join(appData, 'lx-music-desktop', 'LxDatas', 'user_api.json')
const database = JSON.parse(await readFile(databaseFile, 'utf8'))
const source = database.userApis?.find(item => item.id === sourceId)
if (!source?.script) throw new Error(`LX Desktop source not found: ${sourceId}`)
const script = source.script.startsWith('gz_')
  ? (await inflateAsync(Buffer.from(source.script.slice(3), 'base64'))).toString('utf8')
  : source.script

const outputFile = path.resolve(outputArg)
try {
  await access(outputFile)
  throw new Error(`Refusing to overwrite existing file: ${outputFile}`)
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
await writeFile(outputFile, script, 'utf8')
console.log(JSON.stringify({ outputFile, name: source.name, version: source.version, characters: script.length, decompressed: source.script.startsWith('gz_') }))
