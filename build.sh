#!/bin/bash
set -e  # Exit on any error

# Build the Antora site
echo "Building Antora site..."
if ! antora playbook.yml --fetch; then
  echo "ERROR: Antora build failed"
  exit 1
fi

# Generate search index and LLM .txt files into the built site (build/site is in .gitignore)
echo "Generating search index and LLM pages..."
(cd native-search && npm ci --omit=dev)
(cd native-search && node src/indexer.js ../build/site ../build/site/search-data)
(cd native-search && node src/markdown-generator.js ../build/site ../build/site/search-data)
echo "Search data generated at build/site/search-data/"

echo "Build complete"