// No obsidian import: tests and scripts/measure.ts run this under Node.
export const BASE_URL = 'http://127.0.0.1:11434'
// Local Ollama model built from ./Modelfile (raises Ollama's silent 2048-token input cap to 8192).
export const MODEL = 'embeddinggemma2'
export const DIMS = 768
const BATCH = 16

export type Transport = (url: string, body: string) => Promise<{ status: number; text: string }>

export class EmbedError extends Error {
  constructor(message: string, readonly fatal: boolean) {
    super(message)
  }
}

export const docInput = (title: string, text: string) => `title: ${title} | text: ${text}`
export const queryInput = (query: string) => `task: search result | query: ${query}`

export function normalize(v: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(v)
  let n = 0
  for (const x of out) n += x * x
  n = Math.sqrt(n)
  if (n) for (let i = 0; i < out.length; i++) out[i] /= n
  return out
}

export function createEmbedder(transport: Transport, baseUrl = BASE_URL, model = MODEL, dims = DIMS) {
  async function request(inputs: string[]): Promise<Float32Array[]> {
    let res
    try {
      res = await transport(`${baseUrl}/v1/embeddings`, JSON.stringify({ model, input: inputs }))
    } catch {
      throw new EmbedError(`Embedding server not reachable at ${baseUrl}. Start it with \`ollama serve\`.`, true)
    }
    if (res.status === 404 || (res.status >= 400 && /not found/i.test(res.text)))
      throw new EmbedError(`Model ${model} not found. Run: ollama create ${model} -f Modelfile (see README)`, true)
    if (res.status >= 400)
      throw new EmbedError(`Embedding request failed (HTTP ${res.status}): ${res.text.slice(0, 200)}`, false)
    const data = (JSON.parse(res.text).data as { index: number; embedding: number[] }[]).sort((a, b) => a.index - b.index)
    if (data.length !== inputs.length)
      throw new EmbedError(`Sent ${inputs.length} inputs, got ${data.length} vectors back.`, false)
    for (const d of data)
      if (d.embedding.length !== dims)
        throw new EmbedError(`Expected ${dims}-dim vectors, got ${d.embedding.length}. Check MODEL in src/embed.ts.`, true)
    return data.map((d) => normalize(d.embedding))
  }

  return {
    async embed(inputs: string[]): Promise<Float32Array[]> {
      const out: Float32Array[] = []
      for (let i = 0; i < inputs.length; i += BATCH) out.push(...(await request(inputs.slice(i, i + BATCH))))
      return out
    },
  }
}
