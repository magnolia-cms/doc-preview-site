# native-search config

## excluded-paths.json

Path prefixes (relative to `build/site/`) to skip when indexing and generating LLM .txt files. Any HTML under these folders is ignored.

- **Format:** JSON array of strings, e.g. `["cockpit", "other-folder"]`
- **Example:** `"cockpit"` skips `build/site/cockpit/*` but not `build/site/paas-docs/.../cockpit/...`
- Used by: `indexer.js` and `markdown-generator.js`

## llms-intro.md

Markdown content used at the top of the generated `llms.txt` manifest. Describes Magnolia DXP, offerings, audience, key user paths, output guidelines for assistants, and citation style. Edit this file to change the intro without touching code.

- **Format:** Plain markdown; the file is read as-is and must end with the "Documentation map (all pages)" section (or equivalent) so the automated category list is appended after it.
- Used by: `markdown-generator.js` when writing `llms.txt`. If the file is missing, a short default intro is used.

## supabase-schema.sql

SQL to run once in the Supabase SQL Editor: enables the `vector` extension, creates the `ai_agent_docs` table (id, content, metadata, optional embedding), and a `truncate_ai_agent_docs()` function. Ingest and push-supabase truncate the table before each run so the table is replaced, not appended. See `SUPABASE.md` in the native-search root for setup and env.
