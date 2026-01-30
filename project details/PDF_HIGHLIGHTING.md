# PDF Highlighting (Deprecated)

Last updated: 2026-01-30

## Status
PDF highlighting and the in-app reader have been removed. Citation pills now open the PDF directly in a new browser tab (`/pdfs/<doc_id>`).

This document is kept for historical context only. If highlighting is reintroduced, use this as a starting point.

## Previous data flow (removed)
1. Chat returns citations with `chunk_id`, `doc_id`, `page_start`, `para_start`, `para_end`.
2. Clicking a pill routed to `/reader?chunk=<chunk_id>`.
3. `/reader` called `/api/chunk?id=<chunk_id>` to fetch the full chunk metadata + text.
4. The PDF viewer loaded `/public/pdfs/<doc_id>` and tried to text‑match the chunk text on the given page.
5. If a match was found, highlight rectangles were drawn on the text layer and the viewer scrolled to the first highlight.

## If reintroducing later
Recreate a `/reader` page, add a chunk lookup route, and reintroduce a PDF highlighter (PDF.js based).
