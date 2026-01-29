"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Highlight,
  PdfHighlighter,
  PdfLoader,
  type T_Highlight,
  type T_LTWH,
} from "react-pdf-highlighter";

type ChunkPayload = {
  chunk_id: string;
  doc_id: string | null;
  doc_title: string | null;
  page_start: number | null;
  page_end: number | null;
  para_start: number | null;
  para_end: number | null;
  section_path: string | null;
  source_url: string | null;
  content_type: string | null;
  text: string;
};

type TokenMatch = { start: number; end: number };

const MAX_TOKENS_PER_NEEDLE = 80;

function viewportToScaled(rect: T_LTWH, viewport: { width: number; height: number }) {
  return {
    x1: rect.left,
    y1: rect.top,
    x2: rect.left + rect.width,
    y2: rect.top + rect.height,
    width: viewport.width,
    height: viewport.height,
    pageNumber: (rect as any).pageNumber,
  };
}

function normalizeToken(token: string) {
  return token.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function tokenize(text: string) {
  return text
    .split(/\s+/)
    .map((token) => normalizeToken(token))
    .filter(Boolean);
}

function unionRects(rects: T_LTWH[]) {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;

  rects.forEach((rect) => {
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.left + rect.width);
    bottom = Math.max(bottom, rect.top + rect.height);
  });

  if (!Number.isFinite(left) || !Number.isFinite(top)) {
    return null;
  }

  return {
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  } satisfies T_LTWH;
}

function findTokenMatch(
  stream: Array<{ token: string; itemIndex: number }>,
  needle: string[]
): TokenMatch | null {
  if (!needle.length || needle.length > stream.length) return null;

  for (let i = 0; i <= stream.length - needle.length; i += 1) {
    let match = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (stream[i + j].token !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      return { start: i, end: i + needle.length - 1 };
    }
  }

  return null;
}

async function buildHighlightsFromText(
  pdfDocument: any,
  pageNumber: number,
  text: string
): Promise<T_Highlight[]> {
  const page = await pdfDocument.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const textContent = await page.getTextContent();

  const items = (textContent.items || [])
    .map((item: any) => {
      const rawText = String(item.str || "");
      if (!rawText.trim()) return null;

      const width = Number(item.width || 0);
      const height = Number(item.height || Math.abs(item.transform?.[3] || 0));
      const x = Number(item.transform?.[4] || 0);
      const y = Number(item.transform?.[5] || 0);

      const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([
        x,
        y,
        x + width,
        y + height,
      ]);
      const rect: T_LTWH = {
        left: Math.min(x1, x2),
        top: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1),
      };

      return { text: rawText, rect };
    })
    .filter(Boolean) as Array<{ text: string; rect: T_LTWH }>;

  if (!items.length) return [];

  const tokenStream: Array<{ token: string; itemIndex: number }> = [];
  items.forEach((item, itemIndex) => {
    const tokens = tokenize(item.text);
    tokens.forEach((token) => tokenStream.push({ token, itemIndex }));
  });

  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const needles = paragraphs.length ? paragraphs : [text];

  const toScaled = (rect: T_LTWH) =>
    viewportToScaled(rect, { width: viewport.width, height: viewport.height });

  const highlights: T_Highlight[] = [];

  needles.forEach((needle, idx) => {
    const tokens = tokenize(needle).slice(0, MAX_TOKENS_PER_NEEDLE);
    if (!tokens.length) return;

    const match = findTokenMatch(tokenStream, tokens);
    if (!match) return;

    const itemIndices = new Set<number>();
    for (let i = match.start; i <= match.end; i += 1) {
      itemIndices.add(tokenStream[i].itemIndex);
    }

    const rects = Array.from(itemIndices).map((itemIndex) => items[itemIndex].rect);
    const boundingRect = unionRects(rects);
    if (!boundingRect) return;

    highlights.push({
      id: `auto-${pageNumber}-${idx}`,
      position: {
        pageNumber,
        boundingRect: toScaled(boundingRect),
        rects: rects.map(toScaled),
      },
      content: { text: needle },
      comment: { text: "citation", emoji: "📌" },
    });
  });

  if (highlights.length) return highlights;

  const fallbackTokens = tokenize(text).slice(0, MAX_TOKENS_PER_NEEDLE);
  if (!fallbackTokens.length) return [];

  const fallbackMatch = findTokenMatch(tokenStream, fallbackTokens);
  if (!fallbackMatch) return [];

  const fallbackIndices = new Set<number>();
  for (let i = fallbackMatch.start; i <= fallbackMatch.end; i += 1) {
    fallbackIndices.add(tokenStream[i].itemIndex);
  }
  const fallbackRects = Array.from(fallbackIndices).map(
    (itemIndex) => items[itemIndex].rect
  );
  const fallbackBounding = unionRects(fallbackRects);
  if (!fallbackBounding) return [];

  return [
    {
      id: `auto-${pageNumber}-fallback`,
      position: {
        pageNumber,
        boundingRect: toScaled(fallbackBounding),
        rects: fallbackRects.map(toScaled),
      },
      content: { text },
      comment: { text: "citation", emoji: "📌" },
    },
  ];
}

function PdfHighlighterShell({
  pdfDocument,
  highlights,
  onDocumentReady,
  scrollRef,
}: {
  pdfDocument: any;
  highlights: T_Highlight[];
  onDocumentReady: (doc: any) => void;
  scrollRef: (scrollTo: any) => void;
}) {
  useEffect(() => {
    if (pdfDocument) onDocumentReady(pdfDocument);
  }, [pdfDocument, onDocumentReady]);

  return (
    <PdfHighlighter
      pdfDocument={pdfDocument}
      enableAreaSelection={() => false}
      onScrollChange={() => undefined}
      scrollRef={scrollRef}
      onSelectionFinished={() => null}
      highlightTransform={(highlight, index, _setTip, _hideTip, _toScaled, _screenshot, isScrolledTo) => (
        <Highlight
          key={highlight.id || index}
          position={highlight.position}
          comment={highlight.comment}
          isScrolledTo={isScrolledTo}
        />
      )}
      highlights={highlights}
    />
  );
}

export default function ReaderPage() {
  const searchParams = useSearchParams();
  const chunkId = searchParams.get("chunk") || "";

  const [chunk, setChunk] = useState<ChunkPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [highlights, setHighlights] = useState<T_Highlight[]>([]);
  const [highlightStatus, setHighlightStatus] = useState("Loading highlight...");
  const scrollToRef = useRef<any>(null);
  const pdfDocRef = useRef<any>(null);
  const [docReady, setDocReady] = useState(0);

  const pageNumber = chunk?.page_start ?? null;

  const pdfUrl = useMemo(() => {
    if (!chunk?.doc_id) return "";
    return `/pdfs/${encodeURIComponent(chunk.doc_id)}`;
  }, [chunk?.doc_id]);

  useEffect(() => {
    if (!chunkId) {
      setError("Missing chunk id.");
      return;
    }

    let active = true;
    setError(null);
    setChunk(null);
    setHighlights([]);
    setHighlightStatus("Loading chunk data...");

    fetch(`/api/chunk?id=${encodeURIComponent(chunkId)}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "Failed to load chunk");
        if (active) setChunk(data);
      })
      .catch((err) => {
        if (active) setError(err.message || "Failed to load chunk");
      });

    return () => {
      active = false;
    };
  }, [chunkId]);

  useEffect(() => {
    if (!pdfDocRef.current || !chunk?.text || !pageNumber) return;

    let active = true;
    setHighlightStatus("Finding text on page...");

    buildHighlightsFromText(pdfDocRef.current, pageNumber, chunk.text)
      .then((nextHighlights) => {
        if (!active) return;
        setHighlights(nextHighlights);
        setHighlightStatus(
          nextHighlights.length
            ? `Highlighted ${nextHighlights.length} segment(s).`
            : "Could not auto-highlight this text."
        );
        if (nextHighlights.length && scrollToRef.current) {
          scrollToRef.current(nextHighlights[0]);
        }
      })
      .catch((err) => {
        if (!active) return;
        setHighlightStatus("Highlighting failed.");
        console.error(err);
      });

    return () => {
      active = false;
    };
  }, [docReady, chunk?.text, pageNumber]);

  if (!chunkId) {
    return (
      <div className="min-h-screen bg-(--panel) p-10 text-foreground">
        <p>Missing chunk id.</p>
        <Link href="/" className="text-(--accent)">
          Back to chat
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-(--panel) text-foreground">
      <header className="flex flex-col gap-2 border-b border-(--stroke) bg-white/70 px-6 py-4">
        <div className="flex items-center justify-between">
          <Link href="/" className="text-sm font-semibold text-(--accent)">
            Back to chat
          </Link>
          <span className="text-xs uppercase tracking-(0.2em) text-(--muted)">
            PDF Reader
          </span>
        </div>
        <div className="text-sm text-(--muted)">
          {chunk?.doc_id || "Loading PDF..."} {pageNumber ? `· page ${pageNumber}` : ""}
        </div>
        <div className="text-xs text-(--muted)">{highlightStatus}</div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-6">
        {error ? (
          <div className="rounded-2xl border border-(--stroke) bg-white p-6 text-sm">
            {error}
          </div>
        ) : null}

        {!error && !pdfUrl ? (
          <div className="rounded-2xl border border-(--stroke) bg-white p-6 text-sm">
            Loading PDF...
          </div>
        ) : null}

        {!error && pdfUrl ? (
          <div className="relative h-(85vh) overflow-hidden rounded-2xl border border-(--stroke) bg-white">
            <PdfLoader url={pdfUrl} beforeLoad={<div className="p-6">Loading PDF...</div>}>
              {(pdfDocument) => {
                return (
                  <PdfHighlighterShell
                    pdfDocument={pdfDocument}
                    highlights={highlights}
                    scrollRef={(scrollTo) => {
                      scrollToRef.current = scrollTo;
                    }}
                    onDocumentReady={(doc) => {
                      if (pdfDocRef.current !== doc) {
                        pdfDocRef.current = doc;
                        setDocReady((value) => value + 1);
                      }
                    }}
                  />
                );
              }}
            </PdfLoader>
          </div>
        ) : null}
      </main>
    </div>
  );
}
