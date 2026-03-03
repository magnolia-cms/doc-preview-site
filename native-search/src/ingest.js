/**
 * Ingest: chunk markdown from the generator and push to Supabase.
 *
 * Reads .txt files (from markdown-generator.js output), splits by second-level
 * headings (##), and produces documents (id, content, metadata, embedding).
 * When SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set, computes embeddings
 * via OpenAI (OPENAI_API_KEY required) and upserts to ai_agent_docs.
 *
 * Usage:
 *   node src/ingest.js [llmsDir] [baseUrl] [outputFile]
 *   # Push to Supabase with embeddings (env required):
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... OPENAI_API_KEY=... node src/ingest.js
 *   # Optionally write chunks to a file (e.g. for debugging):
 *   node src/ingest.js ../build/site/llms https://docs.magnolia-cms.com ./chunks.json
 */

const fs = require('fs').promises;
const path = require('path');
const { slugify } = require('./utils');

const DEFAULT_BASE_URL = 'https://docs.magnolia-cms.com';
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_BATCH_SIZE = 50;
const EMBEDDING_MAX_CHARS = 8192;
const EMBEDDING_BATCH_DELAY_MS = 150;

/**
 * Parse YAML-like frontmatter from generator output (--- ... ---).
 * Returns { frontmatter: object, body: string } or null if no frontmatter.
 */
function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw.trim() };

  const [, yamlBlock, body] = match;
  const frontmatter = {};
  const lines = yamlBlock.split(/\r?\n/);

  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"');
    }
    frontmatter[key] = value;
  }

  return { frontmatter, body: body.trim() };
}

/**
 * Split markdown body into chunks by ## (second-level) headings.
 * Each chunk is one ## section and everything under it (###, ####, etc.).
 * Content before the first ## is one chunk (intro).
 */
function chunkBySecondLevelHeadings(body, pageTitle) {
  const chunks = [];
  // Split on newline that is followed by ## (lookahead); first segment may be intro
  const sections = body.split(/\n(?=##\s)/m);

  for (let i = 0; i < sections.length; i++) {
    let raw = sections[i].trim();
    if (!raw) continue;

    const isIntro = i === 0 && !raw.startsWith('## ');
    const sectionMatch = raw.match(/^##\s+(.+?)(?:\n|$)/);

    let sectionTitle;
    let content;

    if (isIntro) {
      sectionTitle = pageTitle || 'Introduction';
      content = raw;
    } else if (sectionMatch) {
      sectionTitle = sectionMatch[1].trim();
      // Split dropped "## "; keep full markdown in chunk
      content = raw.startsWith('## ') ? raw : '## ' + raw;
    } else {
      sectionTitle = pageTitle || 'Introduction';
      content = raw;
    }

    chunks.push({ sectionTitle, content });
  }

  return chunks;
}

/**
 * Turn full page URL into relative path for deep linking (and optional anchor).
 */
function toRelativeSourceUrl(fullUrl, baseUrl, sectionSlug) {
  let rel = fullUrl.replace(baseUrl, '');
  rel = rel.replace(/^\/+/, '/');
  if (!rel.startsWith('/')) rel = '/' + rel;
  if (sectionSlug) rel = rel + '#' + sectionSlug;
  return rel;
}

/**
 * Call OpenAI embeddings API for a batch of texts. Returns array of embedding vectors.
 */
async function fetchEmbeddingBatch(texts, apiKey) {
  const input = texts.map((t) => String(t).slice(0, EMBEDDING_MAX_CHARS));
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'OpenAI embedding error');
  const list = data.data;
  if (!Array.isArray(list) || list.length !== input.length) {
    throw new Error('OpenAI returned unexpected embedding count');
  }
  return list.map((d) => d.embedding).filter(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const BATCH_SIZE = 100;

class Ingest {
  constructor(options = {}) {
    const defaultLlmsDir = path.join(__dirname, '..', '..', 'build', 'site', 'llms');
    this.pagesDir = options.pagesDir || defaultLlmsDir;
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    this.outputFile = options.outputFile || null;
    this.supabaseUrl = options.supabaseUrl || process.env.SUPABASE_URL || null;
    this.supabaseServiceRoleKey = options.supabaseServiceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY || null;
    this.openaiApiKey = options.openaiApiKey || process.env.OPENAI_API_KEY || null;
    this.supabaseTable = options.supabaseTable || 'ai_agent_docs';
    this.stats = { filesRead: 0, chunksWritten: 0, errors: [], supabaseUpserted: 0, embeddingsComputed: 0 };
  }

  /**
   * Resolve path to LLM .txt directory (may be given as "site" dir or "site/llms").
   */
  async resolvePagesDir() {
    const stat = await fs.stat(this.pagesDir).catch(() => null);
    if (!stat) return null;
    if (stat.isDirectory()) {
      const hasTxt = await fs.readdir(this.pagesDir).then(files => files.some(f => f.endsWith('.txt'))).catch(() => false);
      if (hasTxt) return this.pagesDir;
      const llmsSub = path.join(this.pagesDir, 'llms');
      const subStat = await fs.stat(llmsSub).catch(() => null);
      if (subStat && subStat.isDirectory()) return llmsSub;
    }
    return this.pagesDir;
  }

  async run() {
    const startTime = Date.now();
    console.log('📥 Ingest: chunk markdown for vector DB / Ask AI');
    console.log('================================================\n');

    const dir = await this.resolvePagesDir();
    if (!dir) {
      console.error('Pages directory not found:', this.pagesDir);
      process.exit(1);
    }

    console.log('Pages dir:', dir);
    console.log('Base URL:', this.baseUrl);

    const files = await this.findTxtFiles(dir);
    console.log('Found', files.length, '.txt files\n');

    const documents = [];

    for (const filePath of files) {
      try {
        const relativePath = path.relative(dir, filePath);
        const baseName = relativePath.split(path.sep).join('/');
        const file_name = dir.replace(/\\/g, '/').endsWith('llms') ? 'llms/' + baseName : baseName;
        const fileContent = await fs.readFile(filePath, 'utf-8');
        const { frontmatter, body } = parseFrontmatter(fileContent);

        const title = frontmatter.title || 'Untitled';
        const url = frontmatter.url || '';
        const category = frontmatter.category || '';

        const chunks = chunkBySecondLevelHeadings(body, title);
        this.stats.filesRead++;

        for (let i = 0; i < chunks.length; i++) {
          const { sectionTitle, content } = chunks[i];
          const sectionSlug = slugify(sectionTitle);
          const source_url = toRelativeSourceUrl(url, this.baseUrl, sectionSlug || undefined);
          const id = `${file_name.replace(/\.txt$/, '')}--${i}--${sectionSlug || 'intro'}`;

          documents.push({
            id,
            content,
            metadata: {
              section: sectionTitle,
              category,
              file_name,
              source_url,
              parent_page_title: title
            }
          });
          this.stats.chunksWritten++;
        }
      } catch (err) {
        this.stats.errors.push({ file: filePath, error: err.message });
      }
    }

    if (this.supabaseUrl && this.supabaseServiceRoleKey) {
      if (!this.openaiApiKey) {
        console.error('OPENAI_API_KEY is required to push to Supabase (embeddings are computed for vector search).');
        process.exit(1);
      }
      console.log('Computing embeddings via OpenAI (' + EMBEDDING_MODEL + ')...');
      await this.computeEmbeddings(documents);
      await this.pushToSupabase(documents);
    } else if (documents.length > 0) {
      console.log('Supabase not configured (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to push).');
    }

    if (this.outputFile) {
      await fs.mkdir(path.dirname(this.outputFile), { recursive: true });
      await fs.writeFile(this.outputFile, JSON.stringify(documents, null, 2), 'utf-8');
      console.log('Wrote', documents.length, 'chunks to', this.outputFile);
    }

    this.runDurationMs = Date.now() - startTime;
    this.printSummary();
    return { documents, stats: this.stats };
  }

  /**
   * Compute embeddings for all documents in batches via OpenAI. Mutates documents in place.
   */
  async computeEmbeddings(documents) {
    const total = documents.length;
    for (let i = 0; i < total; i += EMBEDDING_BATCH_SIZE) {
      const batch = documents.slice(i, i + EMBEDDING_BATCH_SIZE);
      const texts = batch.map((d) => d.content);
      const embeddings = await fetchEmbeddingBatch(texts, this.openaiApiKey);
      for (let j = 0; j < batch.length; j++) {
        batch[j].embedding = embeddings[j] || null;
      }
      this.stats.embeddingsComputed += batch.length;
      const done = Math.min(i + EMBEDDING_BATCH_SIZE, total);
      if (done % 500 < EMBEDDING_BATCH_SIZE || done === total) {
        console.log('   Embeddings', done, '/', total, '...');
      }
      if (i + EMBEDDING_BATCH_SIZE < total) {
        await sleep(EMBEDDING_BATCH_DELAY_MS);
      }
    }
  }

  async pushToSupabase(documents) {
    const table = this.supabaseTable;
    const logSupabaseError = (step, err) => {
      console.error('[Supabase]', step, 'failed:');
      console.error('  message:', err.message);
      if (err.code) console.error('  code:', err.code);
      if (err.details) console.error('  details:', err.details);
      if (err.hint) console.error('  hint:', err.hint);
      if (err.status) console.error('  status:', err.status);
      if (err.response) console.error('  response:', typeof err.response === 'object' ? JSON.stringify(err.response) : err.response);
    };

    let supabase;
    try {
      const { createClient } = require('@supabase/supabase-js');
      supabase = createClient(this.supabaseUrl, this.supabaseServiceRoleKey);
    } catch (err) {
      console.error('[Supabase] Client init failed (e.g. network or invalid URL):', err.message);
      throw err;
    }

    console.log('Truncating', table, '...');
    const { error: truncateError } = await supabase.rpc('truncate_ai_agent_docs');
    if (truncateError) {
      logSupabaseError('truncate (RPC truncate_ai_agent_docs)', truncateError);
      throw new Error(
        'Truncate failed. Run config/supabase-schema.sql in the Supabase SQL Editor (includes truncate_ai_agent_docs function). ' +
        truncateError.message
      );
    }

    const rows = documents.map((doc) => ({
      id: doc.id,
      content: doc.content,
      metadata: doc.metadata || {},
      embedding: doc.embedding || null
    }));
    console.log('Pushing to Supabase', table, '...');
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const { error } = await supabase.from(table).upsert(batch, {
        onConflict: 'id',
        ignoreDuplicates: false
      });
      if (error) {
        logSupabaseError('upsert batch ' + (Math.floor(i / BATCH_SIZE) + 1), error);
        throw error;
      }
      this.stats.supabaseUpserted += batch.length;
      const done = Math.min(i + BATCH_SIZE, rows.length);
      if (done % 500 < BATCH_SIZE || done === rows.length) {
        console.log('   Upserted', done, '/', rows.length, 'chunks...');
      }
    }
    console.log('Supabase upsert complete:', this.stats.supabaseUpserted, 'chunks.');
  }

  async findTxtFiles(dir, files = []) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.findTxtFiles(full, files);
      } else if (entry.name.endsWith('.txt')) {
        files.push(full);
      }
    }
    return files;
  }

  printSummary() {
    const durationSec = this.runDurationMs != null ? (this.runDurationMs / 1000).toFixed(2) : '—';
    console.log('\n================================================');
    console.log('📊 Summary');
    console.log('================================================');
    console.log('   .txt files used:  ', this.stats.filesRead);
    console.log('   Chunks produced: ', this.stats.chunksWritten);
    if (this.stats.embeddingsComputed > 0) {
      console.log('   Embeddings computed:', this.stats.embeddingsComputed);
    }
    if (this.stats.supabaseUpserted > 0) {
      console.log('   Supabase upserted:', this.stats.supabaseUpserted);
    }
    console.log('   Duration:        ', durationSec + 's');
    if (this.stats.errors.length) {
      console.log('   Errors:          ', this.stats.errors.length);
      this.stats.errors.slice(0, 5).forEach(e => console.log('      -', e.file, e.error));
    }
    console.log('\n✅ Done.\n');
  }
}

module.exports = Ingest;

if (require.main === module) {
  const args = process.argv.slice(2);
  const defaultLlmsDir = path.join(__dirname, '..', '..', 'build', 'site', 'llms');
  const pagesDir = args[0] || defaultLlmsDir;
  const baseUrl = args[1] || DEFAULT_BASE_URL;
  const outputFile = args[2] || null;

  const ingest = new Ingest({ pagesDir, baseUrl, outputFile });
  ingest.run().catch((err) => {
    console.error('\n[ingest] Error:', err.message);
    if (err.stack) console.error(err.stack);
    if (err.code) console.error('code:', err.code);
    process.exit(1);
  });
}
