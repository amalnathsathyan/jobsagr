-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE TABLE public.jobs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  link text NOT NULL,
  company text,
  source_url text,
  scraped_at timestamp with time zone DEFAULT now(),
  company_name text,
  company_x_handle text,
  company_website text,
  summary text,
  category text,
  canonical_url text,
  content_hash text,
  CONSTRAINT jobs_pkey PRIMARY KEY (id)
);
CREATE TABLE public.scanned_profiles (
  url text NOT NULL,
  last_scanned timestamp with time zone,
  CONSTRAINT scanned_profiles_pkey PRIMARY KEY (url)
);