import { NextRequest } from "next/server";
import { Pinecone } from "@pinecone-database/pinecone";
import fs from "fs/promises";
import path from "path";

export const runtime = "nodejs";

const OPENAI_EMBEDDING_MODEL = "text-embedding-3-large";
const DEFAULT_TOP_K = Number(process.env.RAG_TOP_K || 8);
const DEFAULT_DENSE_TOP_K = Number(process.env.RAG_DENSE_TOP_K || DEFAULT_TOP_K);
const DEFAULT_SPARSE_TOP_K = Number(process.env.RAG_SPARSE_TOP_K || DEFAULT_TOP_K);
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
const DEFAULT_TEMPERATURE = (() => {
  const raw = process.env.OPENROUTER_TEMPERATURE;
  if (raw === undefined) return 0.2;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0.2;
})();
const DEFAULT_OPENROUTER_TIMEOUT_MS = (() => {
  const raw = process.env.OPENROUTER_TIMEOUT_MS;
  if (raw === undefined) return 60000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60000;
})();
const SYSTEM_PROMPT_PATH = path.resolve(process.cwd(), "system_prompt.txt");
const FALLBACK_SYSTEM_PROMPT =
  "You are a legal assistant specializing exclusively in the Uniform Rules of Court (High Court Rules) of South Africa. " +
  "You must only answer questions that are specifically about these High Court Rules and are supported by the provided Sources. " +
  "If the user’s request is not about the Uniform Rules of Court (High Court Rules) of South Africa, or if the Sources do not contain the answer, respond that you cannot answer within this scope. " +
  "Do not answer general knowledge or unrelated legal topics. " +
  "Always use the provided Sources when answering legal questions, and cite only from the current Sources block. " +
  "You may be given prior questions and answers in the conversation history, sometimes with prior citations. " +
  "Treat those prior answers as correct within scope and based on their cited sources at the time. " +
  "If the user asks to confirm or follow up on a prior answer (e.g., “are you sure?”), you may affirm it based on the prior answer and its citations, but do not cite prior citations for new answers. " +
  "Do not include inline citations, chunk IDs, or citation markers inside the answer text. Return citations only in the citations array. " +
  "Return a JSON object with exactly these keys: answer (string) and citations (array of chunk_id strings; empty if no sources were used). " +
  "The answer string must be written in markdown. " +
  "Do not include any extra keys, explanations, or markdown outside the JSON object.";
let cachedSystemPrompt: string | null = null;
async function loadSystemPrompt() {
  if (cachedSystemPrompt) return cachedSystemPrompt;
  try {
    const data = await fs.readFile(SYSTEM_PROMPT_PATH, "utf8");
    const trimmed = data.trim();
    if (trimmed.length > 0) {
      cachedSystemPrompt = trimmed;
      return trimmed;
    }
  } catch (error) {
    console.warn("[RAG] System prompt file not found or unreadable, using fallback.", error);
  }
  cachedSystemPrompt = FALLBACK_SYSTEM_PROMPT;
  return FALLBACK_SYSTEM_PROMPT;
}

function requireEnv(key: string) {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

async function embedQuery(query: string) {
  const apiKey = requireEnv("OPENAI_API_KEY");
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_EMBEDDING_MODEL,
      input: query,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI embeddings error: ${res.status} ${errText}`);
  }

  const data = await res.json();
  return data.data[0].embedding as number[];
}

type PineconeMatch = {
  id: string;
  score?: number;
  metadata?: Record<string, any>;
};

type RetrievalMode = "dense" | "sparse" | "hybrid";
type ChatHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

async function queryPinecone(vector: number[], topK: number): Promise<PineconeMatch[]> {
  const apiKey = requireEnv("PINECONE_API_KEY");
  const host = requireEnv("PINECONE_HOST");
  const namespace = process.env.PINECONE_NAMESPACE || "default";

  const res = await fetch(`${host.replace(/\/$/, "")}/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Api-Key": apiKey,
    },
    body: JSON.stringify({
      vector,
      topK,
      includeMetadata: true,
      namespace,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Pinecone query error: ${res.status} ${errText}`);
  }

  const data = await res.json();
  return data.matches || [];
}

async function searchPineconeSparse(query: string, topK: number): Promise<PineconeMatch[]> {
  const apiKey = requireEnv("PINECONE_API_KEY");
  const indexName = requireEnv("PINECONE_INDEX_SPARSE");
  const host = process.env.PINECONE_HOST_SPARSE || process.env.PINECONE_HOST_PARSE;
  const namespace = process.env.PINECONE_NAMESPACE || "default";

  if (!host) {
    throw new Error("Missing PINECONE_HOST_SPARSE (or PINECONE_HOST_PARSE) env var");
  }

  const pinecone = new Pinecone({ apiKey });
  const index = pinecone.index(indexName, host).namespace(namespace);

  const results: any = await index.searchRecords({
    query: {
      inputs: { text: query },
      topK: topK,
    },
    fields: [
      "text",
      "doc_id",
      "doc_title",
      "page_start",
      "page_end",
      "para_start",
      "para_end",
      "section_path",
      "content_type",
      "element_ids",
      "source_url",
    ],
  });

  const hits = results?.result?.hits || results?.hits || [];
  return hits.map((hit: any) => ({
    id: hit._id || hit.id,
    score: hit._score ?? hit.score,
    metadata: hit.fields || hit.metadata || {},
  }));
}

function fuseResults(dense: PineconeMatch[], sparse: PineconeMatch[], topK: number) {
  const k = 60;
  const scores = new Map<string, number>();
  const meta = new Map<string, PineconeMatch>();

  const addList = (list: PineconeMatch[]) => {
    list.forEach((match, idx) => {
      const id = match.id;
      const rrf = 1 / (k + idx + 1);
      scores.set(id, (scores.get(id) || 0) + rrf);
      if (!meta.has(id)) {
        meta.set(id, match);
      } else {
        const existing = meta.get(id)!;
        meta.set(id, {
          id,
          score: existing.score ?? match.score,
          metadata: { ...match.metadata, ...existing.metadata },
        });
      }
    });
  };

  addList(dense);
  addList(sparse);

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([id]) => meta.get(id)!)
    .filter(Boolean);
}

function buildSources(matches: PineconeMatch[]) {
  return matches
    .map((match, index) => {
      const md = match.metadata || {};
      const section = md.section_path ? `Section: ${md.section_path}` : "";
      const page = md.page_start ?? md.page ?? "?";
      const paraStart = md.para_start ?? "?";
      const paraEnd = md.para_end ?? md.para_start ?? "?";
      const header = `Source ${index + 1}\nchunk_id: ${match.id}\nDoc: ${md.doc_id || "Unknown"}\nPage: ${page}\nParagraphs: ${paraStart}-${paraEnd}\n${section}`;
      const text = md.text || "";
      return `${header}\nText: ${text}`;
    })
    .join("\n\n---\n\n");
}

function buildResponseFormat() {
  return {
    type: "json_schema",
    json_schema: {
      name: "rag_answer",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          answer: { type: "string" },
          citations: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["answer", "citations"],
      },
    },
  } as const;
}

function isStructuredOutputError(message: string) {
  return /response_format|json_schema|schema|unsupported/i.test(message);
}

function createAnswerStreamExtractor() {
  let inString = false;
  let stringEscape = false;
  let currentString = "";
  let parsingKey = false;
  let lastString = "";
  let expectingAnswerValue = false;
  let inAnswerValue = false;
  let answerEscape = false;
  let unicodeBuffer: string | null = null;

  const isWhitespace = (char: string) =>
    char === " " || char === "\n" || char === "\t" || char === "\r";

  const push = (chunk: string) => {
    let emitted = "";

    for (let i = 0; i < chunk.length; i += 1) {
      const char = chunk[i];

      if (inAnswerValue) {
        if (unicodeBuffer !== null) {
          if (/^[0-9a-fA-F]$/.test(char)) {
            unicodeBuffer += char;
            if (unicodeBuffer.length === 4) {
              emitted += String.fromCharCode(parseInt(unicodeBuffer, 16));
              unicodeBuffer = null;
              answerEscape = false;
            }
            continue;
          }
          emitted += `\\u${unicodeBuffer}${char}`;
          unicodeBuffer = null;
          answerEscape = false;
          continue;
        }

        if (answerEscape) {
          if (char === "u") {
            unicodeBuffer = "";
            answerEscape = false;
            continue;
          }
          switch (char) {
            case "\"":
              emitted += "\"";
              break;
            case "\\":
              emitted += "\\";
              break;
            case "n":
              emitted += "\n";
              break;
            case "r":
              emitted += "\r";
              break;
            case "t":
              emitted += "\t";
              break;
            case "b":
              emitted += "\b";
              break;
            case "f":
              emitted += "\f";
              break;
            default:
              emitted += char;
          }
          answerEscape = false;
          continue;
        }

        if (char === "\\") {
          answerEscape = true;
          continue;
        }

        if (char === "\"") {
          inAnswerValue = false;
          continue;
        }

        emitted += char;
        continue;
      }

      if (inString) {
        if (stringEscape) {
          currentString += char;
          stringEscape = false;
          continue;
        }
        if (char === "\\") {
          stringEscape = true;
          continue;
        }
        if (char === "\"") {
          inString = false;
          lastString = currentString;
          parsingKey = true;
          currentString = "";
          continue;
        }
        currentString += char;
        continue;
      }

      if (parsingKey) {
        if (isWhitespace(char)) {
          continue;
        }
        if (char === ":") {
          if (lastString === "answer") {
            expectingAnswerValue = true;
          }
          parsingKey = false;
          continue;
        }
        parsingKey = false;
      }

      if (expectingAnswerValue) {
        if (isWhitespace(char)) {
          continue;
        }
        if (char === "\"") {
          inAnswerValue = true;
        }
        expectingAnswerValue = false;
        continue;
      }

      if (char === "\"") {
        inString = true;
        currentString = "";
      }
    }

    return emitted;
  };

  return { push };
}

async function callOpenRouter(
  question: string,
  matches: PineconeMatch[],
  useStructured: boolean,
  history: ChatHistoryMessage[]
) {
  const apiKey = requireEnv("OPENROUTER_API_KEY");
  const model = DEFAULT_MODEL;

  const system = await loadSystemPrompt();

  const sourcesStart = Date.now();
  const sources = buildSources(matches);
  const sourcesMs = Date.now() - sourcesStart;
  console.log("[RAG] Sources payload:", sources);
  console.log("[RAG] Sources build ms:", sourcesMs);

  const sourcesBlock = sources.trim().length > 0 ? sources : "None provided.";
  const payload = {
    model,
    temperature: DEFAULT_TEMPERATURE,
    ...(useStructured ? { response_format: buildResponseFormat() } : {}),
    messages: [
      { role: "system", content: system },
      ...history,
      {
        role: "user",
        content:
          `User message:\n${question}\n\n` +
          `Context sources (use only if relevant):\n${sourcesBlock}`,
      },
    ],
  };
  const body = JSON.stringify(payload);
  const controller = new AbortController();
  const startedAt = Date.now();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_OPENROUTER_TIMEOUT_MS);
  let res: Response;
  let responseText = "";

  console.log("[RAG] OpenRouter request:", {
    model,
    structured: useStructured,
    temperature: DEFAULT_TEMPERATURE,
    timeout_ms: DEFAULT_OPENROUTER_TIMEOUT_MS,
  });
  console.log("[RAG] OpenRouter payload messages:", JSON.stringify(payload.messages, null, 2));

  try {
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...(process.env.OPENROUTER_SITE_URL
          ? { "HTTP-Referer": process.env.OPENROUTER_SITE_URL }
          : {}),
        ...(process.env.OPENROUTER_APP_NAME
          ? { "X-Title": process.env.OPENROUTER_APP_NAME }
          : {}),
      },
      body,
      signal: controller.signal,
    });
  } catch (err: any) {
    const elapsed = Date.now() - startedAt;
    console.error("[RAG] OpenRouter fetch failed:", {
      message: err?.message || String(err),
      time_ms: elapsed,
    });
    throw err;
  }

  const elapsed = Date.now() - startedAt;
  console.log("[RAG] OpenRouter response:", { status: res.status, time_ms: elapsed });

  try {
    responseText = await res.text();
  } catch (err: any) {
    const readElapsed = Date.now() - startedAt;
    console.error("[RAG] OpenRouter response read failed:", {
      message: err?.message || String(err),
      time_ms: readElapsed,
    });
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    console.error("[RAG] OpenRouter error body:", responseText);
    throw new Error(`OpenRouter error: ${res.status} ${responseText}`);
  }

  let data: any;
  try {
    data = JSON.parse(responseText);
  } catch (err: any) {
    console.error("[RAG] OpenRouter response parse failed:", {
      message: err?.message || String(err),
      preview: responseText.slice(0, 500),
    });
    throw err;
  }
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter returned no content");
  return content as string;
}

async function callOpenRouterStream(
  question: string,
  matches: PineconeMatch[],
  useStructured: boolean,
  history: ChatHistoryMessage[],
  onAnswerChunk: (chunk: string) => void
) {
  const apiKey = requireEnv("OPENROUTER_API_KEY");
  const model = DEFAULT_MODEL;

  const system = await loadSystemPrompt();

  const sourcesStart = Date.now();
  const sources = buildSources(matches);
  const sourcesMs = Date.now() - sourcesStart;
  console.log("[RAG] Sources payload:", sources);
  console.log("[RAG] Sources build ms:", sourcesMs);

  const sourcesBlock = sources.trim().length > 0 ? sources : "None provided.";
  const payload = {
    model,
    temperature: DEFAULT_TEMPERATURE,
    stream: true,
    ...(useStructured ? { response_format: buildResponseFormat() } : {}),
    messages: [
      { role: "system", content: system },
      ...history,
      {
        role: "user",
        content:
          `User message:\n${question}\n\n` +
          `Context sources (use only if relevant):\n${sourcesBlock}`,
      },
    ],
  };
  const body = JSON.stringify(payload);
  const controller = new AbortController();
  const startedAt = Date.now();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_OPENROUTER_TIMEOUT_MS);
  let res: Response;

  console.log("[RAG] OpenRouter stream request:", {
    model,
    structured: useStructured,
    temperature: DEFAULT_TEMPERATURE,
    timeout_ms: DEFAULT_OPENROUTER_TIMEOUT_MS,
  });
  console.log("[RAG] OpenRouter stream payload messages:", JSON.stringify(payload.messages, null, 2));

  try {
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...(process.env.OPENROUTER_SITE_URL
          ? { "HTTP-Referer": process.env.OPENROUTER_SITE_URL }
          : {}),
        ...(process.env.OPENROUTER_APP_NAME
          ? { "X-Title": process.env.OPENROUTER_APP_NAME }
          : {}),
      },
      body,
      signal: controller.signal,
    });
  } catch (err: any) {
    const elapsed = Date.now() - startedAt;
    console.error("[RAG] OpenRouter stream fetch failed:", {
      message: err?.message || String(err),
      time_ms: elapsed,
    });
    throw err;
  }

  const elapsed = Date.now() - startedAt;
  console.log("[RAG] OpenRouter stream response:", { status: res.status, time_ms: elapsed });

  if (!res.ok) {
    const errText = await res.text();
    clearTimeout(timeout);
    console.error("[RAG] OpenRouter stream error body:", errText);
    throw new Error(`OpenRouter error: ${res.status} ${errText}`);
  }

  if (!res.body) {
    clearTimeout(timeout);
    throw new Error("OpenRouter returned no stream body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const extractor = createAnswerStreamExtractor();
  let buffer = "";
  let fullContent = "";
  let done = false;
  let firstTokenLogged = false;
  let firstTokenAt: number | null = null;
  let tokenEvents = 0;

  try {
    while (!done) {
      const { value, done: readerDone } = await reader.read();
      if (readerDone) break;
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const lineBreak = buffer.indexOf("\n");
        if (lineBreak === -1) break;
        const line = buffer.slice(0, lineBreak).trim();
        buffer = buffer.slice(lineBreak + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === "[DONE]") {
          done = true;
          break;
        }
        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        const delta = parsed?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          fullContent += delta;
          const emitted = extractor.push(delta);
          if (emitted) {
            onAnswerChunk(emitted);
          }
          tokenEvents += 1;
          if (!firstTokenLogged) {
            firstTokenLogged = true;
            firstTokenAt = Date.now();
            console.log("[RAG] OpenRouter time to first token ms:", firstTokenAt - startedAt);
          }
        }
      }
    }
  } finally {
    clearTimeout(timeout);
  }

  console.log("[RAG] OpenRouter stream done:", {
    token_events: tokenEvents,
    generation_ms: firstTokenAt ? Date.now() - firstTokenAt : null,
    total_time_ms: Date.now() - startedAt,
  });

  return fullContent;
}

function extractJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

const INLINE_CITE_START = "cite";
const INLINE_CITE_END = "";

function stripInlineCitations(text: string) {
  if (!text) return text;
  return text.replace(/cite[^]*/g, "").trim();
}

function createInlineCitationStripper() {
  let inCite = false;
  let carry = "";
  const startLen = INLINE_CITE_START.length;

  return (chunk: string) => {
    if (!chunk) return "";
    let text = carry + chunk;
    carry = "";
    let out = "";
    let i = 0;

    while (i < text.length) {
      if (inCite) {
        const endIdx = text.indexOf(INLINE_CITE_END, i);
        if (endIdx === -1) {
          return out;
        }
        inCite = false;
        i = endIdx + INLINE_CITE_END.length;
        continue;
      }

      const startIdx = text.indexOf(INLINE_CITE_START, i);
      if (startIdx === -1) {
        const remaining = text.length - i;
        if (remaining >= startLen - 1) {
          const safeEnd = text.length - (startLen - 1);
          out += text.slice(i, safeEnd);
          carry = text.slice(safeEnd);
        } else {
          carry = text.slice(i);
        }
        return out;
      }

      out += text.slice(i, startIdx);
      i = startIdx + startLen;
      inCite = true;
    }

    return out;
  };
}

export async function POST(request: NextRequest) {
  try {
    const retrievalStart = Date.now();
    const body = await request.json();
    const rawMessages = Array.isArray(body?.messages) ? body.messages : [];
    const retrievalMode: RetrievalMode = body?.retrievalMode || "hybrid";
    const wantsStream = body?.stream === true;
    const maxHistoryMessages = Number(process.env.RAG_HISTORY_MAX_MESSAGES || 12);
    const normalizedMessages: ChatHistoryMessage[] = rawMessages
      .filter((msg: any) => msg && (msg.role === "user" || msg.role === "assistant"))
      .map((msg: any) => {
        const base = typeof msg.content === "string" ? msg.content.trim() : "";
        if (msg.role !== "assistant" || !Array.isArray(msg.citations) || msg.citations.length === 0) {
          return { role: msg.role, content: base };
        }
        const citationLines = msg.citations.map((citation: any) => {
          const doc = citation?.doc_id || "Source";
          const page = citation?.page ?? "?";
          const paraStart = citation?.para_start ?? "?";
          const paraEnd = citation?.para_end ?? citation?.para_start ?? "?";
          const paraLabel = paraStart === paraEnd ? `${paraStart}` : `${paraStart}-${paraEnd}`;
          return `- ${doc} · p.${page} · para ${paraLabel}`;
        });
        const suffix = citationLines.length
          ? `\n\nPrior citations (context only, do not cite for new answers):\n${citationLines.join("\n")}`
          : "";
        return { role: msg.role, content: `${base}${suffix}`.trim() };
      })
      .filter((msg: ChatHistoryMessage) => msg.content.length > 0);

    const lastUserIndex = [...normalizedMessages]
      .map((msg: ChatHistoryMessage, idx: number) => (msg.role === "user" ? idx : -1))
      .filter((idx: number) => idx >= 0)
      .pop();

    if (lastUserIndex === undefined) {
      return Response.json({ error: "Missing user message" }, { status: 400 });
    }

    const question = normalizedMessages[lastUserIndex]?.content?.trim() || "";
    if (!question) {
      return Response.json({ error: "Empty user message" }, { status: 400 });
    }

    console.log(
      "[RAG] Request:",
      JSON.stringify(
        {
          query: question,
          retrievalMode,
          historyMessages: Math.max(0, normalizedMessages.length - 1),
          maxHistoryMessages: maxHistoryMessages,
          topK: DEFAULT_TOP_K,
          denseTopK: DEFAULT_DENSE_TOP_K,
          sparseTopK: DEFAULT_SPARSE_TOP_K,
          namespace: process.env.PINECONE_NAMESPACE || "default",
        },
        null,
        2
      )
    );

    const historySlice = normalizedMessages.slice(0, lastUserIndex);
    const history =
      maxHistoryMessages > 0
        ? historySlice.slice(-maxHistoryMessages)
        : [];

    let matches: PineconeMatch[] = [];

    let embedMs: number | null = null;
    let denseQueryMs: number | null = null;
    let sparseQueryMs: number | null = null;
    let fuseMs: number | null = null;

    if (retrievalMode === "dense" || retrievalMode === "hybrid") {
      const embedStart = Date.now();
      const vector = await embedQuery(question);
      embedMs = Date.now() - embedStart;
      const denseStart = Date.now();
      const denseMatches = await queryPinecone(vector, DEFAULT_DENSE_TOP_K);
      denseQueryMs = Date.now() - denseStart;
      matches = denseMatches;
      console.log(
        "[RAG] Dense matches:",
        JSON.stringify(
          {
            count: denseMatches.length,
            ids: denseMatches.map((match) => match.id),
          },
          null,
          2
        )
      );
    }

    if (retrievalMode === "sparse" || retrievalMode === "hybrid") {
      const sparseStart = Date.now();
      const sparseMatches = await searchPineconeSparse(question, DEFAULT_SPARSE_TOP_K);
      sparseQueryMs = Date.now() - sparseStart;
      if (retrievalMode === "sparse") {
        matches = sparseMatches;
      } else {
        const fuseStart = Date.now();
        matches = fuseResults(matches, sparseMatches, DEFAULT_TOP_K);
        fuseMs = Date.now() - fuseStart;
      }
      console.log(
        "[RAG] Sparse matches:",
        JSON.stringify(
          {
            count: sparseMatches.length,
            ids: sparseMatches.map((match) => match.id),
          },
          null,
          2
        )
      );
      console.log(
        "[RAG] Fused matches:",
        JSON.stringify(
          {
            count: matches.length,
            ids: matches.map((match) => match.id),
          },
          null,
          2
        )
      );
    }

    const retrievalTiming = {
      total: Date.now() - retrievalStart,
      embed: embedMs,
      dense_query: denseQueryMs,
      sparse_query: sparseQueryMs,
      fuse: fuseMs,
    };

    if (!matches.length && !wantsStream) {
      console.log("[RAG] Retrieval timing ms:", retrievalTiming);
    }

    const structuredPreferred = process.env.OPENROUTER_STRUCTURED_OUTPUT !== "false";
    let raw: string;
    let usedStructured = structuredPreferred;

    if (wantsStream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (payload: any) => {
            controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
          };
          const stripStreamCites = createInlineCitationStripper();
          const sendToken = (chunk: string) => {
            if (!chunk) return;
            const cleaned = stripStreamCites(chunk);
            if (cleaned) send({ type: "token", data: cleaned });
          };

          try {
            console.log("[RAG] Retrieval timing ms:", retrievalTiming);
            try {
              raw = await callOpenRouterStream(
                question,
                matches,
                structuredPreferred,
                history,
                sendToken
              );
            } catch (err: any) {
              const message = String(err?.message || "");
              const looksLikeFormatError = structuredPreferred && isStructuredOutputError(message);
              if (!looksLikeFormatError) throw err;
              usedStructured = false;
              raw = await callOpenRouterStream(question, matches, false, history, sendToken);
            }

            console.log("[RAG] OpenRouter structured output:", usedStructured);
            console.log("[RAG] OpenRouter raw response length:", raw.length);

            const parsed = extractJson(raw);
            const answer =
              typeof parsed?.answer === "string" ? stripInlineCitations(parsed.answer) : "";
            const citationIds = Array.isArray(parsed?.citations)
              ? parsed.citations
                  .map((item: any) => (typeof item === "string" ? item : item?.chunk_id))
                  .filter((value: any) => typeof value === "string")
              : [];

            const matchMap = new Map(matches.map((match) => [match.id, match]));
            const citations = [...new Set(citationIds)]
              .filter((id): id is string => matchMap.has(id as string))
              .map((id) => {
                const match = matchMap.get(id as string)!;
                const md = match.metadata || {};
                return {
                  chunk_id: id,
                  doc_id: md.doc_id,
                  page: md.page_start ?? md.page ?? null,
                  para_start: md.para_start ?? null,
                  para_end: md.para_end ?? null,
                  section_path: md.section_path ?? null,
                  source_url: md.source_url ?? null,
                };
              });

            const finalAnswer =
              answer || "I could not extract a supported answer from the sources.";

            send({ type: "done", data: { answer: finalAnswer, citations } });
          } catch (err: any) {
            console.error("Chat API error (stream)", err);
            send({
              type: "error",
              data: err?.message || "Unexpected error",
            });
          } finally {
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    console.log("[RAG] Retrieval timing ms:", retrievalTiming);
    try {
      raw = await callOpenRouter(question, matches, structuredPreferred, history);
    } catch (err: any) {
      const message = String(err?.message || "");
      const looksLikeFormatError = structuredPreferred && isStructuredOutputError(message);
      if (!looksLikeFormatError) throw err;
      usedStructured = false;
      raw = await callOpenRouter(question, matches, false, history);
    }

    console.log("[RAG] OpenRouter structured output:", usedStructured);
    console.log("[RAG] OpenRouter raw response:", raw);
    const parsed = extractJson(raw);

    const answer =
      typeof parsed?.answer === "string" ? stripInlineCitations(parsed.answer) : "";
    const citationIds = Array.isArray(parsed?.citations)
      ? parsed.citations
          .map((item: any) => (typeof item === "string" ? item : item?.chunk_id))
          .filter((value: any) => typeof value === "string")
      : [];

    const matchMap = new Map(matches.map((match) => [match.id, match]));
    const citations = [...new Set(citationIds)]
      .filter((id): id is string => matchMap.has(id as string))
      .map((id) => {
        const match = matchMap.get(id as string)!;
        const md = match.metadata || {};
        return {
          chunk_id: id,
          doc_id: md.doc_id,
          page: md.page_start ?? md.page ?? null,
          para_start: md.para_start ?? null,
          para_end: md.para_end ?? null,
          section_path: md.section_path ?? null,
          source_url: md.source_url ?? null,
        };
      });

    const finalAnswer = answer || "I could not extract a supported answer from the sources.";

    return Response.json({ answer: finalAnswer, citations });
  } catch (error: any) {
    console.error("Chat API error", error);
    return Response.json(
      { error: error.message || "Unexpected error" },
      { status: 500 }
    );
  }
}
