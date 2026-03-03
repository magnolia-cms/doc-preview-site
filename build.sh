#!/bin/bash
set -e  # Exit on any error

# Build the Antora site
echo "Building Antora site..."
if ! antora playbook.yml --fetch; then
  echo "ERROR: Antora build failed"
  exit 1
fi

# Generate search index and LLM .txt files; then chunk and push to Supabase (if env vars set)
echo "Generating search index and LLM pages..."
(cd native-search && npm ci --omit=dev) || { echo "ERROR: native-search npm ci failed"; exit 1; }

(cd native-search && node src/indexer.js ../build/site ../build/site/search-data) || {
  echo "ERROR: Search indexer failed. Check that build/site exists and contains HTML."
  exit 1
}

(cd native-search && node src/markdown-generator.js ../build/site ../build/site) || {
  echo "ERROR: Markdown generator failed. Check build/site and config (e.g. config/excluded-paths.json, config/llms-intro.md)."
  exit 1
}
echo "Search index at build/site/search-data/; llms.txt and llms/*.txt at build/site/"

echo "Chunking and pushing to Supabase (ai_agent_docs)..."
(cd native-search && node src/ingest.js) || {
  echo "ERROR: Ingest failed (chunking or Supabase push)."
  echo "  - If Supabase: check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, network, and that config/supabase-schema.sql was run."
  echo "  - If no env vars set, ingest only chunks and does not push; failure may be missing llms/*.txt files."
  exit 1
}

echo "Build complete"