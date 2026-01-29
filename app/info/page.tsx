export default function InfoPage() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-[radial-gradient(circle_at_top,_#fff9f2,_#f3e6d6,_#eadbcc)] text-[var(--ink)]">
      <div className="pointer-events-none absolute -top-24 right-10 h-64 w-64 rounded-full bg-[color:var(--accent)]/10 blur-3xl animate-[slow-float_18s_ease-in-out_infinite]" />
      <div className="pointer-events-none absolute -bottom-32 left-10 h-72 w-72 rounded-full bg-[color:var(--accent-2)]/15 blur-3xl animate-[slow-float_22s_ease-in-out_infinite]" />

      <main className="relative z-10 mx-auto flex min-h-screen max-w-4xl flex-col gap-8 px-6 py-12">
        <header className="space-y-4">
          <span className="inline-flex w-fit items-center gap-2 rounded-full border border-[color:var(--stroke)] bg-white/70 px-4 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--muted)]">
            Project Info
          </span>
          <h1 className="text-4xl font-[var(--font-display)] leading-tight text-[color:var(--ink)]">
            How the litigation RAG system works
          </h1>
          <p className="text-base text-[color:var(--muted)]">
            This project uses dense and sparse retrieval over court rule PDFs. Every response is grounded with
            file, page, and paragraph provenance.
          </p>
        </header>

        <section className="grid gap-6">
          <div className="rounded-3xl border border-[color:var(--stroke)] bg-white/75 p-6 shadow-[0_40px_120px_-80px_rgba(0,0,0,0.35)]">
            <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--muted)]">
              Retrieval settings
            </h2>
            <ul className="mt-4 space-y-2 text-sm text-[color:var(--ink)]">
              <li>Embedding model: text-embedding-3-large</li>
              <li>Dense index: Pinecone (cosine)</li>
              <li>Sparse index: Pinecone sparse (keyword)</li>
              <li>Hybrid fusion: Reciprocal Rank Fusion (RRF)</li>
              <li>Chat model: OpenRouter (JSON citations enforced)</li>
            </ul>
          </div>

          <div className="rounded-3xl border border-[color:var(--stroke)] bg-white/75 p-6 shadow-[0_40px_120px_-80px_rgba(0,0,0,0.35)]">
            <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--muted)]">
              Citations
            </h2>
            <p className="text-sm text-[color:var(--muted)]">
              Each answer includes citation pills that link to the exact PDF page, plus the paragraph range
              derived from Unstructured element indices. This guarantees exact traceability for every claim.
            </p>
          </div>
        </section>

        <div>
          <a
            href="/"
            className="inline-flex items-center gap-2 rounded-full border border-[color:var(--stroke)] bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--muted)] transition hover:-translate-y-0.5 hover:shadow-sm"
          >
            Back to chat
          </a>
        </div>
      </main>
    </div>
  );
}
