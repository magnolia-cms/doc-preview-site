/**
 * Netlify Edge Function: Ask AI
 *
 * Same pattern as reference: portable service layer (embeddings + vector search) +
 * Netlify-specific handler. Uses OpenAI for embeddings and chat; supports
 * conversation history and "latest" release-notes boost.
 *
 * Request: POST { question, history?: [{ role, content }], filter?: {} }
 * Response: JSON { answer, sources } (so current frontend works).
 * Served at /api/ask (see config.path below).
 *
 * Env (Netlify): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY),
 * OPENAI_API_KEY. Optional: SITE_URL for absolute source links.
 *
 * Supabase: table ai_agent_docs with embedding column; RPC match_documents
 * (query_text, query_embedding, match_count, filter) must exist.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Netlify Edge env (use Netlify.env.get when available)
const getEnv = (key) => {
  if (typeof Netlify !== "undefined" && Netlify.env && typeof Netlify.env.get === "function") {
    return Netlify.env.get(key);
  }
  return Deno.env.get(key);
};

// ==========================================
// SERVICE LAYER (portable)
// ==========================================

async function getEmbedding(text) {
  const openaiKey = getEnv("OPENAI_API_KEY");
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + openaiKey,
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text.slice(0, 8192),
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "OpenAI embedding error");
  const embedding = data.data?.[0]?.embedding;
  if (!embedding) throw new Error("No embedding returned");
  return embedding;
}

/** Keyword fallback when match_documents RPC is missing or returns nothing (e.g. no embeddings yet). */
function scoreChunksByKeywords(chunks, textQuery) {
  const words = textQuery
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  if (words.length === 0) return chunks.slice(0, 5);
  return chunks
    .map((c) => {
      const content = (c.content || "").toLowerCase();
      let score = 0;
      for (const w of words) {
        if (content.includes(w)) score += 1;
      }
      return { ...c, _score: score };
    })
    .filter((r) => r._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, 10)
    .map(({ _score, ...c }) => c);
}

async function searchVectorDatabase(supabase, textQuery, vectorArray, filter = {}) {
  const isAskingForLatest = /latest|newest|recent|just released/i.test(textQuery);

  const [vectorResult, latestResult] = await Promise.all([
    supabase.rpc("match_documents", {
      query_text: textQuery,
      query_embedding: vectorArray,
      match_count: 5,
      filter: filter,
    }),
    isAskingForLatest
      ? supabase
          .from("ai_agent_docs")
          .select("content, metadata")
          .ilike("metadata->>source_url", "%/release-notes/latest%")
          .limit(3)
      : Promise.resolve({ data: null, error: null }),
  ]);

  let combinedChunks = [];

  if (isAskingForLatest && latestResult.data && latestResult.data.length > 0) {
    const taggedLatestChunks = latestResult.data.map((doc) => ({
      ...doc,
      content: `[CRITICAL CONTEXT: LATEST RELEASE NOTES]\n${doc.content}`,
    }));
    combinedChunks = [...taggedLatestChunks];
  }

  if (!vectorResult.error && vectorResult.data && vectorResult.data.length > 0) {
    combinedChunks = [...combinedChunks, ...vectorResult.data];
    return combinedChunks;
  }

  // Fallback: no match_documents RPC or no embeddings yet — fetch rows and rank by keywords
  const VERSION_KEY_TO_CATEGORY = { cloud: "DX Cloud", modules: "Modules" };
  const categoryFilter = filter.category || (filter.version && VERSION_KEY_TO_CATEGORY[filter.version]) || filter.version;
  let query = supabase.from("ai_agent_docs").select("id, content, metadata").limit(200);
  if (categoryFilter) {
    query = query.filter("metadata->>category", "eq", categoryFilter);
  }
  const { data: rows, error } = await query;
  if (error) throw error;
  const keywordChunks = scoreChunksByKeywords(rows || [], textQuery);
  return [...combinedChunks, ...keywordChunks];
}

function buildContextFromChunks(chunks) {
  if (!chunks || chunks.length === 0) return "No relevant documentation found.";
  return chunks
    .map((c) => {
      const meta = c.metadata || {};
      let rawPath = meta.source_url || meta.url || meta.path || "";
      let cleanLink = "#";
      if (rawPath) {
        cleanLink = rawPath;
        if (!cleanLink.startsWith("/") && !cleanLink.startsWith("http")) {
          cleanLink = "/" + cleanLink;
        }
      }
      const section = meta.section || meta.Section || "Documentation";
      return `Source Link: [${section}](${cleanLink})\n${c.content}`;
    })
    .join("\n\n---\n\n");
}

function buildSourcesFromChunks(chunks, baseUrl) {
  const siteBase = baseUrl || (getEnv("SITE_URL") || "https://docs.magnolia-cms.com").replace(/\/$/, "");
  return (chunks || []).map((c) => {
    const m = c.metadata || {};
    let url = m.source_url || m.url || "";
    if (url && !url.startsWith("http") && !url.startsWith("/")) url = "/" + url;
    if (url && url.startsWith("/")) url = siteBase + url;
    return {
      title: m.parent_page_title || m.section || m.file_name || "Documentation",
      url: url || undefined,
    };
  });
}

// ==========================================
// CONTROLLER (Netlify Edge)
// ==========================================

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: CORS_HEADERS,
    });
  }

  try {
    const body = await request.json();
    const userQuestion = (body.question ?? "").trim();
    if (!userQuestion) {
      return new Response(JSON.stringify({ error: "Missing question" }), {
        status: 400,
        headers: CORS_HEADERS,
      });
    }
    const history = body.history || [];
    const filter = body.filter || {};

    const supabaseUrl = getEnv("SUPABASE_URL");
    const supabaseKey = getEnv("SUPABASE_SERVICE_ROLE_KEY") || getEnv("SUPABASE_KEY");
    const openaiKey = getEnv("OPENAI_API_KEY");
    const siteUrl = (getEnv("SITE_URL") || "https://docs.magnolia-cms.com").replace(/\/$/, "");

    if (!supabaseUrl || !supabaseKey) {
      return new Response(
        JSON.stringify({ error: "Server configuration error: Supabase not configured" }),
        { status: 500, headers: CORS_HEADERS }
      );
    }
    if (!openaiKey) {
      return new Response(
        JSON.stringify({ error: "Server configuration error: OPENAI_API_KEY not set" }),
        { status: 500, headers: CORS_HEADERS }
      );
    }

    // Contextualize search: if user says "Are there other options?", use previous question for retrieval
    let searchQuery = userQuestion;
    if (history.length > 0) {
      const lastUserMsg = [...history].reverse().find((msg) => msg.role === "user");
      if (lastUserMsg && lastUserMsg.content) {
        searchQuery = `${lastUserMsg.content} ${userQuestion}`;
      }
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const queryVector = await getEmbedding(searchQuery);
    const chunks = await searchVectorDatabase(supabase, searchQuery, queryVector, filter);

    const context = buildContextFromChunks(chunks);
    const sources = buildSourcesFromChunks(chunks, siteUrl);

    if (context === "No relevant documentation found.") {
      return new Response(
        JSON.stringify({
          answer:
            "I couldn't find relevant documentation to answer your question. Try rephrasing or being more specific.",
          sources: [],
        }),
        { status: 200, headers: CORS_HEADERS }
      );
    }

    const systemPrompt = `You are an expert developer integration assistant for Magnolia DXP.
CRITICAL INSTRUCTIONS:
1. CONTEXTUALIZE: Use the previous conversation history to understand pronouns like "it", "this", or "that action" in the user's latest question.
2. ANSWER: Base your factual answer heavily on the DOCUMENTATION CONTEXT below.
3. FALLBACK: If the DOCUMENTATION CONTEXT does not contain the answer, you may use facts from the conversation history. If neither has the answer, say "I don't have enough information to answer that."
4. CITE WITH EXACT LINKS: Append a "### Sources" section at the end of your response with a deduplicated bulleted list of the exact Markdown links from the DOCUMENTATION CONTEXT that you used. Do NOT invent URLs or add your own #anchors.
5. LATEST RELEASES: If the user asks about "latest", "newest", or "recent" releases, treat chunks marked [CRITICAL CONTEXT: LATEST RELEASE NOTES] as the source of truth.`;

    const historyMessages = history.map((msg) => ({
      role: msg.role === "ai" ? "assistant" : msg.role,
      content: msg.content || "",
    }));

    const userMessageContent = `DOCUMENTATION CONTEXT:
${context}

User's latest question: ${userQuestion}`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...historyMessages.filter((m) => m.content),
      { role: "user", content: userMessageContent },
    ];

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + openaiKey,
      },
      body: JSON.stringify({
        model: "gpt-5",
        messages,
        max_completion_tokens: 1536,
      }),
    });

    const data = await res.json();
    if (data.error) {
      throw new Error(data.error.message || "OpenAI error");
    }
    const answer = (data.choices?.[0]?.message?.content ?? "").trim();

    return new Response(JSON.stringify({ answer, sources }), {
      status: 200,
      headers: CORS_HEADERS,
    });
  } catch (error) {
    console.error("Ask AI error:", error);
    return new Response(
      JSON.stringify({ error: error?.message || "Internal Server Error" }),
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

export const config = {
  path: "/api/ask",
  rateLimit: {
    windowLimit: 10,
    windowSize: 60,
    aggregateBy: ["ip"],
  },
};
