#!/bin/bash
set -e  # Exit on any error

# Build the Antora site
echo "Building Antora site..."
if ! antora playbook.yml --fetch; then
  echo "ERROR: Antora build failed"
  exit 1
fi

# Copy pre-built search data into the built site
echo "Copying search data..."
if [ -d "search-data" ]; then
  cp -r search-data build/site/
  echo "Search data copied successfully"
else
  echo "WARNING: search-data/ not found, skipping (search may not work)"
fi

echo "Build complete"