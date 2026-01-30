"use client";

import { useMemo, useState } from "react";
import { Streamdown } from "streamdown";

type Citation = {
  chunk_id: string;
  doc_id: string | null;
  page: number | null;
  para_start: number | null;
  para_end: number | null;
  section_path: string | null;
  source_url: string | null;
};

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
};

const SAMPLE_QUERIES = [
  "What is the definition of a court day?",
  "How long does a writ of execution remain in force?",
  "Where do the rules define an 'action'?"];

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retrievalMode, setRetrievalMode] = useState<"hybrid" | "dense" | "sparse">("hybrid");

  const canSend = input.trim().length > 0 && !isLoading;

  const handleSend = async () => {
    if (!canSend) return;
    const trimmed = input.trim();
    const nextMessages: ChatMessage[] = [
      ...messages,
      { role: "user", content: trimmed },
    ];
    setMessages(nextMessages);
    setInput("");
    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages, retrievalMode, stream: true }),
      });
      const contentType = res.headers.get("content-type") || "";

      if (contentType.includes("application/x-ndjson") && res.body) {
        const assistantIndex = nextMessages.length;
        setMessages([
          ...nextMessages,
          { role: "assistant", content: "", citations: [] },
        ]);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let streamDone = false;

        while (!streamDone) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          while (true) {
            const lineBreak = buffer.indexOf("\n");
            if (lineBreak === -1) break;
            const line = buffer.slice(0, lineBreak).trim();
            buffer = buffer.slice(lineBreak + 1);
            if (!line) continue;

            let event: any;
            try {
              event = JSON.parse(line);
            } catch {
              continue;
            }

            if (event.type === "token") {
              const token = typeof event.data === "string" ? event.data : "";
              if (token) {
                setMessages((prev) => {
                  const updated = [...prev];
                  const target = updated[assistantIndex];
                  if (target && target.role === "assistant") {
                    updated[assistantIndex] = {
                      ...target,
                      content: `${target.content}${token}`,
                    };
                  }
                  return updated;
                });
              }
              continue;
            }

            if (event.type === "done") {
              const answer = typeof event.data?.answer === "string" ? event.data.answer : "";
              const citations = Array.isArray(event.data?.citations) ? event.data.citations : [];
              setMessages((prev) => {
                const updated = [...prev];
                const target = updated[assistantIndex];
                if (target && target.role === "assistant") {
                  updated[assistantIndex] = {
                    ...target,
                    content: answer || target.content,
                    citations,
                  };
                }
                return updated;
              });
              streamDone = true;
              continue;
            }

            if (event.type === "error") {
              const message =
                typeof event.data === "string" ? event.data : "Something went wrong";
              setError(message);
              streamDone = true;
            }
          }
        }
        return;
      }

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.error || "Failed to fetch response");
      }

      setMessages([
        ...nextMessages,
        {
          role: "assistant",
          content: data.answer || "No response.",
          citations: (data.citations ?? []) as Citation[],
        } satisfies ChatMessage,
      ]);
    } catch (err: any) {
      setError(err.message || "Something went wrong");
    } finally {
      setIsLoading(false);
    }
  };

  const onSampleClick = (query: string) => {
    setInput(query);
  };

  const helperText = useMemo(() => {
    if (isLoading) return "Retrieving sources and drafting...";
    if (error) return error;
    return "";
  }, [isLoading, error]);

  return (
    <div className="relative min-h-screen overflow-hidden bg-(radial-gradient(circle_at_top,_#fff9f2,_#f3e6d6,_#eadbcc)) text-foreground">
      <div className="pointer-events-none absolute -top-24 right-10 h-64 w-64 rounded-full bg-(--accent)/10 blur-3xl animate-(slow-float_18s_ease-in-out_infinite)" />
      <div className="pointer-events-none absolute -bottom-32 left-10 h-72 w-72 rounded-full bg-(--accent-2)/15 blur-3xl animate-(slow-float_22s_ease-in-out_infinite)" />

      <main className="relative z-10 mx-auto flex min-h-screen max-w-5xl flex-col px-6 py-10">
        <header className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
          <div className="space-y-4 animate-(fade-up_0.6s_ease_0.05s_both)">
           
            {/*
            <h1 className="text-3xl font-(--font-display) leading-tight text-foreground md:text-5xl">
              Grounded answers for court rules, with exact citations.
            </h1>
            <p className="max-w-2xl text-base text-(--muted) md:text-lg">
              Ask questions about the rules and get responses anchored to the exact file, page, and paragraph.
            </p>
            */}
          </div>
          <div className="flex items-center gap-3 text-xs uppercase tracking-(0.2em) text-(--muted)" />
        </header>

        <section className="mt-8 flex flex-col gap-4">
          <div className="flex flex-wrap gap-3 text-xs">
            {SAMPLE_QUERIES.map((query) => (
              <button
                key={query}
                type="button"
                onClick={() => onSampleClick(query)}
                className="rounded-full border border-(--stroke) bg-white/80 px-4 py-2 text-foreground transition hover:-translate-y-0.5 hover:shadow-sm"
              >
                {query}
              </button>
            ))}
          </div>

          <div className="flex flex-1 flex-col rounded-(28px) border border-(--stroke) bg-(--panel) p-6 shadow-(0_40px_120px_-80px_rgba(0,0,0,0.45))">
            <div className="flex items-center justify-between text-xs uppercase tracking-(0.2em) text-(--muted)">
              <span>Chat</span>
            </div>

            <div className="mt-4 flex-1 space-y-6 overflow-y-auto pr-2">
              {messages.length === 0 ? null : (
                messages.map((message, idx) => (
                  <div key={`${message.role}-${idx}`} className="space-y-3">
                    <div
                      className={`max-w-(90%) rounded-2xl px-4 py-3 ${
                        message.role === "user"
                          ? "ml-auto bg-(--accent)/10 text-foreground"
                          : "mr-auto bg-white text-foreground"
                      }`}
                    >
                      {message.role === "assistant" ? (
                        <Streamdown
                          mode="streaming"
                          isAnimating={isLoading && idx === messages.length - 1}
                          caret={
                            message.role === "assistant" &&
                            isLoading &&
                            idx === messages.length - 1
                              ? "block"
                              : undefined
                          }
                          className="text-sm leading-relaxed md:text-base"
                        >
                          {message.content}
                        </Streamdown>
                      ) : (
                        <span className="text-sm leading-relaxed md:text-base">
                          {message.content}
                        </span>
                      )}
                    </div>

                    {message.role === "assistant" && message.citations?.length ? (
                      <div className="flex flex-wrap gap-2">
                        {message.citations.map((citation) => {
                          const page = citation.page ?? "?";
                          const paraStart = citation.para_start ?? "?";
                          const paraEnd = citation.para_end ?? citation.para_start ?? "?";
                          const label = `${citation.doc_id || "Source"} · p.${page} · para ${paraStart}${
                            paraStart !== paraEnd ? `-${paraEnd}` : ""
                          }`;
                          const href =
                            citation.source_url ??
                            (citation.doc_id
                              ? `/pdfs/${encodeURIComponent(citation.doc_id)}`
                              : null);

                          if (!href) {
                            return (
                              <span
                                key={citation.chunk_id}
                                className="inline-flex items-center gap-2 rounded-full border border-(--stroke) bg-white px-3 py-1 text-xs text-foreground"
                              >
                                <span className="h-2 w-2 rounded-full bg-(--accent)" />
                                {label}
                              </span>
                            );
                          }

                          return (
                            <a
                              key={citation.chunk_id}
                              href={href}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-2 rounded-full border border-(--stroke) bg-white px-3 py-1 text-xs text-foreground transition hover:-translate-y-0.5 hover:shadow-sm"
                            >
                              <span className="h-2 w-2 rounded-full bg-(--accent)" />
                              {label}
                            </a>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </div>

            <div className="mt-6">
              <div className="flex flex-col gap-3 rounded-2xl border border-(--stroke) bg-white/70 p-4">
                <textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder="Ask a question about the rules..."
                  rows={3}
                  className="w-full resize-none bg-transparent text-sm text-foreground outline-none placeholder:text-(--muted)"
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      handleSend();
                    }
                  }}
                />
                <div className="flex items-center justify-between text-xs text-(--muted)">
                  <span>{helperText}</span>
                  <div className="flex items-center gap-3">
                    {/*
                    <select
                      value={retrievalMode}
                      onChange={(event) =>
                        setRetrievalMode(event.target.value as "hybrid" | "dense" | "sparse")
                      }
                      className="rounded-full border border-(--stroke) bg-white px-3 py-2 text-(10px) font-semibold uppercase tracking-(0.2em) text-(--muted)"
                    >
                      <option value="hybrid">Hybrid</option>
                      <option value="dense">Semantic</option>
                      <option value="sparse">Keyword</option>
                    </select>
                    */}
                    <button
                      type="button"
                      onClick={handleSend}
                      disabled={!canSend}
                      className="rounded-full bg-(--accent) px-5 py-2 text-xs font-semibold uppercase tracking-(0.2em) text-white transition disabled:opacity-50"
                    >
                      {isLoading ? "Working" : "Send"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
