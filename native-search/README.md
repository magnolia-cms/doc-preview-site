# Magnolia Docs Native Search

A custom, self-hosted search engine for Magnolia CMS documentation that replaces Algolia/DocSearch with a simpler, fully controllable solution. The search indexer runs automatically via GitHub Actions, and the UI widget is completely decoupled and can be dropped into any documentation site.

## Features

- **Automated Indexing**: GitHub Actions workflow builds your Antora site and generates search indexes automatically
- **Client-Side Search**: Fast, fuzzy search with no external API calls - all search happens in the browser
- **Version Filtering**: Filter results by Magnolia version (6.2, 6.3, Latest, Cloud, Modules)
- **Decoupled UI Widget**: Drop-in search interface that works independently of your build system
- **Zero External Dependencies**: No Algolia, no DocSearch, no third-party search services
- **Full Control**: You own and control all the data and configuration

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  GitHub Actions Workflow (.github/workflows/search-index.yml)│
│                                                              │
│  1. Checkout repo                                            │
│  2. Build Antora site → build/site/                         │
│  3. Run indexer → search-data/*.json                        │
│  4. Commit search-data/ back to repo                        │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Netlify Build (build.sh)                                    │
│                                                              │
│  1. Build Antora site                                        │
│  2. Copy search-data/ → build/site/search-data/            │
│  3. Deploy build/site/                                       │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Browser (docs-site-ui)                                      │
│                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐ │
│  │ Search UI    │───▶│ Search Client│───▶│ Search Index │ │
│  │ (Widget)     │    │ (Browser)     │    │ (JSON)       │ │
│  └──────────────┘    └──────────────┘    └──────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## How It Works

### 1. Automated Index Generation

The search index is generated automatically via GitHub Actions:

**Workflow**: `.github/workflows/search-index.yml`

```yaml
name: Build search index

on:
  workflow_dispatch:  # Manual trigger
  # schedule:
  #   - cron: '0 2 * * *'  # Optional: nightly

jobs:
  build-search-index:
    runs-on: ubuntu-latest
    steps:
      - Checkout repo
      - Build Antora site (npx antora playbook.yml)
      - Run indexer (node native-search/src/indexer.js build/site search-data)
      - Commit and push search-data/ back to repo
```

**Requirements**:
- `GITLAB_TOKEN` secret configured in GitHub (for accessing private GitLab repos) - search index token in PAT.
- Node.js 20+ in the workflow

**Output**: The workflow generates `search-data/` directory containing:
- `search-index.json` - Full search index (human-readable)
- `search-index.min.json` - Minified for production
- `llm-chunks.json` - LLM-optimized content for AI answers (future use)
- `metadata.json` - Index statistics and available filters

### 2. Build Integration

The `build.sh` script copies `search-data/` into the built site:

```bash
# Copy pre-built search data into the built site
if [ -d "search-data" ]; then
  cp -r search-data build/site/
fi
```

This ensures `search-data/*.json` files are available at `/search-data/` on your deployed site.

### 3. UI Widget Integration

The search widget is **completely decoupled** and can be dropped into any site:

**Files** (in `docs-site-ui/`):
- `src/js/vendor/magnolia-search.js` - Bundled search client + UI (ES5 compatible)
- `src/css/magnolia-search.css` - Search widget styles
- `src/partials/search.hbs` - Container HTML: `<div id="nativeSearch"></div>`

**Initialization** (in `footer-scripts.hbs`):

```html
<script src="{{{uiRootPath}}}/js/vendor/magnolia-search.js"></script>
<script>
  new MagnoliaSearchUI({
    container: '#nativeSearch',
    indexUrl: '/search-data/search-index.min.json',
    metadataUrl: '/search-data/metadata.json',
    placeholder: 'Search Magnolia docs…',
    hotkey: '/',
    maxResults: 15,
    showFilters: true,
    filters: [
      { key: '', label: 'All' },
      { key: 'latest', label: 'Latest' },
      { key: '6.3', label: '6.3' },
      { key: '6.2', label: '6.2' },
      { key: 'cloud', label: 'DX Cloud' },
      { key: 'modules', label: 'Modules' }
    ]
  });
</script>
```

## Using the Widget in Other Sites

The widget is **completely decoupled** - you can use it in any site, not just Antora:

### Step 1: Include Assets

Copy or reference the bundled files:
- `magnolia-search.js` (bundled client + UI)
- `magnolia-search.css` (styles)

### Step 2: Add Container HTML

```html
<div id="nativeSearch"></div>
```

### Step 3: Initialize Widget

```html
<link rel="stylesheet" href="/path/to/magnolia-search.css">
<script src="/path/to/magnolia-search.js"></script>
<script>
  new MagnoliaSearchUI({
    container: '#nativeSearch',
    indexUrl: '/search-data/search-index.min.json',
    metadataUrl: '/search-data/metadata.json',
    placeholder: 'Search docs…',
    hotkey: '/',
    maxResults: 15,
    showFilters: true,
    filters: [
      { key: '', label: 'All' },
      { key: 'version1', label: 'Version 1' },
      { key: 'version2', label: 'Version 2' }
    ]
  });
</script>
```

**That's it!** The widget will:
- Load the search index from `indexUrl`
- Build an inverted index in the browser
- Provide instant, client-side search
- Show results in a modal dialog
- Support keyboard shortcuts (`/` to open, `↑↓` to navigate, `Enter` to select)

## Components

### Indexer (`src/indexer.js`)

Crawls HTML files from your built Antora site and extracts:
- Page title (h1)
- Section headings (h2, h3, h4)
- Content (paragraphs, lists, tables, code)
- Metadata (category, version, breadcrumbs)

**Usage**:
```bash
node src/indexer.js <input-dir> <output-dir>
# Example:
node src/indexer.js build/site search-data
```

### Search Client (`src/search-client.js`)

Client-side search engine with:
- Inverted index for fast lookups
- Fuzzy matching (Levenshtein distance)
- Weighted field scoring (title > heading > content)
- Version/category filtering

### Search UI (`src/search-ui.js`)

Drop-in search interface widget:
- Modal search dialog
- Keyboard shortcuts (`/` to open, `↑↓` to navigate, `Enter` to select)
- Version filter buttons (dynamically generated from metadata)
- Fully decoupled - works in any HTML page

## Configuration

### Widget Options

```javascript
new MagnoliaSearchUI({
  container: '#nativeSearch',              // CSS selector for container
  indexUrl: '/search-data/search-index.min.json',  // Search index URL
  metadataUrl: '/search-data/metadata.json',       // Metadata URL (for filters)
  placeholder: 'Search docs…',            // Input placeholder
  hotkey: '/',                           // Keyboard shortcut to open
  maxResults: 15,                        // Max results to show
  showFilters: true,                     // Show version filter buttons
  showFooter: true,                      // Show footer with branding
  branding: 'Powered by Magnolia NativeSearch',  // Footer text
  filters: [                             // Custom filters (optional)
    { key: '', label: 'All' },
    { key: 'version1', label: 'Version 1' }
  ]
});
```

### Search Client Configuration

The search client can be configured after initialization:

```javascript
// Access the underlying search client
var searchUI = new MagnoliaSearchUI({...});
// The search client is available internally, but you can adjust config via:
// searchUI.search.config.fieldWeights = { title: 10, heading: 8, ... };
```

## Local Development

### Building the Search Index Locally

```bash
cd native-search
npm install

# Build Antora site first
cd ..
npx antora playbook.yml

# Then run indexer
cd native-search
node src/indexer.js ../build/site ../search-data
```

### Building the Widget Bundle

The widget is already bundled as `magnolia-search.js` (combines `search-client.js` + `search-ui.js`).

To rebuild:
```bash
cd native-search
npm run build:js  # Creates dist/magnolia-search.js
npm run build:css # Creates dist/magnolia-search.css
```

## Current Implementation Status

**✅ Implemented**:
- Automated GitHub Actions workflow for index generation
- Search index committed to repo (`search-data/`)
- Build script copies `search-data/` into `build/site/`
- Decoupled UI widget integrated into Antora UI
- Client-side search with fuzzy matching
- Version filtering
- Keyboard shortcuts

**🚧 Future (Phase 2)**:
- AI-powered answers via `/api/ask` endpoint
- Separate "Ask AI" widget (decoupled from search)

## Troubleshooting

### Search returns no results

1. Check that `search-data/search-index.min.json` exists and is accessible
2. Check browser console for fetch errors
3. Verify the `indexUrl` path matches your site structure
4. Ensure the index was generated successfully (check GitHub Actions logs)

### Index not updating

1. Trigger the GitHub Actions workflow manually
2. Check workflow logs for errors
3. Verify `GITLAB_TOKEN` secret is configured correctly
4. Ensure `search-data/` directory is committed to the repo

### Widget not appearing

1. Check that `magnolia-search.js` is loaded (browser console)
2. Verify `#nativeSearch` container exists in HTML
3. Check for JavaScript errors in console
4. Ensure CSS is loaded (`magnolia-search.css`)

### Wrong results ranking

- Adjust `fieldWeights` in search config (currently hardcoded in `search-client.js`)
- Review the `_searchText` field in your generated index
- Check `metadata.json` for filter configuration

## Comparison with Algolia/DocSearch

| Feature | Algolia/DocSearch | Native Search |
|---------|------------------|--------------|
| Cost | Free tier, then paid | Free (self-hosted) |
| Control | Limited configuration | Full control |
| Debugging | Opaque ranking | Transparent scoring |
| External Dependency | Yes | No |
| Index Size Limits | Yes | No |
| Rate Limits | Yes | No |
| Build Time Impact | None (external) | Minimal (separate workflow) |
| Customization | Limited | Complete |

## License

MIT
