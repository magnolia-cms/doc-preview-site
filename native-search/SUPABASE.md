# Pushing chunks to Supabase

Chunks from ingest are pushed to the **ai_agent_docs** table. Each run **truncates** the table then upserts, so the table is replaced rather than appended.

---

## Test the push (Supabase only)

You have a project; do these in the Supabase dashboard so the push will work.

### 1. Enable the vector extension

- In the left sidebar: **Database** → **Extensions**.
- Search for **vector**, open it, click **Enable**.

### 2. Create the table and truncate function

- In the left sidebar: **SQL Editor** → **New query**.
- Paste in the full contents of **`native-search/config/supabase-schema.sql`** (from this repo).
- Click **Run** (or Cmd/Ctrl+Enter).
- You should see “Success. No rows returned.” The table `ai_agent_docs` and the function `truncate_ai_agent_docs` are now created.

### 3. Confirm in the dashboard

- **Table Editor** → you should see **ai_agent_docs** with columns: `id`, `content`, `metadata`, `embedding`, `updated_at`.
- **Database** → **Functions** → you should see **truncate_ai_agent_docs**.

### 4. Get your credentials (for when you run ingest)

- **Project Settings** (gear in sidebar) → **API**.
- **Project URL** — copy this (e.g. `https://xxxxx.supabase.co`).
- **Project API keys** — copy the **service_role** key (secret; do not commit). You’ll use this and the URL as `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` when you run ingest.

Once 1–3 are done, Supabase is ready. Next step is running ingest with those env vars (see **Setup** below).

---

## Free tier

Supabase free tier includes **~1 GB database storage**. With ~2200 pages and ~8000 chunks:

- Table data (id, content, metadata): ~50–80 MB
- Embeddings (e.g. 1536-dim): ~50 MB
- Indexes: ~20–40 MB  

**Total ~120–170 MB** — well within the free tier.

## Setup

1. **Create a Supabase project** at [supabase.com](https://supabase.com).

2. **Enable pgvector**: Dashboard → Project Settings → Extensions → enable **vector**.

3. **Create the table and truncate function**: SQL Editor → run the contents of `config/supabase-schema.sql` (creates `ai_agent_docs` and `truncate_ai_agent_docs()`).

4. **Get credentials**: Project Settings → API → Project URL and **service_role** key (not anon).

5. **Run ingest** (from repo root, e.g. `doc-preview-site`). Ingest reads the llms .txt files, chunks them, and pushes directly to Supabase. No `chunks.json` is written unless you pass an output path.

   ```bash
   cd native-search && npm install
   export SUPABASE_URL="https://YOUR_PROJECT.supabase.co"
   export SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"
   node src/ingest.js
   ```

   To also write chunks to a file (e.g. for debugging), pass the path as the third argument:

   ```bash
   node src/ingest.js ../build/site/llms https://docs.magnolia-cms.com ./chunks.json
   ```

   **Re-push from an existing file:** If you already have a `chunks.json` and want to push it without re-running ingest, use `node src/push-supabase.js /path/to/chunks.json`.

## Env vars

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Project URL (e.g. `https://xxx.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (bypasses RLS; keep secret) |

## Embeddings

The schema includes an optional `embedding vector(1536)` column. Ingest does **not** generate embeddings; it only upserts `id`, `content`, and `metadata`. To enable vector search:

- Use Supabase Edge Functions or a separate job to call an embedding API (e.g. OpenAI `text-embedding-3-small`) and update `ai_agent_docs.embedding`.
- Or use Supabase’s built-in embedding integration if available for your project.

After embeddings are populated, run the optional HNSW index creation in `config/supabase-schema.sql` (uncomment the `create index` block).
