# Litigation RAG Project Overview

Last updated: 2026-01-30

## 1) Purpose and scope
Build a Retrieval-Augmented Generation (RAG) chatbot over the Uniform Rules of Court (High Court Rules) of South Africa with precise provenance. Every answer must be grounded in source text and show the exact file, page, and paragraph range for verification.

Non-goals (for now):
- No persistence layer for chat history (memory only).
- No reranker or cross-encoder; retrieval is via dense/sparse + fusion.
- No user auth or multi-tenant routing.

---

## 2) High-level architecture

Pipeline stages:
1. **Ingestion**: Parse Unstructured JSON, build paragraph indices, chunk text by section/page, and attach rich metadata.
2. **Vector storage**:
   - Dense index (OpenAI embeddings) in Pinecone.
   - Sparse index (Pinecone integrated sparse embeddings).
3. **Retrieval**: Dense, sparse, or hybrid (RRF fusion).
4. **Answering**: OpenRouter chat completion constrained to return JSON and cite chunk IDs from retrieved sources.
5. **UI**: Full-page chat, citations rendered as pills linking to PDFs in a new tab.

---

## 3) Source data and structure

### Input files
- Unstructured.io JSON outputs live in `application/json_outputs_folder/`.
- PDFs live in `application/public/pdfs/` to support deep links (`/pdfs/<file>#page=N`).

### What counts as a paragraph
Each Unstructured element (e.g., `NarrativeText`, `Table`) is treated as a **single paragraph**. Paragraph indices are assigned **per page** as we iterate content elements in order.

### Filtering
During ingestion, non-content elements are removed (headers, footers, page breaks, boilerplate). Only content-bearing elements are used to form chunks.

---

## 4) Chunking strategy (exactness first)

Goals:
- Preserve paragraph boundaries (never split a paragraph).
- Keep chunks page-bounded whenever possible.
- Keep chunks aligned with section hierarchy (headings/Title).

Algorithm (dense + sparse use the same chunks):
- Build a `section_path` from the heading hierarchy via `parent_id` links.
- Iterate content elements and aggregate into a chunk until one of these conditions triggers a flush:
  - section changes
  - page changes
  - paragraph count exceeds limit
  - word count exceeds limit (only after minimum paragraphs)

Target chunk size: 4–6 paragraphs (~350–800 words), but page/section boundaries take precedence.

---

## 5) Metadata model (what we store and why)

Each chunk stores the following metadata (used for citations and UI):

- `chunk_id`: stable ID used for citations
  - Built as: `slug(doc_id)-<chunk_index>-<sha256(element_ids)>`
- `doc_id`: PDF filename (e.g., `Rule 66.pdf`)
- `doc_title`: derived from the first Title element
- `page_start`, `page_end`: page range covered by the chunk
- `para_start`, `para_end`: paragraph indices on `page_start`
- `section_path`: heading chain for navigation and filtering
- `element_ids[]`: exact Unstructured element IDs in the chunk
- `content_type`: `text`, `table`, or `mixed`
- `source_url`: `/pdfs/<doc_id>#page=<page_start>`
- `text`: plain text content used for embeddings and retrieval

Why this matters:
- `page_start` + `para_start` + `para_end` give exact provenance.
- `element_ids` allow future cross-checks or re-rendering if needed.
- `section_path` supports UI grouping and interpretation.

---

## 6) Dense embeddings (OpenAI)

- Model: `text-embedding-3-large`
- Dimensions: 3072
- Metric: cosine

Ingestion writes vectors using the Pinecone REST endpoint `/vectors/upsert`:
- `id`: `chunk_id`
- `values`: embedding vector
- `metadata`: all provenance fields listed above

Script: `application/scripts/ingest.mjs`

Run:
```
cd application
bun scripts/ingest.mjs
```

---

## 7) Sparse embeddings (Pinecone integrated)

The sparse index uses Pinecone managed embeddings (`pinecone-sparse-english-v0`) and stores only metadata + text.

Upsert uses the Pinecone SDK:
- `_id`: `chunk_id`
- `text`: chunk text
- `metadata`: same provenance fields as dense

Script: `application/scripts/ingest_sparse.mjs`

Run:
```
cd application
bun scripts/ingest_sparse.mjs
```

Rate limiting support:
```
SPARSE_UPSERT_BATCH=16
SPARSE_UPSERT_DELAY_MS=1500
SPARSE_UPSERT_MAX_RETRIES=8
```

---

## 8) Retrieval (dense, sparse, hybrid)

### Dense retrieval
- Embed query with OpenAI.
- Query Pinecone `/query` with `includeMetadata: true`.

### Sparse retrieval
- Use Pinecone `searchRecords()` with `inputs: { text: <query> }`.
- Select fields required for citations (`doc_id`, `page_start`, `para_start`, etc.).

### Hybrid retrieval (RRF fusion)
- Combines dense + sparse results using Reciprocal Rank Fusion (k=60).
- Dedupes by `chunk_id`.
- Returns top-K across both rankers.

Top-K settings:
- `RAG_TOP_K` (global)
- `RAG_DENSE_TOP_K`
- `RAG_SPARSE_TOP_K`

---

## 9) Answer generation and citations

### Prompt construction
The server builds a Sources block for each retrieved chunk:
```
Source N
chunk_id: <id>
Doc: <doc_id>
Page: <page_start>
Paragraphs: <para_start>-<para_end>
Section: <section_path>
Text: <chunk text>
```

The user message is wrapped as:
```
User message:
<question>

Context sources (use only if relevant):
<sources>
```

The system prompt is loaded from `system_prompt.txt` (cached in memory). A fallback prompt is used if the file is missing.

### OpenRouter response
- Preferred: structured output via `response_format: { type: "json_schema" }`
- Fallback: prompt-only JSON instruction

Expected output:
```
{ "answer": "...", "citations": ["chunk_id_1", "chunk_id_2"] }
```

The server:
- Logs the raw response and Sources payload.
- Parses JSON (with fallback extraction).
- Filters citations to those returned by retrieval (prevents hallucinated IDs).
- Streams tokens to the client as NDJSON when `stream: true` is requested.
- Strips any inline citation markers (e.g., `cite...`) from the answer text.

---

## 10) Conversation history (memory only)

- The client keeps full chat history in React state.
- Each request includes `messages[]` (user + assistant).
- The server uses only **messages before the latest user turn** as history.
- The **current Sources block is attached only to the current user question**.
- Old sources are not re-sent; citations must come from current sources.
- Assistant history includes a small "Prior citations" appendix (context only) so the model knows which sources earlier answers were grounded on.

Config:
```
RAG_HISTORY_MAX_MESSAGES=12
```

This is memory-only. History is lost on refresh or server restart.

---

## 11) UI behavior

Main chat UI: `application/app/page.tsx`
- Full-page chat
- Retrieval mode toggle is currently commented out in the UI (default is Hybrid).
- Citation pills show `doc_id · page · paragraph range`.
- Pills open `/pdfs/<doc_id>` in a new tab (no in-app reader/highlighting).
- Shows a typing indicator while waiting for the first token.
- "New chat" clears the local chat history.

Test page: `application/app/test/page.tsx`
- Plain chat to OpenRouter without retrieval or citations.

---

## 12) Pinecone configuration

Dense index:
- Name: `chatbot`
- Metric: cosine
- Dimension: 3072
- Host: `https://chatbot-x9yqrsj.svc.aped-4627-b74a.pinecone.io`

Sparse index:
- Name: `sparselitigation`
- Type: sparse (serverless)
- Model: `pinecone-sparse-english-v0`
- Metric: dotproduct
- Host: `https://sparselitigation-x9yqrsj.svc.aped-4627-b74a.pinecone.io`

---

## 13) Environment variables

Required:
```
OPENAI_API_KEY=...
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=...
PINECONE_API_KEY=...
PINECONE_INDEX=chatbot
PINECONE_HOST=https://chatbot-x9yqrsj.svc.aped-4627-b74a.pinecone.io
PINECONE_INDEX_SPARSE=sparselitigation
PINECONE_HOST_SPARSE=https://sparselitigation-x9yqrsj.svc.aped-4627-b74a.pinecone.io
```

Optional:
```
PINECONE_NAMESPACE=default
RAG_TOP_K=8
RAG_DENSE_TOP_K=8
RAG_SPARSE_TOP_K=8
RAG_HISTORY_MAX_MESSAGES=12
OPENROUTER_STRUCTURED_OUTPUT=true
OPENROUTER_TEMPERATURE=0.2
OPENROUTER_TIMEOUT_MS=60000
OPENROUTER_SITE_URL=...
OPENROUTER_APP_NAME=...
```

---

## 14) Key files

- `application/scripts/ingest.mjs` (dense ingestion)
- `application/scripts/ingest_sparse.mjs` (sparse ingestion)
- `application/app/api/chat/route.ts` (retrieval + OpenRouter)
- `application/app/api/test-chat/route.ts` (no-retrieval test chat)
- `application/app/page.tsx` (chat UI)
- `application/app/test/page.tsx` (test chat UI)
- `application/app/globals.css` (theme styles)
- `application/system_prompt.txt` (system prompt loaded by the API)
- `application/system_prompt_feedback.txt` (feedback notes)

---

## 15) Troubleshooting tips

- **"Missing OPENAI_API_KEY"**: ensure `.env.local` is in `application/` and the script loads it. The script tries both `application/.env.local` and the current directory.
- **"ENOENT json_outputs_folder"**: run scripts from `application/` or set the correct path.
- **"I could not find anything relevant"**: retrieval returned 0 matches. Check ingestion, index names, and namespaces.
- **Sparse ingestion 429**: reduce `SPARSE_UPSERT_BATCH` and increase delay.
- **Wrong citations**: ensure PDFs are in `public/pdfs` and filenames match `doc_id`.
- **Citations open the wrong file**: check `doc_id` formatting in chunk metadata.

---

## 16) How citations are produced

1. Retrieval returns `matches` with `chunk_id` + metadata.
2. Sources block is assembled from these matches and passed to the model.
3. The model returns `citations` as an array of `chunk_id` strings.
4. The server validates those IDs and returns metadata to the UI.
5. The UI renders pills and links to `/pdfs/<doc_id>` in a new tab.

This guarantees that every citation corresponds to a retrieved chunk.
