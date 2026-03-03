-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor) before pushing chunks.
-- Enables pgvector and creates the ai_agent_docs table.

-- 1. Enable the vector extension (if not already enabled via Dashboard → Extensions)
create extension if not exists vector;

-- 2. Table for documentation chunks (id, content, metadata, optional embedding)
create table if not exists ai_agent_docs (
  id text primary key,
  content text not null,
  metadata jsonb default '{}',
  embedding vector(1536),  -- optional; 1536 for OpenAI text-embedding-3-small
  updated_at timestamptz default now()
);

-- 3. Function to truncate the table (called by ingest before each push so the table is replaced, not appended)
create or replace function truncate_ai_agent_docs()
returns void
language sql
security definer
as $$
  truncate table ai_agent_docs;
$$;

-- 4. Optional: HNSW index for fast similarity search (create after embeddings are populated)
-- create index if not exists ai_agent_docs_embedding_hnsw
--   on ai_agent_docs using hnsw (embedding vector_cosine_ops)
--   with (m = 16, ef_construction = 64);

-- 5. Optional: index on metadata for filtering by category
create index if not exists ai_agent_docs_metadata_category
  on ai_agent_docs using gin ((metadata -> 'category'));

comment on table ai_agent_docs is 'Magnolia docs chunks for RAG; ingest truncates and repopulates on each run.';
