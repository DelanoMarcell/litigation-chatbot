"use client";

import { useState } from "react";
import { Streamdown } from "streamdown";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export default function TestChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      const res = await fetch("/api/test-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || "Failed to fetch response");
      }

      setMessages([
        ...nextMessages,
        { role: "assistant", content: data.answer || "No response." },
      ]);
    } catch (err: any) {
      setError(err.message || "Something went wrong");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-(radial-gradient(circle_at_top,_#fff9f2,_#f3e6d6,_#eadbcc)) text-foreground">
      <main className="relative z-10 mx-auto flex min-h-screen max-w-4xl flex-col px-6 py-10">
        <header className="mb-6 space-y-2">
          <h1 className="text-2xl font-(--font-display) text-foreground md:text-3xl">
            Test Chat
          </h1>
          <p className="text-sm text-(--muted)">
            Plain chat with the model (no sources, no citations).
          </p>
        </header>

        <div className="flex flex-1 flex-col rounded-(28px) border border-(--stroke) bg-(--panel) p-6 shadow-(0_40px_120px_-80px_rgba(0,0,0,0.45))">
          <div className="flex-1 space-y-6 overflow-y-auto pr-2">
            {messages.length === 0 ? (
              <p className="text-sm text-(--muted)">Say hi to get started.</p>
            ) : (
              messages.map((message, idx) => (
                <div key={`${message.role}-${idx}`} className="space-y-2">
                  <div
                    className={`max-w-(90%) rounded-2xl px-4 py-3 ${
                      message.role === "user"
                        ? "ml-auto bg-(--accent)/10 text-foreground"
                        : "mr-auto bg-white text-foreground"
                    }`}
                  >
                    {message.role === "assistant" ? (
                      <Streamdown className="text-sm leading-relaxed md:text-base">
                        {message.content}
                      </Streamdown>
                    ) : (
                      <span className="text-sm leading-relaxed md:text-base">
                        {message.content}
                      </span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="mt-6">
            <div className="flex flex-col gap-3 rounded-2xl border border-(--stroke) bg-white/70 p-4">
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="Say hi..."
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
                <span>{error || (isLoading ? "Working..." : "")}</span>
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
      </main>
    </div>
  );
}
