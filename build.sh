#!/bin/bash
set -e  # Exit on any error

# Sanity-check (redacted) that GIT_CREDENTIALS is set
echo "GIT_CREDENTIALS is ${GIT_CREDENTIALS:+set (length ${#GIT_CREDENTIALS})} ${GIT_CREDENTIALS:-UNSET}"

###############################################################################
# 1. Build Antora site
###############################################################################
echo "Building Antora site..."
if ! npx antora playbook.yml --fetch --stacktrace; then
  echo "ERROR: Antora build failed, clearing cache for next attempt"
  rm -rf .cache/antora
  exit 1
fi

echo "Build complete"
