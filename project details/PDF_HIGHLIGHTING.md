# PDF Highlighting (No Re-ingestion)

Last updated: 2026-01-29

## Goal
Allow users to click a citation pill and open a PDF viewer that:
- loads the referenced PDF immediately
- scrolls to the correct page
- highlights the relevant paragraph range (best-effort, no re-ingestion)

## Library choice
We use **react-pdf-highlighter** (PDF.js-based) because it provides:
- client-side PDF rendering
- highlight overlays
- programmatic control to scroll to highlights

## Data flow
1. Chat returns citations with `chunk_id`, `doc_id`, `page_start`, `para_start`, `para_end`.
2. Clicking a pill routes to `/reader?chunk=<chunk_id>`.
3. `/reader` calls `/api/chunk?id=<chunk_id>` to fetch the full chunk metadata + text.
4. The PDF viewer loads `/public/pdfs/<doc_id>` and tries to **text-match** the chunk text on the given page.
5. If a match is found, highlight rectangles are drawn on the text layer and the viewer scrolls to the first highlight.

## Text-matching approach (no re-ingestion)
We do **token-based text matching** on the target page:
- Extract text items from PDF.js for the target page.
- Tokenize both the PDF text items and the chunk text.
- Search for a contiguous token sequence match.
- Convert matched text item rectangles into highlight overlays.

This is fast and avoids re-ingesting PDFs, but it is **best-effort**.

## Current limitations
- **Hyphenation/OCR artifacts** can prevent exact token matches.
- **Repeated phrases** might match the wrong location if the text appears multiple times on a page.
- **Very long paragraphs** are truncated to a fixed token budget for matching.
- Highlight positions are derived from PDF text items, which can be slightly offset depending on the PDF’s internal layout.

## Future accuracy upgrades
1. **Bounding-box ingestion**  
   If Unstructured outputs element coordinates, store `bboxes[]` per element and use those for exact highlights.

2. **PDF text alignment cache**  
   Cache PDF text items per page and build an index for faster and more reliable matching.

3. **Exact paragraph lookup**  
   Store paragraph-level text (instead of chunk text) to reduce ambiguity and improve matching precision.

4. **Fallback UI**  
   If no highlight can be found, show a “Could not auto-highlight” banner but still open the correct page.

## Files involved
- `application/app/reader/page.tsx` (PDF viewer + highlighting)
- `application/app/api/chunk/route.ts` (chunk lookup by id)
- `application/app/page.tsx` (citation pill link -> reader route)

## Config requirements
- PDFs must exist in `application/public/pdfs/`
- `PINECONE_HOST`, `PINECONE_API_KEY`, and `PINECONE_NAMESPACE` must allow vector fetch for chunk metadata.
