# Magnolia Docs Search

A custom search engine for Magnolia CMS documentation that replaces Algolia with a simpler, more controllable solution.

## Features

- **Static Site Indexing**: Crawls your built static site (`build/site/`) and creates a search index
- **Client-Side Search**: Fast, fuzzy search with no external API calls
- **Version Filtering**: Filter results by Magnolia version (6.2, 6.3, 6.4, Cloud, Modules)
- **AI-Powered Answers**: Optional integration with LLM APIs (Anthropic/OpenAI) for conversational answers
- **Zero External Dependencies**: No Algolia, no DocSearch, no third-party search services
- **Full Control**: You own and control all the data and configuration

## Quick Start

### 1. Install Dependencies

```bash
cd magnolia-search-poc
npm install
```

### 2. Build the Search Index

Point the indexer at your built Antora site:

```bash
# Default: ./build/site → ./search-data
npm run index

# Or specify paths:
node src/indexer.js /path/to/build/site /path/to/output
```

This creates:
- `search-data/search-index.json` - Full search index (human-readable)
- `search-data/search-index.min.json` - Minified for production
- `search-data/llm-chunks.json` - LLM-optimized content for AI answers
- `search-data/metadata.json` - Index statistics and categories

### 3. Add to Your Site

Include the JavaScript and CSS:

```html
<!-- In your head -->
<link rel="stylesheet" href="/search-data/magnolia-search.css">

<!-- Before closing body -->
<script src="/search-data/magnolia-search.js"></script>
<script>
  new MagnoliaSearchUI({
    container: '#searchBar',
    indexUrl: '/search-data/search-index.min.json',
    chunksUrl: '/search-data/llm-chunks.json',
    enableAI: true,  // Set to false to disable AI features
    aiEndpoint: '/api/ask'  // Your backend endpoint for AI
  });
</script>
```

### 4. Add a Search Trigger

```html
<div id="searchBar"></div>
```

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Static Site   │────▶│     Indexer      │────▶│  Search Index   │
│  (build/site/)  │     │   (Node.js)      │     │    (JSON)       │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                                          │
                                                          ▼
                        ┌──────────────────┐     ┌─────────────────┐
                        │    Search UI     │◀───│  Search Client  │
                        │   (Browser)      │     │   (Browser)     │
                        └──────────────────┘     └─────────────────┘
                                │
                                ▼ (optional)
                        ┌──────────────────┐     ┌─────────────────┐
                        │   AI Assistant   │────▶│   LLM API       │
                        │                  │     │ (Anthropic/OAI) │
                        └──────────────────┘     └─────────────────┘
```

## Components

### Indexer (`src/indexer.js`)

Crawls HTML files and extracts:
- Page title (h1)
- Section headings (h2, h3, h4)
- Content (paragraphs, lists, tables, code)
- Metadata (category, version, breadcrumbs)

Creates two types of output:
1. **Search Records**: Granular, per-section records for precise search results
2. **LLM Chunks**: Full-page context for AI-powered answers

### Search Client (`src/search-client.js`)

Client-side search with:
- Inverted index for fast lookups
- Fuzzy matching (Levenshtein distance)
- Weighted field scoring (title > heading > content)
- Version/category filtering

### AI Assistant (`src/ai-assistant.js`)

Retrieval-augmented generation (RAG) for AI answers:
- Finds relevant documentation chunks
- Builds context for LLM prompts
- Supports streaming responses
- Works with Anthropic Claude or OpenAI GPT

### Search UI (`src/search-ui.js`)

Drop-in search interface:
- Modal search dialog
- Keyboard shortcuts (/ to open, ↑↓ to navigate, Enter to select)
- Version filter buttons
- AI "Ask" button

## Configuration

### Indexer Options

```javascript
const indexer = new MagnoliaDocsIndexer({
  siteDir: './build/site',      // Input directory
  outputDir: './search-data',   // Output directory
  baseUrl: 'https://docs.magnolia-cms.com'  // Base URL for links
});
```

### Search Client Options

```javascript
const search = new MagnoliaSearch({
  indexUrl: '/search-data/search-index.min.json',
  onReady: () => console.log('Search ready')
});

// Configure scoring
search.config.fieldWeights = {
  title: 10,
  heading: 8,
  content: 3,
  breadcrumb: 2
};
```

### AI Assistant Options

```javascript
const ai = new MagnoliaAI({
  chunksUrl: '/search-data/llm-chunks.json',
  apiEndpoint: '/api/ask',  // Your backend
  // OR for direct API calls (dev only):
  // apiKey: 'sk-...',
  // provider: 'anthropic'  // or 'openai'
});
```

## Backend API for AI

If using AI features, create a backend endpoint that:

1. Receives: `{ question, context, sources }`
2. Calls your LLM provider
3. Returns: `{ answer }`

Example (Node.js/Express):

```javascript
app.post('/api/ask', async (req, res) => {
  const { question, context } = req.body;
  
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: 'You are a Magnolia CMS documentation assistant...',
    messages: [{ 
      role: 'user', 
      content: `Context:\n${context}\n\nQuestion: ${question}` 
    }]
  });
  
  res.json({ answer: response.content[0].text });
});
```

## Comparison with Algolia

| Feature | Algolia/DocSearch | This Solution |
|---------|------------------|---------------|
| Cost | Free tier, then paid | Free (self-hosted) |
| Control | Limited configuration | Full control |
| Debugging | Opaque ranking | Transparent scoring |
| AI Integration | Separate product | Built-in |
| External Dependency | Yes | No |
| Index Size Limits | Yes | No |
| Rate Limits | Yes | No |

## Integration with Antora

Add to your Antora build pipeline:

```yaml
# In your CI/CD or build script
- npm install
- npm run build:site    # Your Antora build
- npm run index         # Generate search index
- # Deploy build/site + search-data
```

Or add to your Antora UI bundle's `gulpfile.js`.

## Customization

### Custom Category Detection

Edit `categorizeUrl()` in `src/indexer.js`:

```javascript
categorizeUrl(url) {
  if (url.includes('/my-custom-section/')) {
    return { category: 'My Section', version: 'custom' };
  }
  // ... existing logic
}
```

### Custom UI Styling

Override CSS variables or edit `src/search-ui.css`:

```css
.mgnl-search-filter.active {
  background: #your-brand-color;
  border-color: #your-brand-color;
}
```

### Adding More Filters

Edit `createModal()` in `src/search-ui.js` to add filter buttons, then update `getVersionFromUrl()` in your frontend code.

## Troubleshooting

### Search returns no results
- Check that the index loaded: `search.loaded` should be `true`
- Check browser console for fetch errors
- Verify the index URL is accessible

### Wrong pages ranking high
- Adjust `fieldWeights` in search config
- Check the `priority` values in the indexer
- Review the `_searchText` field in your index

### AI not working
- Ensure backend endpoint is configured
- Check CORS if frontend/backend are on different domains
- Verify API keys are set correctly on backend

## License

MIT
