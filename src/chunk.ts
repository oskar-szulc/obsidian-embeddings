export interface Chunk {
  heading: string
  text: string
}

// About 5K tokens: under the 8192-token input cap set in ./Modelfile.
export const MAX_CHUNK_CHARS = 24000

// Link lists: embedding them makes every note look like its own hubs.
const SKIP_SECTIONS = new Set(['related', 'references'])
const SKIP_PREFIXES = ['.obsidian/', '.trash/', 'Templates/', 'Attachments/']

export const isSkipped = (path: string) =>
  SKIP_PREFIXES.some((p) => path.startsWith(p)) || path.split('/').includes('node_modules')

export function chunkNote(markdown: string): Chunk[] {
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  const sections: { heading: string; lines: string[] }[] = [{ heading: '', lines: [] }]
  let inFence = false
  for (const line of body.split(/\r?\n/)) {
    if (/^(```|~~~)/.test(line)) inFence = !inFence
    if (!inFence && line.startsWith('## ')) sections.push({ heading: line.slice(3).trim(), lines: [] })
    else sections[sections.length - 1].lines.push(line)
  }
  return sections
    .filter((s) => !SKIP_SECTIONS.has(s.heading.toLowerCase()))
    .map((s) => ({ heading: s.heading, text: s.lines.join('\n').trim().slice(0, MAX_CHUNK_CHARS) }))
    .filter((c) => c.text)
}
