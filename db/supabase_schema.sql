-- JobsAgr Supabase Schema (reference — already applied)
-- Run this in Supabase SQL editor if not already done.

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  link TEXT,
  company_name TEXT,
  company_x_handle TEXT,
  company_website TEXT,
  source_url TEXT,
  scraped_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(title, company_name, link)
);

-- RLS: anyone can read, service_role can write
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read" ON jobs FOR SELECT USING (true);
CREATE POLICY "Service write" ON jobs FOR INSERT WITH CHECK (true);
