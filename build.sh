#!/bin/bash
set -e  # Exit on any error

###############################################################################
# 1. Build Antora site (HTML + llms.txt + llms/*.txt via llms-export extension)
###############################################################################
echo "Building Antora site..."
if ! antora playbook.yml --fetch; then
  echo "ERROR: Antora build failed"
  exit 1
fi

###############################################################################
# 2. Build search index (HTML → search-data JSON under build/site/search-data/)
###############################################################################
# echo "Generating search index (native-search/indexer)..."
# (cd native-search && npm ci --omit=dev) || { echo "ERROR: native-search npm ci failed"; exit 1; }

# (cd native-search && node src/indexer.js ../build/site ../build/site/search-data) || {
#   echo "ERROR: Search indexer failed. Check that build/site exists and contains HTML."
#   exit 1
# }
# echo "Search index at build/site/search-data/; LLM corpora at build/site/llms*/ (from Antora extension)"

###############################################################################
# 3. Chunk LLM corpora and push to Supabase (ai_agent_docs)
#    - Reads build/site/llms*.txt
#    - Splits into chunks per page and per ## heading
#    - Computes embeddings via OpenAI (if OPENAI_API_KEY set)
#    - Truncates and upserts into Supabase (if SUPABASE_* set)
###############################################################################
# echo "Chunking and pushing to Supabase (ai_agent_docs)..."
# (cd native-search && node src/ingest.js) || {
#   echo "ERROR: Ingest failed (chunking or Supabase push)."
#   echo "  - If Supabase: check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, network, and that config/supabase-schema.sql was run."
#   echo "  - If no env vars set, ingest only chunks and does not push; failure may be missing llms/*.txt files."
#   exit 1
# }

echo "Build complete"
