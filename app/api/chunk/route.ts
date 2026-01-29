import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";

function requireEnv(key: string) {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

type ChunkRecord = {
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

let chunkIndex: Map<string, ChunkRecord> | null = null;

async function loadChunkIndex() {
  if (chunkIndex) return chunkIndex;

  const appRoot = process.cwd();
  const filePath = path.resolve(appRoot, "data", "chunks.jsonl");
  const raw = await fs.readFile(filePath, "utf8");
  const map = new Map<string, ChunkRecord>();

  raw.split(/\r?\n/).forEach((line) => {
    if (!line.trim()) return;
    try {
      const item = JSON.parse(line);
      if (item?.chunk_id) {
        map.set(item.chunk_id, {
          chunk_id: item.chunk_id,
          doc_id: item.doc_id ?? null,
          doc_title: item.doc_title ?? null,
          page_start: item.page_start ?? item.page ?? null,
          page_end: item.page_end ?? item.page ?? null,
          para_start: item.para_start ?? null,
          para_end: item.para_end ?? null,
          section_path: item.section_path ?? null,
          source_url: item.source_url ?? null,
          content_type: item.content_type ?? null,
          text: item.text ?? "",
        });
      }
    } catch {
      // ignore malformed lines
    }
  });

  chunkIndex = map;
  return map;
}

async function getChunkFromLocal(id: string) {
  try {
    const index = await loadChunkIndex();
    return index.get(id) || null;
  } catch (error) {
    console.warn("[Chunk API] Local index load failed:", error);
    return null;
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");

    if (!id) {
      return Response.json({ error: "Missing chunk id" }, { status: 400 });
    }

    let metadata: any = null;

    try {
      const apiKey = requireEnv("PINECONE_API_KEY");
      const host = requireEnv("PINECONE_HOST");
      const namespace = process.env.PINECONE_NAMESPACE || "default";

      const res = await fetch(`${host.replace(/\/$/, "")}/vectors/fetch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Api-Key": apiKey,
        },
        body: JSON.stringify({
          ids: [id],
          namespace,
          includeMetadata: true,
        }),
      });

      const rawText = await res.text();
      if (!res.ok) {
        throw new Error(`Pinecone fetch error: ${res.status} ${rawText || res.statusText}`);
      }
      if (!rawText) {
        throw new Error(`Pinecone fetch error: ${res.status} Empty response body`);
      }

      let data: any;
      try {
        data = JSON.parse(rawText);
      } catch {
        throw new Error(`Pinecone fetch error: Invalid JSON response: ${rawText}`);
      }
      const vector =
        data?.vectors?.[id] || Object.values(data?.vectors || {})?.[0];
      metadata = vector?.metadata || null;
    } catch (error) {
      console.warn("[Chunk API] Pinecone fetch failed, falling back to local index:", error);
    }

    if (!metadata) {
      const local = await getChunkFromLocal(id);
      if (local) return Response.json(local);
      return Response.json({ error: "Chunk not found" }, { status: 404 });
    }

    return Response.json({
      chunk_id: id,
      doc_id: metadata.doc_id ?? null,
      doc_title: metadata.doc_title ?? null,
      page_start: metadata.page_start ?? metadata.page ?? null,
      page_end: metadata.page_end ?? metadata.page ?? null,
      para_start: metadata.para_start ?? null,
      para_end: metadata.para_end ?? null,
      section_path: metadata.section_path ?? null,
      source_url: metadata.source_url ?? null,
      content_type: metadata.content_type ?? null,
      text: metadata.text ?? "",
    });
  } catch (error: any) {
    console.error("Chunk API error", error);
    return Response.json(
      { error: error.message || "Unexpected error" },
      { status: 500 }
    );
  }
}
