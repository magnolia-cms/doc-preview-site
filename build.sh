#!/bin/bash

# Build the Antora site
antora playbook --fetch

# Copy pre-built search data into the built site
cp -r search-data build/site/