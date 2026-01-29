import { NextRequest } from "next/server";
import { Pinecone } from "@pinecone-database/pinecone";

export const runtime = "nodejs";

const OPENAI_EMBEDDING_MODEL = "text-embedding-3-large";
const DEFAULT_TOP_K = Number(process.env.RAG_TOP_K || 8);
const DEFAULT_DENSE_TOP_K = Number(process.env.RAG_DENSE_TOP_K || DEFAULT_TOP_K);
const DEFAULT_SPARSE_TOP_K = Number(process.env.RAG_SPARSE_TOP_K || DEFAULT_TOP_K);
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";

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

async function callOpenRouter(
  question: string,
  matches: PineconeMatch[],
  useStructured: boolean,
  history: ChatHistoryMessage[]
) {
  const apiKey = requireEnv("OPENROUTER_API_KEY");
  const model = DEFAULT_MODEL;

  const system =
    "You are a legal assistant. Answer only using the provided sources. " +
    "Use the conversation history for context, but only cite the current Sources block. " +
    "If the sources do not contain the answer, say you could not find it. " +
    "Return a JSON object with: answer (string), citations (array of chunk_id strings). " +
    "Do not include any extra keys or markdown.";

  const sources = buildSources(matches);
  console.log("[RAG] Sources payload:", sources);

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
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
    body: JSON.stringify({
      model,
      temperature: 0.2,
      ...(useStructured ? { response_format: buildResponseFormat() } : {}),
      messages: [
        { role: "system", content: system },
        ...history,
        {
          role: "user",
          content: `Question:\n${question}\n\nSources:\n${sources}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenRouter error: ${res.status} ${errText}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter returned no content");
  return content as string;
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

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const rawMessages = Array.isArray(body?.messages) ? body.messages : [];
    const retrievalMode: RetrievalMode = body?.retrievalMode || "hybrid";
    const maxHistoryMessages = Number(process.env.RAG_HISTORY_MAX_MESSAGES || 12);
    const normalizedMessages: ChatHistoryMessage[] = rawMessages
      .filter((msg: any) => msg && (msg.role === "user" || msg.role === "assistant"))
      .map((msg: any) => ({
        role: msg.role,
        content: typeof msg.content === "string" ? msg.content.trim() : "",
      }))
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

    if (retrievalMode === "dense" || retrievalMode === "hybrid") {
      const vector = await embedQuery(question);
      const denseMatches = await queryPinecone(vector, DEFAULT_DENSE_TOP_K);
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
      const sparseMatches = await searchPineconeSparse(question, DEFAULT_SPARSE_TOP_K);
      if (retrievalMode === "sparse") {
        matches = sparseMatches;
      } else {
        matches = fuseResults(matches, sparseMatches, DEFAULT_TOP_K);
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

    if (!matches.length) {
      return Response.json({
        answer: "I could not find anything relevant in the provided sources.",
        citations: [],
      });
    }

    const structuredPreferred = process.env.OPENROUTER_STRUCTURED_OUTPUT !== "false";
    let raw: string;
    let usedStructured = structuredPreferred;

    try {
      raw = await callOpenRouter(question, matches, structuredPreferred, history);
    } catch (err: any) {
      const message = String(err?.message || "");
      const looksLikeFormatError =
        structuredPreferred &&
        /response_format|json_schema|schema|unsupported/i.test(message);
      if (!looksLikeFormatError) throw err;
      usedStructured = false;
      raw = await callOpenRouter(question, matches, false, history);
    }

    console.log("[RAG] OpenRouter structured output:", usedStructured);
    console.log("[RAG] OpenRouter raw response:", raw);
    const parsed = extractJson(raw);

    const answer = typeof parsed?.answer === "string" ? parsed.answer.trim() : "";
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
