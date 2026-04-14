"use client";

import { useEffect, useState, useMemo } from "react";
import { supabase, type Job } from "@/lib/db";

/* ─── Helpers ─────────────────────────────────────────── */
function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/* ─── Icons ────────────────────────────────────────────── */
function SearchIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ color: "var(--text-3)" }}
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

/* ─── Skeleton ─────────────────────────────────────────── */
function SkeletonGrid() {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="skeleton" />
      ))}
    </div>
  );
}

/* ─── Empty state ──────────────────────────────────────── */
function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center gap-3">
      <div
        className="w-10 h-10 flex items-center justify-center"
        style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          style={{ color: "var(--text-3)" }}
        >
          <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
          <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
        </svg>
      </div>
      <p className="text-sm font-medium" style={{ color: "var(--text-2)" }}>
        {filtered ? "No matching jobs found" : "No jobs discovered yet"}
      </p>
      <p className="text-xs max-w-xs leading-relaxed" style={{ color: "var(--text-3)" }}>
        {filtered
          ? "Try adjusting your search or clearing the filters."
          : "The agent is scanning company profiles. Jobs will appear here automatically."}
      </p>
    </div>
  );
}

/* ─── Job Card ─────────────────────────────────────────── */
function JobCard({ job, index }: { job: Job; index: number }) {
  return (
    <div
      className="job-card animate-in"
      style={{ animationDelay: `${index * 40}ms` }}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        {job.company_name && (
          <span className="co-badge">{job.company_name}</span>
        )}
        <span
          className="text-xs shrink-0 font-mono"
          style={{ color: "var(--text-3)" }}
        >
          {timeAgo(job.scraped_at)}
        </span>
      </div>

      {/* Title */}
      <h3
        className="text-sm font-semibold leading-snug tracking-tight"
        style={{ color: "var(--text-1)" }}
      >
        {job.title}
      </h3>

      {/* Description */}
      {job.description && (
        <p
          className="text-xs leading-relaxed line-clamp-2"
          style={{ color: "var(--text-2)" }}
        >
          {job.description}
        </p>
      )}

      {/* Footer */}
      {job.link && (
        <div className="flex items-center justify-end">
          <a
            href={job.link}
            target="_blank"
            rel="noopener noreferrer"
            className="apply-btn"
          >
            Apply <ExternalIcon />
          </a>
        </div>
      )}
    </div>
  );
}

/* ─── Page ─────────────────────────────────────────────── */
export default function Home() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);

  /* Fetch + realtime */
  useEffect(() => {
    async function fetchJobs() {
      const { data, error } = await supabase
        .from("jobs")
        .select("*")
        .order("scraped_at", { ascending: false });
      if (!error && data) setJobs(data);
      setLoading(false);
    }
    fetchJobs();

    const channel = supabase
      .channel("jobs-realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "jobs" },
        (payload) => setJobs((prev) => [payload.new as Job, ...prev])
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  /* Derived */
  const companies = useMemo(() => {
    const set = new Set(jobs.map((j) => j.company_name).filter(Boolean));
    return Array.from(set).sort() as string[];
  }, [jobs]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return jobs.filter((job) => {
      const matchSearch =
        !q ||
        job.title.toLowerCase().includes(q) ||
        (job.description?.toLowerCase().includes(q) ?? false) ||
        (job.company_name?.toLowerCase().includes(q) ?? false);
      const matchCompany = !selectedCompany || job.company_name === selectedCompany;
      return matchSearch && matchCompany;
    });
  }, [jobs, search, selectedCompany]);

  const isFiltered = !!(search || selectedCompany);

  /* ── Render ── */
  return (
    <div className="min-h-screen" style={{ background: "var(--bg)" }}>

      {/* ── Header ── */}
      <header className="max-w-4xl mx-auto px-6 pt-14 pb-0 flex flex-col items-center text-center">

        {/* Live badge */}
        <div className="flex items-center gap-2 mb-5">
          <span className="live-dot" />
          <span
            className="text-xs font-mono tracking-widest uppercase"
            style={{ color: "var(--lime-dim)" }}
          >
            Live · Auto-updating
          </span>
        </div>

        {/* Wordmark */}
        <h1
          className="text-5xl font-bold tracking-tighter leading-none mb-3"
          style={{ color: "var(--text-1)", fontFamily: "var(--font-ubuntu)" }}
        >
          Jobs<span style={{ color: "var(--lime)" }}>Agr</span>
        </h1>

        {/* Tagline */}
        <p
          className="text-sm leading-relaxed max-w-md mb-2"
          style={{ color: "var(--text-2)" }}
        >
          An ElizaOS agent autonomously navigates company profiles, finds career
          pages, and surfaces opportunities in real-time.
        </p>

        {/* Powered by */}
        <p
          className="text-xs font-mono mb-8"
          style={{ color: "var(--text-3)" }}
        >
          Powered by{" "}
          <span style={{ color: "var(--text-2)" }}>ElizaOS</span>
          {" × "}
          <span style={{ color: "var(--text-2)" }}>Nosana</span>{" "}
          decentralized compute
        </p>

        {/* Search */}
        <div className="relative w-full max-w-sm">
          <span className="absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none">
            <SearchIcon />
          </span>
          <input
            className="search-input"
            type="text"
            placeholder="Search roles, companies, keywords…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </header>

      {/* ── Body ── */}
      <main className="max-w-4xl mx-auto px-6 pb-20">

        {/* Toolbar: filters + count */}
        <div className="flex flex-col items-center justify-center gap-4 py-5">

          {/* Company filters */}
          {companies.length > 0 && (
            <div className="flex justify-center gap-1.5 flex-wrap w-full">
              <button
                className={`filter-btn ${!selectedCompany ? "active" : ""}`}
                onClick={() => setSelectedCompany(null)}
              >
                All{jobs.length > 0 && ` (${jobs.length})`}
              </button>
              {companies.map((co) => {
                const n = jobs.filter((j) => j.company_name === co).length;
                return (
                  <button
                    key={co}
                    className={`filter-btn ${selectedCompany === co ? "active" : ""}`}
                    onClick={() =>
                      setSelectedCompany(selectedCompany === co ? null : co)
                    }
                  >
                    {co} ({n})
                  </button>
                );
              })}
            </div>
          )}

          {/* Meta */}
          <div className="text-center">
            <span
              className="text-xs font-mono"
              style={{ color: "var(--text-3)" }}
            >
              {loading ? (
                "Loading…"
              ) : (
                <>
                  <span style={{ color: "var(--text-2)" }}>{filtered.length}</span>{" "}
                  {filtered.length === 1 ? "role" : "roles"}
                  {jobs.length > 0 && (
                    <> · updated {timeAgo(jobs[0].scraped_at)}</>
                  )}
                </>
              )}
            </span>
          </div>
        </div>

        {/* Divider */}
        <div style={{ height: "1px", background: "var(--border)", marginBottom: "20px" }} />

        {/* Grid */}
        {loading ? (
          <SkeletonGrid />
        ) : filtered.length === 0 ? (
          <EmptyState filtered={isFiltered} />
        ) : (
          <div className="flex flex-col gap-3">
            {filtered.map((job, i) => (
              <JobCard key={job.id} job={job} index={i} />
            ))}
          </div>
        )}
      </main>

      {/* ── Footer ── */}
      <footer
        className="text-center text-xs font-mono py-6 px-6"
        style={{
          borderTop: "1px solid var(--border)",
          color: "var(--text-3)",
          letterSpacing: "0.03em",
        }}
      >
        Built with ElizaOS × Nosana
      </footer>
    </div>
  );
}
