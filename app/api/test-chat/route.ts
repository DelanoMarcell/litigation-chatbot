import { NextRequest } from "next/server";

export const runtime = "nodejs";

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

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

function requireEnv(key: string) {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const history: ChatMessage[] = messages
      .filter(
        (msg: any) =>
          msg &&
          (msg.role === "user" || msg.role === "assistant") &&
          typeof msg.content === "string"
      )
      .map((msg: any) => ({ role: msg.role, content: msg.content }));

    if (history.length === 0) {
      return Response.json({ error: "No messages provided" }, { status: 400 });
    }

    const apiKey = requireEnv("OPENROUTER_API_KEY");
    const payload = {
      model: DEFAULT_MODEL,
      temperature: DEFAULT_TEMPERATURE,
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        ...history,
      ],
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_OPENROUTER_TIMEOUT_MS);

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
      body: JSON.stringify(payload),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    const responseText = await res.text();

    if (!res.ok) {
      throw new Error(`OpenRouter error: ${res.status} ${responseText}`);
    }

    let data: any;
    try {
      data = JSON.parse(responseText);
    } catch (err: any) {
      throw new Error("Failed to parse OpenRouter response");
    }

    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("OpenRouter returned no content");
    }

    return Response.json({ answer: content });
  } catch (error: any) {
    return Response.json(
      { error: error?.message || "Unexpected error" },
      { status: 500 }
    );
  }
}
