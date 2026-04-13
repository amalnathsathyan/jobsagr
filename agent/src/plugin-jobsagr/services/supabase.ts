import "dotenv/config";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }

  _client = createClient(url, key);
  return _client;
}

export interface JobRow {
  title: string;
  description?: string;
  link?: string;
  company_name?: string;
  company_x_handle?: string;
  company_website?: string;
  source_url?: string;
  category?: string;
  summary?: string;
  content_hash?: string;
  canonical_url?: string;
}

export async function upsertJobs(jobs: JobRow[]): Promise<number> {
  if (jobs.length === 0) return 0;

  const supabase = getSupabase();

  // Strategy 1: bulk upsert (requires unique index on title,link to exist)
  const { data, error } = await supabase
    .from("jobs")
    .upsert(jobs, { onConflict: "title,link", ignoreDuplicates: true })
    .select("id");

  if (!error) {
    console.log(`✅ Upserted ${data?.length ?? 0} rows`);
    return data?.length ?? 0;
  }

  console.warn(`⚠️  Bulk upsert failed: ${error.message}`);
  console.warn("⚠️  Falling back to row-by-row insert...");

  // Strategy 2: insert each row individually, skip duplicates/column errors gracefully
  let stored = 0;

  for (const job of jobs) {
    // Build full row
    const fullRow: Record<string, unknown> = {
      title: job.title,
      ...(job.description !== undefined && { description: job.description }),
      ...(job.link !== undefined && { link: job.link }),
      ...(job.source_url !== undefined && { source_url: job.source_url }),
      ...(job.company_name !== undefined && { company_name: job.company_name }),
      ...(job.company_x_handle !== undefined && { company_x_handle: job.company_x_handle }),
      ...(job.company_website !== undefined && { company_website: job.company_website }),
      ...(job.category !== undefined && { category: job.category }),
      ...(job.summary !== undefined && { summary: job.summary }),
      ...(job.content_hash !== undefined && { content_hash: job.content_hash }),
      ...(job.canonical_url !== undefined && { canonical_url: job.canonical_url }),
    };

    const { error: err1 } = await supabase.from("jobs").insert(fullRow);

    if (!err1) { stored++; continue; }

    // Column doesn't exist → retry with only base columns
    if (err1.message.includes("column") || err1.message.includes("schema cache")) {
      const baseRow = {
        title: job.title,
        ...(job.description !== undefined && { description: job.description }),
        ...(job.link !== undefined && { link: job.link }),
      };
      const { error: err2 } = await supabase.from("jobs").insert(baseRow);
      if (!err2) { stored++; continue; }
      // Ignore duplicate key violations silently
      if (!err2.message.includes("duplicate") && !err2.message.includes("unique")) {
        console.error(`  ❌ "${job.title}": ${err2.message}`);
      }
      continue;
    }

    // Duplicate key → already exists, not an error
    if (err1.message.includes("duplicate") || err1.message.includes("unique")) continue;

    console.error(`  ❌ "${job.title}": ${err1.message}`);
  }

  if (stored === 0 && jobs.length > 0) {
    console.error(`\n🔴 0 rows stored. Run this SQL in Supabase and retry:\n
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS company_name text,
  ADD COLUMN IF NOT EXISTS company_x_handle text,
  ADD COLUMN IF NOT EXISTS company_website text,
  ADD COLUMN IF NOT EXISTS source_url text;

CREATE UNIQUE INDEX IF NOT EXISTS jobs_title_link_unique ON jobs (title, link);
`);
  } else {
    console.log(`✅ Inserted ${stored}/${jobs.length} rows via fallback`);
  }

  return stored;
}