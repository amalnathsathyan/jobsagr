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
}

export async function upsertJobs(jobs: JobRow[]): Promise<number> {
  if (jobs.length === 0) return 0;

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("jobs")
    .upsert(jobs, { onConflict: "title,company_name,link", ignoreDuplicates: true })
    .select();

  if (error) {
    console.error("Supabase upsert error:", error.message);
    return 0;
  }

  return data?.length ?? 0;
}
