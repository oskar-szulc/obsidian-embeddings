import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chunkNote, isSkipped, MAX_CHUNK_CHARS } from '../src/chunk'

const vault = process.argv[2]
// Extra folders to leave out, comma-separated, like the plugin's skipFolders.
const SKIP = process.env.SKIP?.split(',') ?? []
const paths = (readdirSync(vault, { recursive: true }) as string[])
  .filter((p) => p.endsWith('.md') && !p.split('/').some((s) => s.startsWith('.')) && !isSkipped(p, SKIP))
const counts = paths.map((p) => chunkNote(readFileSync(join(vault, p), 'utf8')))
const all = counts.flat()
console.log(`notes ${paths.length}, chunks ${all.length}, empty notes ${counts.filter((c) => !c.length).length}, cut chunks ${all.filter((c) => c.text.length === MAX_CHUNK_CHARS).length}`)
