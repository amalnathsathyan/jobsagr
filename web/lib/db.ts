import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export interface Job {
  id: string;
  title: string;
  description: string | null;
  link: string | null;
  company_name: string | null;
  company_x_handle: string | null;
  company_website: string | null;
  source_url: string | null;
  scraped_at: string;
  created_at: string;
}

/**
 * Fetches all jobs from the Supabase jobs table, sorted by scraped_at descending.
 * 
 * @returns {Promise<Job[]>} An array of Job objects, or an empty array if an error occurs.
 */
export async function getJobs(): Promise<Job[]> {
  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .order("scraped_at", { ascending: false });

  if (error) {
    console.error("Error fetching jobs:", error.message);
    return [];
  }

  return data ?? [];
}

/**
 * Fetches a list of unique company names from the jobs table.
 * 
 * @returns {Promise<string[]>} An array of distinct company name strings.
 */
export async function getCompanies(): Promise<string[]> {
  const { data, error } = await supabase
    .from("jobs")
    .select("company_name")
    .not("company_name", "is", null);

  if (error) return [];

  const unique = [...new Set((data ?? []).map((d: any) => d.company_name))];
  return unique.filter(Boolean) as string[];
}