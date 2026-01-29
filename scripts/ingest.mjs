import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "..");
const DEFAULT_INPUT_DIR = path.resolve(appRoot, "json_outputs_folder");
const DEFAULT_OUTPUT_PATH = path.resolve(appRoot, "data", "chunks.jsonl");
const PDF_BASE_URL = process.env.PDF_BASE_URL || "/pdfs";

const MIN_PARAS = 4;
const MAX_PARAS = 6;
const MIN_WORDS = 350;
const MAX_WORDS = 800;
const EMBED_BATCH = Number(process.env.EMBED_BATCH || 32);
const PINECONE_NAMESPACE = process.env.PINECONE_NAMESPACE || "default";
const EMBEDDING_MODEL = "text-embedding-3-large";

function loadEnvFile(filePath) {
  return fs
    .readFile(filePath, "utf8")
    .then((raw) => {
      for (const line of raw.split(/\r?\n/)) {
        if (!line || line.trim().startsWith("#")) continue;
        const idx = line.indexOf("=");
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim();
        let value = line.slice(idx + 1).trim();
        if (!key) continue;
        if (
          (value.startsWith("\"") && value.endsWith("\"")) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (!(key in process.env)) {
          process.env[key] = value;
        }
      }
    })
    .catch(() => null);
}

function requireEnv(key) {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function isHeading(type) {
  return type === "Title" || type === "Header";
}

function shouldSkipElement(element) {
  if (!element || !element.text) return true;
  if (element.type === "Footer" || element.type === "PageBreak") return true;
  const trimmed = element.text.trim();
  if (!trimmed) return true;
  if (/^Downloaded:/i.test(trimmed)) return true;
  if (/^©\s*\d{4}/i.test(trimmed)) return true;
  return false;
}

function isContentElement(element) {
  if (shouldSkipElement(element)) return false;
  if (isHeading(element.type)) return false;
  return true;
}

function countWords(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).length;
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function makeChunkId(docId, index, elementIds) {
  const hash = crypto
    .createHash("sha256")
    .update(`${docId}|${index}|${elementIds.join("|")}`)
    .digest("hex")
    .slice(0, 16);
  return `${slugify(docId)}-${index}-${hash}`;
}

function getSectionPath(element, elementsById, docTitle) {
  const pathParts = [];
  let cursor = element;

  while (cursor?.metadata?.parent_id) {
    const parent = elementsById.get(cursor.metadata.parent_id);
    if (!parent) break;
    if (isHeading(parent.type) && parent.text) {
      pathParts.unshift(normalizeText(parent.text));
    }
    cursor = parent;
  }

  if (!pathParts.length && docTitle) return docTitle;
  return pathParts.join(" > ") || docTitle || "";
}

async function embedBatch(texts) {
  const apiKey = requireEnv("OPENAI_API_KEY");
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: texts,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI embeddings error: ${res.status} ${errText}`);
  }

  const data = await res.json();
  return data.data.map((item) => item.embedding);
}

async function pineconeUpsert(vectors) {
  const apiKey = requireEnv("PINECONE_API_KEY");
  const host = requireEnv("PINECONE_HOST");
  const url = `${host.replace(/\/$/, "")}/vectors/upsert`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Api-Key": apiKey,
    },
    body: JSON.stringify({
      vectors,
      namespace: PINECONE_NAMESPACE,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Pinecone upsert error: ${res.status} ${errText}`);
  }
}

async function buildChunksForFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const elements = JSON.parse(raw);
  const elementsById = new Map();

  for (const el of elements) {
    if (el?.element_id) elementsById.set(el.element_id, el);
  }

  const titleEl = elements.find((el) => el?.type === "Title" && el.text?.trim());
  const docTitle = titleEl ? normalizeText(titleEl.text) : null;

  const contentItems = [];
  const pageParaCount = new Map();

  for (const el of elements) {
    if (!isContentElement(el)) continue;
    const pageNumber = el.metadata?.page_number ?? 0;
    const nextCount = (pageParaCount.get(pageNumber) ?? 0) + 1;
    pageParaCount.set(pageNumber, nextCount);

    contentItems.push({
      element_id: el.element_id,
      type: el.type,
      text: normalizeText(el.text),
      page_number: pageNumber,
      para_index: nextCount,
      parent_id: el.metadata?.parent_id ?? null,
      section_path: getSectionPath(el, elementsById, docTitle || ""),
      content_type: el.type === "Table" ? "table" : "text",
      doc_id: el.metadata?.filename ?? null,
    });
  }

  const chunks = [];
  let current = null;
  let chunkIndex = 0;

  const flushChunk = () => {
    if (!current) return;
    const text = current.text_parts.join("\n\n");
    const chunkId = makeChunkId(current.doc_id, chunkIndex, current.element_ids);
    const sourceUrl = `${PDF_BASE_URL}/${encodeURIComponent(current.doc_id)}#page=${current.page_start}`;

    chunks.push({
      chunk_id: chunkId,
      doc_id: current.doc_id,
      doc_title: current.doc_title,
      page_start: current.page_start,
      page_end: current.page_end,
      para_start: current.para_start,
      para_end: current.para_end,
      section_path: current.section_path,
      content_type: current.content_types.size === 1 ? [...current.content_types][0] : "mixed",
      element_ids: current.element_ids,
      text,
      source_url: sourceUrl,
      chunk_index: chunkIndex,
    });

    chunkIndex += 1;
    current = null;
  };

  for (const item of contentItems) {
    const fallbackDocId = path.basename(filePath).replace(/\.json$/i, ".pdf");
    const resolvedDocId = item.doc_id || fallbackDocId;

    if (!current) {
      current = {
        doc_id: resolvedDocId,
        doc_title: docTitle || resolvedDocId.replace(/\.pdf$/i, ""),
        section_path: item.section_path,
        page_start: item.page_number,
        page_end: item.page_number,
        para_start: item.para_index,
        para_end: item.para_index,
        element_ids: [item.element_id],
        text_parts: [item.text],
        word_count: countWords(item.text),
        para_count: 1,
        content_types: new Set([item.content_type]),
      };
      continue;
    }

    const sectionChanged = item.section_path !== current.section_path;
    const pageChanged = item.page_number !== current.page_end;
    const nextWordCount = current.word_count + countWords(item.text);
    const tooManyParas = current.para_count >= MAX_PARAS;
    const wordsOverflow = nextWordCount > MAX_WORDS && current.para_count >= MIN_PARAS;

    if (sectionChanged || pageChanged || tooManyParas || wordsOverflow) {
      flushChunk();
      current = {
        doc_id: resolvedDocId,
        doc_title: docTitle || resolvedDocId.replace(/\.pdf$/i, ""),
        section_path: item.section_path,
        page_start: item.page_number,
        page_end: item.page_number,
        para_start: item.para_index,
        para_end: item.para_index,
        element_ids: [item.element_id],
        text_parts: [item.text],
        word_count: countWords(item.text),
        para_count: 1,
        content_types: new Set([item.content_type]),
      };
      continue;
    }

    current.page_end = item.page_number;
    current.para_end = item.para_index;
    current.element_ids.push(item.element_id);
    current.text_parts.push(item.text);
    current.word_count = nextWordCount;
    current.para_count += 1;
    current.content_types.add(item.content_type);
  }

  flushChunk();
  return chunks;
}

async function run() {
  await loadEnvFile(path.resolve(appRoot, ".env.local"));
  await loadEnvFile(path.resolve(appRoot, ".env"));
  await loadEnvFile(path.resolve(process.cwd(), ".env.local"));
  await loadEnvFile(path.resolve(process.cwd(), ".env"));

  let inputDir = process.env.JSON_INPUT_DIR || DEFAULT_INPUT_DIR;
  try {
    await fs.stat(inputDir);
  } catch {
    const fallbackDir = path.resolve(appRoot, "..", "json_outputs_folder");
    try {
      await fs.stat(fallbackDir);
      inputDir = fallbackDir;
    } catch {
      throw new Error(`JSON input directory not found. Set JSON_INPUT_DIR. Tried: ${inputDir}, ${fallbackDir}`);
    }
  }
  const outputPath = process.env.CHUNKS_OUT || DEFAULT_OUTPUT_PATH;

  const files = await fs.readdir(inputDir);
  const jsonFiles = files.filter((file) => file.toLowerCase().endsWith(".json"));

  if (!jsonFiles.length) {
    console.log("No JSON files found in", inputDir);
    return;
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, "");

  const allChunks = [];

  for (const file of jsonFiles) {
    const filePath = path.join(inputDir, file);
    const chunks = await buildChunksForFile(filePath);
    allChunks.push(...chunks);
  }

  for (const chunk of allChunks) {
    await fs.appendFile(outputPath, JSON.stringify(chunk) + "\n");
  }

  console.log(`Prepared ${allChunks.length} chunks. Writing embeddings in batches of ${EMBED_BATCH}.`);

  for (let i = 0; i < allChunks.length; i += EMBED_BATCH) {
    const batch = allChunks.slice(i, i + EMBED_BATCH);
    const embeddings = await embedBatch(batch.map((c) => c.text));

    const vectors = batch.map((chunk, idx) => ({
      id: chunk.chunk_id,
      values: embeddings[idx],
      metadata: {
        doc_id: chunk.doc_id,
        doc_title: chunk.doc_title,
        page_start: chunk.page_start,
        page_end: chunk.page_end,
        para_start: chunk.para_start,
        para_end: chunk.para_end,
        section_path: chunk.section_path,
        content_type: chunk.content_type,
        element_ids: chunk.element_ids,
        source_url: chunk.source_url,
        text: chunk.text,
      },
    }));

    await pineconeUpsert(vectors);
    console.log(`Upserted ${i + batch.length}/${allChunks.length}`);
  }

  console.log("Ingestion complete.");
}

run().catch((err) => {
  console.error("Ingestion failed:", err.message);
  process.exit(1);
});
