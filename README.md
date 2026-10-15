# Local Embeddings for Obsidian

A personal Obsidian plugin that embeds your vault with [EmbeddingGemma 2](https://blog.google/innovation-and-ai/technology/developers-tools/embeddinggemma-2/) running locally in Ollama. It adds:

- a **Related notes** sidebar listing the notes most similar to the open one, with a **＋** button that adds a `[[link]]` to its `## Related` section
- a **Semantic search** popup that finds notes by meaning, in any language the model knows

Nothing leaves your machine. Notes are split at `##` headings, each section is embedded, and vectors live in `.obsidian/plugins/obsidian-embeddings/index.json`.

## Setup

```bash
brew install ollama
brew services start ollama
ollama pull hf.co/unsloth/embeddinggemma-2-GGUF:UD-Q4_K_XL
ollama create embeddinggemma2 -f Modelfile
```

The `Modelfile` matters. By default Ollama cuts embedding input at 2,048 tokens without an error. The Modelfile raises `num_ctx` and `num_batch` to the model's 8,192.

```bash
npm install
VAULT="/path/to/your/vault" npm run deploy
```

Then enable **Local Embeddings** in Settings → Community plugins. The first index runs in the background and takes a few minutes for a vault of several hundred notes.

## Commands

- **Open related notes**: shows the sidebar.
- **Semantic search**: search by meaning.
- **Rebuild index**: re-embeds everything, for example after changing the model.

## Notes

- Desktop only, built for my own vault. There's no settings tab. The constants are in `src/embed.ts` (server, model), `src/chunk.ts` (skipped folders, chunk size) and `src/views.ts` (`MIN_SCORE`).
- `npm run check` runs the tests. `scripts/measure.ts` produced the numbers in the blog post.
