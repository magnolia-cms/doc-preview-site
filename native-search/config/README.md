# native-search config

## excluded-paths.json

Path prefixes (relative to `build/site/`) to skip when indexing and generating LLM .txt files. Any HTML under these folders is ignored.

- **Format:** JSON array of strings, e.g. `["cockpit", "other-folder"]`
- **Example:** `"cockpit"` skips `build/site/cockpit/*` but not `build/site/paas-docs/.../cockpit/...`
- Used by: `indexer.js`

## llms-intro.md

Markdown content used at the top of the root `llms.txt` manifest (at the site output root). Describes Magnolia DXP, offerings, audience, key user paths, output guidelines for assistants, and citation style. Edit this file to change the intro without touching code.

- **Format:** Plain markdown; the file is read as-is. The Antora extension appends component/version links after it.
- Used by: Antora `lib/llms-export-extension.js` when writing `llms.txt`. If the file is missing, a short default intro is used.

## supabase-schema.sql

SQL to run once in the Supabase SQL Editor: enables the `vector` extension, creates the `ai_agent_docs` table (id, content, metadata, optional embedding), and a `truncate_ai_agent_docs()` function. Ingest truncates the table before each run so the table is replaced, not appended. See `SUPABASE.md` in the native-search root for setup and env.
