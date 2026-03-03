# Edge Functions

## Ask AI (`ask-ai.js`)

**Path:** `/api/ask` (configured via `config.path`).

### Can you test now?

**Yes**, if:

1. **Netlify** has env vars set: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_KEY`), `OPENAI_API_KEY`. Optional: `SITE_URL`.
2. **Supabase** has the `ai_agent_docs` table with at least `id`, `content`, `metadata` (and optionally `embedding`), and the `truncate_ai_agent_docs` function so ingest can run.
3. **Ingest** has been run at least once so there are rows in `ai_agent_docs` (from the build: indexer → markdown generator → ingest).

No frontend changes are required. The UI already calls `/api/ask` with `{ question, filter }` and expects `{ answer, sources }`.

### How it works

- **If** the Supabase RPC `match_documents` exists and rows have `embedding` populated: the edge function uses **vector search** (OpenAI embeddings + RPC).
- **If** the RPC is missing or returns no rows (e.g. no embeddings yet): it **falls back** to keyword search (fetch up to 200 rows, rank by question keywords, return top 10). So you can test with current ingest data without adding embeddings or the RPC.

### Optional (better answers later)

- **Supabase:** Add an `embedding` column (e.g. `vector(1536)` for `text-embedding-3-small`) and a `match_documents` RPC that does vector similarity search. Then add a step (in ingest or a separate job) to compute and store embeddings for each chunk.
- **Frontend:** Send `history: [{ role, content }, ...]` in the POST body for follow-up questions; the edge function already supports it.
