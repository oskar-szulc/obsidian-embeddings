# Local Embeddings for Obsidian

Related notes and semantic search for your Obsidian vault, powered by [EmbeddingGemma 2](https://blog.google/innovation-and-ai/technology/developers-tools/embeddinggemma-2/) running locally in Ollama.

- **Related notes sidebar.** Shows the notes closest in meaning to the one you have open. Click **＋** to add a `[[link]]` to the note's `## Related` section.
- **Semantic search.** A query in English finds notes written in other languages, and notes that never use the query's words.

## What the sidebar shows

```
Belongs under
  Travel                                 0.52  ＋
Related
  Trip A                                 0.61  ＋
    ↳ from Itinerary
  Trip B                                 0.48  ＋
    ↳ from intro
Near-copies (3): Draft v1, Draft v2, Draft v3
```

- **↳ from**: the section of your open note that produced the match, so you can see *why* two notes are related.
- **Belongs under**: if the note links to no hub (a note with 10+ outgoing and 5+ incoming links), the closest hub is suggested. On my vault, for notes that already have a hub, this pick matches one of their hubs 89% of the time.
- **Near-copies**: notes scoring 0.86 or higher (tailored versions of one document, daily snapshots) collapse into one line instead of filling the list.
- **Debug** toggle: shows matches below the 0.37 threshold, dimmed.

Notes you already link to are hidden.

## How it works

1. Notes are split at `##` headings. Frontmatter and the `Related` / `References` sections are left out, so link lists don't make every note look like its hub.
2. Each chunk is embedded as `title: <note title> | text: <chunk>`. Queries use `task: search result | query: <query>`. These are EmbeddingGemma's task prefixes.
3. Vectors (768 dims, base64 float32) are stored in `.obsidian/plugins/obsidian-embeddings/index.json`. Edits are re-embedded 2 s after you stop typing. Renames are re-embedded too, because the title is part of every chunk.
4. Scoring is **mean-centered**: the average of all vectors is subtracted before comparing. Raw EmbeddingGemma vectors share one large direction (mean vector length 0.79 on my vault), so raw cosine rated every pair as similar. Centering raised linked-vs-random AUC from 86% to 90% and search hit@5 from 8/12 to 10/12.
5. Search is a brute-force scan, about 5 ms for 3,500 chunks. A note's score is its best chunk's score.

## Setup

Requires Ollama and Node.

```bash
brew install ollama
brew services start ollama
ollama pull hf.co/unsloth/embeddinggemma-2-GGUF:UD-Q4_K_XL
ollama create embeddinggemma2 -f Modelfile
```

The `Modelfile` matters. By default Ollama silently truncates embedding input at 2,048 tokens. The Modelfile raises `num_ctx` and `num_batch` to the model's 8,192.

```bash
git clone https://github.com/oskar-szulc/obsidian-embeddings.git
cd obsidian-embeddings
npm install
VAULT="/path/to/your/vault" npm run deploy
```

Enable **Local Embeddings** in Settings → Community plugins. The first index runs in the background and takes a few minutes for a vault of several hundred notes.

## Commands

| Command | What it does |
|---|---|
| Open related notes | Opens the sidebar |
| Semantic search | Search by meaning |
| Rebuild index | Re-embeds everything, e.g. after changing the model |

If Ollama is down, the sidebar keeps working from stored vectors. Search and indexing show a notice and try again on the next change.

## Tuning

Built for my own vault, so there's no settings tab.

Hidden folders (`.obsidian`, `.trash`, …) and `node_modules` are always skipped. To leave out other folders, such as templates or attachments, create `.obsidian/plugins/obsidian-embeddings/data.json` and reload the plugin:

```json
{ "skipFolders": ["Templates", "Attachments"] }
```

The other settings are constants in the code:

| Where | What |
|---|---|
| `src/embed.ts` | Server URL, model, dimensions |
| `src/chunk.ts` | Skipped sections, max chunk size |
| `src/views.ts` | `MIN_SCORE` (0.37), `NEAR_COPY` (0.86) |
| `src/related.ts` | Hub rule in `findHubs` |

`MIN_SCORE` is the 25th percentile of scores between notes that link to each other. To measure it on your vault, copy `scripts/queries.example.json` to `scripts/queries.json`, replace the queries with ones whose answers you know, and run:

```bash
SKIP=Templates,Attachments npx tsx scripts/measure.ts "/path/to/your/vault"
```

It reports hit@5 with and without prefixes, 768 vs. 256 dimensions, and the score spread for linked vs. random note pairs.

## Development

```bash
npm run check      # tests
npm run typecheck
npm run build
```

Desktop only. Not submitted to the community plugin directory.

## License

MIT
