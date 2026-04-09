"use client";

import { useEffect, useState, useMemo } from "react";
import { supabase, type Job } from "@/lib/db";

function timeAgo(dateStr: string): string {
  const seconds = Math.floor(
    (Date.now() - new Date(dateStr).getTime()) / 1000
  );
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function SearchIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ color: "var(--text-muted)" }}
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function BriefcaseIcon() {
  return (
    <svg
      width="64"
      height="64"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
      <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
    </svg>
  );
}

export default function Home() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);

  // Fetch jobs from Supabase
  useEffect(() => {
    async function fetchJobs() {
      const { data, error } = await supabase
        .from("jobs")
        .select("*")
        .order("scraped_at", { ascending: false });

      if (!error && data) {
        setJobs(data);
      }
      setLoading(false);
    }

    fetchJobs();

    // Real-time subscription
    const channel = supabase
      .channel("jobs-realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "jobs" },
        (payload) => {
          setJobs((prev) => [payload.new as Job, ...prev]);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // Derive unique companies
  const companies = useMemo(() => {
    const set = new Set(jobs.map((j) => j.company_name).filter(Boolean));
    return Array.from(set).sort() as string[];
  }, [jobs]);

  // Filter jobs
  const filtered = useMemo(() => {
    return jobs.filter((job) => {
      const matchesSearch =
        !search ||
        job.title.toLowerCase().includes(search.toLowerCase()) ||
        (job.description?.toLowerCase().includes(search.toLowerCase()) ?? false) ||
        (job.company_name?.toLowerCase().includes(search.toLowerCase()) ?? false);

      const matchesCompany =
        !selectedCompany || job.company_name === selectedCompany;

      return matchesSearch && matchesCompany;
    });
  }, [jobs, search, selectedCompany]);

  return (
    <div style={{ minHeight: "100vh" }}>
      {/* Hero Section */}
      <header className="hero-bg" style={{ padding: "80px 24px 40px", position: "relative" }}>
        <div style={{ maxWidth: 1000, margin: "0 auto", position: "relative", zIndex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
            <div className="pulse-dot" />
            <span className="badge badge-teal">Live • Auto-updating</span>
          </div>

          <h1
            style={{
              fontSize: "clamp(2rem, 5vw, 3.5rem)",
              fontWeight: 800,
              lineHeight: 1.1,
              marginBottom: 16,
              letterSpacing: "-0.03em",
            }}
          >
            <span className="gradient-text">JobsAgr</span>
          </h1>

          <p
            style={{
              fontSize: "1.15rem",
              color: "var(--text-secondary)",
              maxWidth: 560,
              lineHeight: 1.6,
              marginBottom: 8,
            }}
          >
            AI-powered job discovery — an ElizaOS agent autonomously scrapes
            company X profiles, finds career pages, and surfaces opportunities
            here in real-time.
          </p>

          <p
            style={{
              fontSize: "0.85rem",
              color: "var(--text-muted)",
              marginBottom: 32,
            }}
          >
            Powered by{" "}
            <span style={{ color: "var(--accent-purple)" }}>ElizaOS</span> ×{" "}
            <span style={{ color: "var(--accent-teal)" }}>Nosana</span>{" "}
            decentralized compute
          </p>

          {/* Search */}
          <div style={{ position: "relative", maxWidth: 480 }}>
            <div
              style={{
                position: "absolute",
                left: 14,
                top: "50%",
                transform: "translateY(-50%)",
              }}
            >
              <SearchIcon />
            </div>
            <input
              id="search-jobs"
              className="search-input"
              type="text"
              placeholder="Search jobs, companies..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main style={{ maxWidth: 1000, margin: "0 auto", padding: "0 24px 80px" }}>
        {/* Company Filters */}
        {companies.length > 0 && (
          <div
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              marginBottom: 32,
              paddingTop: 8,
            }}
          >
            <button
              className={`filter-btn ${!selectedCompany ? "active" : ""}`}
              onClick={() => setSelectedCompany(null)}
            >
              All ({jobs.length})
            </button>
            {companies.map((company) => {
              const count = jobs.filter((j) => j.company_name === company).length;
              return (
                <button
                  key={company}
                  className={`filter-btn ${selectedCompany === company ? "active" : ""}`}
                  onClick={() =>
                    setSelectedCompany(
                      selectedCompany === company ? null : company
                    )
                  }
                >
                  {company} ({count})
                </button>
              );
            })}
          </div>
        )}

        {/* Stats Bar */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 20,
            fontSize: "0.85rem",
            color: "var(--text-muted)",
          }}
        >
          <span>
            {loading
              ? "Loading..."
              : `${filtered.length} ${filtered.length === 1 ? "opportunity" : "opportunities"} found`}
          </span>
          {jobs.length > 0 && (
            <span>
              Last updated: {timeAgo(jobs[0].scraped_at)}
            </span>
          )}
        </div>

        {/* Job Grid */}
        {loading ? (
          <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div
                key={i}
                className="glass-card"
                style={{
                  padding: 24,
                  height: 160,
                  background: "var(--bg-card)",
                  animation: `pulse 1.5s ease-in-out infinite`,
                  opacity: 0.5,
                }}
              />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <BriefcaseIcon />
            <h3 style={{ fontSize: "1.2rem", marginBottom: 8, color: "var(--text-secondary)" }}>
              {search || selectedCompany
                ? "No matching jobs found"
                : "No jobs discovered yet"}
            </h3>
            <p style={{ fontSize: "0.9rem" }}>
              {search || selectedCompany
                ? "Try adjusting your search or filters."
                : "The agent is scanning company profiles. Jobs will appear here in real-time."}
            </p>
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gap: 16,
              gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
            }}
          >
            {filtered.map((job, i) => (
              <div
                key={job.id}
                className="glass-card animate-in"
                style={{
                  padding: 24,
                  animationDelay: `${i * 50}ms`,
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  minHeight: 160,
                }}
              >
                <div>
                  {/* Company */}
                  {job.company_name && (
                    <span
                      className="badge badge-purple"
                      style={{ marginBottom: 12, display: "inline-flex" }}
                    >
                      {job.company_name}
                    </span>
                  )}

                  {/* Title */}
                  <h3
                    style={{
                      fontSize: "1.05rem",
                      fontWeight: 600,
                      lineHeight: 1.3,
                      marginBottom: 8,
                      color: "var(--text-primary)",
                    }}
                  >
                    {job.title}
                  </h3>

                  {/* Description */}
                  {job.description && (
                    <p
                      style={{
                        fontSize: "0.85rem",
                        color: "var(--text-secondary)",
                        lineHeight: 1.5,
                        marginBottom: 12,
                      }}
                    >
                      {job.description}
                    </p>
                  )}
                </div>

                {/* Footer */}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginTop: 8,
                  }}
                >
                  {job.link && (
                    <a
                      href={job.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="external-link"
                    >
                      Apply <ExternalLinkIcon />
                    </a>
                  )}
                  <span
                    style={{
                      fontSize: "0.75rem",
                      color: "var(--text-muted)",
                    }}
                  >
                    {timeAgo(job.scraped_at)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Footer */}
      <footer
        style={{
          borderTop: "1px solid var(--border-subtle)",
          padding: "24px",
          textAlign: "center",
          fontSize: "0.8rem",
          color: "var(--text-muted)",
          marginTop: "auto",
        }}
      >
        Built with ElizaOS × Nosana for the Nosana Builders&apos; Challenge
      </footer>
    </div>
  );
}
