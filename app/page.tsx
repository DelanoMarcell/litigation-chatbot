"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [unseenCount, setUnseenCount] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const isAtBottomRef = useRef(true);
  const forceScrollRef = useRef(false);
  const lastMessageCountRef = useRef(0);

  const canSend = input.trim().length > 0 && !isLoading;

  const handleSend = async () => {
    if (!canSend) return;
    const trimmed = input.trim();
    const nextMessages: ChatMessage[] = [
      ...messages,
      { role: "user", content: trimmed },
    ];
    const assistantIndex = nextMessages.length;
    const nextWithAssistant: ChatMessage[] = [
      ...nextMessages,
      { role: "assistant", content: "", citations: [] },
    ];
    setMessages(nextWithAssistant);
    forceScrollRef.current = true;
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

      setMessages((prev) => {
        const updated = [...prev];
        const target = updated[assistantIndex];
        if (target && target.role === "assistant") {
          updated[assistantIndex] = {
            ...target,
            content: data.answer || "No response.",
            citations: (data.citations ?? []) as Citation[],
          };
          return updated;
        }
        return [
          ...nextMessages,
          {
            role: "assistant",
            content: data.answer || "No response.",
            citations: (data.citations ?? []) as Citation[],
          } satisfies ChatMessage,
        ];
      });
    } catch (err: any) {
      setError(err.message || "Something went wrong");
    } finally {
      setIsLoading(false);
    }
  };

  const onSampleClick = (query: string) => {
    setInput(query);
  };

  const handleNewChat = () => {
    setMessages([]);
    setInput("");
    setError(null);
    setIsLoading(false);
    setUnseenCount(0);
    isAtBottomRef.current = true;
    forceScrollRef.current = false;
  };

  const helperText = useMemo(() => {
    if (error) return error;
    return "";
  }, [error]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const threshold = 80;
    const update = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
      isAtBottomRef.current = atBottom;
      setIsAtBottom(atBottom);
      if (atBottom) setUnseenCount(0);
    };

    update();
    el.addEventListener("scroll", update, { passive: true });
    return () => {
      el.removeEventListener("scroll", update);
    };
  }, []);

  useEffect(() => {
    const isNewMessage = messages.length > lastMessageCountRef.current;
    lastMessageCountRef.current = messages.length;

    if (isAtBottomRef.current || forceScrollRef.current) {
      forceScrollRef.current = false;
      requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView({
          behavior: isLoading ? "auto" : "smooth",
          block: "end",
        });
      });
      return;
    }

    if (isNewMessage) {
      setUnseenCount((prev) => prev + 1);
    }
  }, [messages, isLoading]);

  return (
    <div className="h-screen overflow-hidden bg-background text-foreground">
      <main className="mx-auto flex h-full max-w-5xl flex-col px-5 py-5">


        <section className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="flex flex-wrap gap-2 text-[11px]">
            {SAMPLE_QUERIES.map((query) => (
              <button
                key={query}
                type="button"
                onClick={() => onSampleClick(query)}
                className="rounded-full border border-(--stroke) bg-white/80 px-3 py-1.5 text-foreground transition hover:-translate-y-0.5 hover:shadow-sm"
              >
                {query}
              </button>
            ))}
          </div>

          <div className="relative flex min-h-0 flex-1 flex-col rounded-(24px) border border-(--stroke) bg-(--panel) p-5 shadow-(0_40px_120px_-80px_rgba(0,0,0,0.45))">
            <div className="flex items-center justify-between text-[11px] uppercase tracking-(0.2em) text-(--muted)">
              <span>Chat</span>
            </div>

            <div
              ref={scrollRef}
              className="mt-3 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-2"
            >
              {messages.length === 0 ? null : (
                messages.map((message, idx) => {
                  const isLast = idx === messages.length - 1;
                  const showLoading = message.role === "assistant" && isLast && isLoading;
                  const hasContent = message.content.trim().length > 0;

                  if (!hasContent && !showLoading) return null;

                  return (
                    <div key={`${message.role}-${idx}`} className="space-y-2">
                      <div
                        className={`flex w-full ${message.role === "user" ? "justify-end" : "justify-start"}`}
                      >
                        <div
                          className={`max-w-(80%) rounded-2xl px-3.5 py-2.5 ${
                            message.role === "user"
                              ? "bg-(--accent)/10 text-foreground"
                              : "bg-white text-foreground"
                          }`}
                        >
                          {message.role === "assistant" ? (
                            showLoading && !hasContent ? (
                              <span className="inline-flex items-center gap-2 text-[13px] text-(--muted)">
                                <span>Thinking</span>
                                <span className="typing-indicator" aria-hidden="true">
                                  <span className="typing-dot" />
                                  <span className="typing-dot" />
                                  <span className="typing-dot" />
                                </span>
                              </span>
                            ) : (
                              <Streamdown
                                mode="streaming"
                                isAnimating={isLoading && isLast}
                                caret={isLoading && isLast ? "block" : undefined}
                                className="text-[13px] leading-relaxed md:text-[14px]"
                              >
                                {message.content}
                              </Streamdown>
                            )
                          ) : (
                            <span className="text-[13px] leading-relaxed md:text-[14px]">
                              {message.content}
                            </span>
                          )}
                        </div>
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
                  );
                })
              )}
              <div ref={bottomRef} />
            </div>

            {!isAtBottom ? (
              <button
                type="button"
                onClick={() => {
                  forceScrollRef.current = true;
                  setUnseenCount(0);
                  requestAnimationFrame(() => {
                    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
                  });
                }}
                className="absolute bottom-24 left-1/2 -translate-x-1/2 rounded-full border border-(--stroke) bg-white px-4 py-2 text-[11px] font-semibold text-(--muted) shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
              >
                {unseenCount > 0 ? `${unseenCount} new message` : "Scroll to latest"}
              </button>
            ) : null}

            <div className="mt-6">
              <div className="flex flex-col gap-3 rounded-2xl border border-(--stroke) bg-white/70 p-4">
                <textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder="Ask a question about the rules..."
                  rows={3}
                  className="w-full resize-none bg-transparent text-[13px] text-foreground outline-none placeholder:text-(--muted)"
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      handleSend();
                    }
                  }}
                />
                <div className="flex items-center justify-between text-[11px] text-(--muted)">
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
                      onClick={handleNewChat}
                      className="rounded-full border border-(--stroke) bg-white px-4 py-2 text-[11px] font-semibold uppercase tracking-(0.2em) text-(--muted) transition hover:-translate-y-0.5 hover:shadow-sm"
                    >
                      New chat
                    </button>
                    <button
                      type="button"
                      onClick={handleSend}
                      disabled={!canSend}
                      className="rounded-full bg-(--accent) px-5 py-2 text-[11px] font-semibold uppercase tracking-(0.2em) text-white transition disabled:opacity-50"
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
