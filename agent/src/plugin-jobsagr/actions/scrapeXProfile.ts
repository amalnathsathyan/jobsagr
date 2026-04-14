/**
 * SCRAPE_X_PROFILE
 *
 * Full pipeline (all 5 action files integrated):
 * 1. Load X profile → extract jobs shown directly on X (e.g. Arbitrum "We're Hiring")
 * 2. Get website link → navigate to it
 * 3. Handle link aggregators (Linktree, etc.)
 * 4. Find careers page (link scoring + path guessing + LLM-assisted)
 * 5. BFS-crawl careers page for individual job URLs (crawlCareerListings)
 * 6. Extract structured details per job page (extractJobDetail) — title, summary, category
 * 7. Store enriched jobs in Supabase
 *
 * Fallback: if BFS finds no individual job URLs, uses single-page LLM extraction
 */

import { type Action, type IAgentRuntime, ModelType } from "@elizaos/core";
import { randomUUID } from "crypto";
import { type Page } from "playwright";
import { createPage } from "../services/browser.js";
import { upsertJobs, type JobRow } from "../services/supabase.js";
import { crawlCareerListings } from "./crawlCareerListings.js";
import { extractJobDetail } from "./extractJobDetail.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const LINK_AGGREGATOR_PATTERNS = [
  "linktr.ee", "bio.link", "beacons.ai", "lnk.bio",
  "campsite.bio", "taplink.cc", "allmylinks.com",
];

const SKIP_DOMAINS = [
  "twitter.com", "x.com", "instagram.com", "youtube.com",
  "discord.gg", "discord.com", "t.me", "telegram.me",
  "facebook.com", "tiktok.com", "medium.com",
  "mirror.xyz", "substack.com", "warpcast.com",
];

const CAREERS_KEYWORDS = [
  "careers", "jobs", "hiring", "join us", "join the team",
  "open roles", "work with us", "opportunities",
  "we're hiring", "positions", "vacancies", "join our team",
];

const CAREERS_PATH_GUESSES = [
  "/careers", "/jobs", "/join", "/join-us", "/join-the-team",
  "/work-with-us", "/opportunities", "/hiring", "/open-roles",
  "/about/careers", "/company/careers", "/en/careers",
];

const JOB_BOARD_DOMAINS = [
  "lever.co", "greenhouse.io", "ashbyhq.com", "workable.com",
  "workday.com", "smartrecruiters.com", "breezy.hr", "recruitee.com",
  "jobvite.com", "icims.com", "taleo.net", "bamboohr.com",
  "notion.site", "apply.workable", "jobs.ashbyhq",
];

const APP_SUBDOMAINS = [
  "app", "dashboard", "docs", "explorer", "beta", 
  "testnet", "staging", "dev", "demo", "portal",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeInputUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.hostname.split(".");
    if (parts.length >= 3 && APP_SUBDOMAINS.includes(parts[0])) {
      u.hostname = parts.slice(1).join(".");
      return u.origin;
    }
  } catch {}
  return url;
}

const isAggregator = (url: string) => LINK_AGGREGATOR_PATTERNS.some((p) => url.includes(p));
const isSkippable = (url: string) => SKIP_DOMAINS.some((d) => url.includes(d));
const isCareersUrl = (url: string) => {
  const lower = url.toLowerCase();
  return CAREERS_KEYWORDS.some((k) => lower.includes(k)) || JOB_BOARD_DOMAINS.some((d) => lower.includes(d));
};
const settle = (page: Page, ms = 2500) => page.waitForTimeout(ms);

// ─── Step 0: Extract jobs shown directly on the X profile page ───────────────
// Some companies (e.g. Arbitrum) show a "We're Hiring" widget with job cards
// directly on their X profile. Grab those before navigating away.

async function extractXProfileJobs(page: Page, cb: (msg: string) => void): Promise<JobRow[]> {
  const jobs: JobRow[] = [];

  try {
    // X renders job cards in a hiring section
    // Selectors observed: [data-testid="jobCard"], elements containing job titles + location
    const hiringSection = await page.$('[data-testid="profileHiring"], [aria-label*="hiring"], [aria-label*="Hiring"]').catch(() => null);

    if (!hiringSection) {
      // Check for any visible "We're Hiring" / jobs text block
      const bodyText = await page.innerText("body").catch(() => "");
      if (!bodyText.toLowerCase().includes("hiring") && !bodyText.toLowerCase().includes("open roles")) {
        return jobs;
      }
    }

    // Collect all job-like links on the profile page
    const allLinks = await page.$$eval("a[href]", (els: any[]) =>
      els.map((a) => ({
        href: (a.href || "").trim(),
        text: (a.innerText || "").replace(/\s+/g, " ").trim(),
        ariaLabel: (a.getAttribute("aria-label") || "").trim(),
      }))
    ).catch(() => [] as { href: string; text: string; ariaLabel: string }[]);

    // Job board links found directly on X profile
    const jobBoardLinks = allLinks.filter(({ href }) =>
      JOB_BOARD_DOMAINS.some((d) => href.includes(d))
    );

    if (jobBoardLinks.length > 0) {
      console.log(`🎯 Found ${jobBoardLinks.length} job board links on X profile directly`);
      for (const { href, text, ariaLabel } of jobBoardLinks) {
        const title = text || ariaLabel || href.split("/").filter(Boolean).pop() || "Job Opening";
        if (title.length > 3 && title.length < 150) {
          jobs.push({ title, link: href, description: "" });
        }
      }
      return jobs;
    }

    // Try to find job titles in "We're Hiring" cards
    // X renders these as article elements or divs with role="link"
    const jobCards = await page.$$eval(
      '[data-testid="jobCard"], [data-testid="hiringSectionCard"]',
      (els: any[]) =>
        els.map((el) => ({
          title: (el.querySelector('[data-testid="jobTitle"]')?.innerText || el.innerText || "").trim(),
          href: (el.querySelector("a")?.href || "").trim(),
        }))
    ).catch(() => [] as { title: string; href: string }[]);

    if (jobCards.length > 0) {
      console.log(`🎯 Found ${jobCards.length} job cards on X profile`);
      for (const { title, href } of jobCards) {
        if (title.length > 3) jobs.push({ title, link: href, description: "" });
      }
    }
  } catch (err: any) {
    console.log(`⚠️  X profile job extraction skipped: ${err.message}`);
  }

  return jobs;
}

// ─── LLM-assisted careers URL finder ─────────────────────────────────────────
// When link scoring fails, ask the LLM to identify the careers page from a
// list of all links on the company's homepage.

async function findCareersUrlWithLLM(
  runtime: IAgentRuntime,
  page: Page,
  officialWebsite: string,
  cb: (msg: string) => void
): Promise<string | null> {
  console.log("🤖 Using LLM to find careers page from site links...");

  const allLinks = await page.$$eval("a[href]", (els: any[]) =>
    els
      .map((a) => ({
        href: (a.href || "").trim(),
        text: (a.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80),
      }))
      .filter(({ href }) => href.startsWith("http") && href.length < 300)
      .slice(0, 100)
  ).catch(() => [] as { href: string; text: string }[]);

  if (allLinks.length === 0) return null;

  const linkList = allLinks.map((l) => `${l.text} | ${l.href}`).join("\n");

  const prompt = `You are given a list of links from a company website: ${officialWebsite}

Find the URL that leads to their careers/jobs page where they post job openings. This might also be a gateway CTA like "View Open Roles", "Explore Opportunities", or "Join Our Team".
Return ONLY the URL string, nothing else. No explanation. No markdown.
If no careers page or job link is found, return the word: null

Links:
${linkList}`;

  const response = (await runtime.useModel(ModelType.TEXT_LARGE, { prompt })) as string;

  // Strip thinking tags from reasoning models
  const cleaned = response
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```/g, "")
    .trim()
    .split("\n")[0]
    .trim();

  if (!cleaned || cleaned === "null" || !cleaned.startsWith("http")) return null;

  console.log(`🤖 LLM identified careers URL: ${cleaned}`);
  return cleaned;
}

// ─── Careers page link finder (score + guess + LLM) ──────────────────────────

function careersScore(href: string, text: string): number {
  let score = 0;
  for (const kw of CAREERS_KEYWORDS) {
    if (text.toLowerCase().includes(kw)) score += 4;
    if (href.toLowerCase().includes(kw)) score += 3;
  }
  return score;
}

async function findCareersLink(
  runtime: IAgentRuntime,
  page: Page,
  officialWebsite: string,
  cb: (msg: string) => void
): Promise<string | null> {
  // 1. Score-based link search
  const links = await page.$$eval("a[href]", (els: any[]) =>
    els.map((a) => ({ href: (a.href || "").trim(), text: (a.innerText || "").toLowerCase().trim() }))
  ).catch(() => [] as { href: string; text: string }[]);

  let best: { href: string; score: number } | null = null;
  for (const { href, text } of links) {
    if (!href.startsWith("http")) continue;
    const score = careersScore(href, text);
    if (score > 0 && (!best || score > best.score)) best = { href, score };
  }
  if (best) { cb(`✅ Found via link scoring (score=${best.score}): ${best.href}`); return best.href; }

  // 2. Common path probing
  const base = new URL(officialWebsite).origin;
  for (const p of CAREERS_PATH_GUESSES) {
    try {
      const resp = await page.goto(base + p, { timeout: 8000, waitUntil: "domcontentloaded" });
      if (resp && resp.status() >= 200 && resp.status() < 400) {
        console.log(`✅ Found via path probe: ${base + p}`);
        return base + p;
      }
    } catch { /* skip */ }
  }

  // 3. Subdomain guessing (if careers link not found on base domain)
  const baseDomain = new URL(officialWebsite).hostname.replace(/^www\./, "");
  const SUBDOMAINS = ["chain", "team", "company", "careers", "jobs", "about", "www"];
  for (const sub of SUBDOMAINS) {
      if (baseDomain.startsWith(sub + ".")) continue;
      const subUrl = `https://${sub}.${baseDomain}`;
      try {
          const resp = await page.goto(subUrl, { timeout: 8000, waitUntil: "domcontentloaded" });
          if (resp && resp.status() >= 200 && resp.status() < 400) {
              const score = careersScore(subUrl, await page.title().catch(()=>""));
              if (score > 0 || sub === "careers" || sub === "jobs") {
                  console.log(`✅ Found via subdomain guess: ${subUrl}`);
                  return subUrl;
              }
              // Try finding a careers link on this subdomain
              const subLinks = await page.$$eval("a[href]", (els: any[]) =>
                els.map((a) => ({ href: (a.href || "").trim(), text: (a.innerText || "").toLowerCase().trim() }))
              ).catch(() => [] as { href: string; text: string }[]);
              
              for (const { href, text: subText } of subLinks) {
                if (!href.startsWith("http")) continue;
                if (careersScore(href, subText) > 0) {
                    console.log(`✅ Found on subdomain ${subUrl}: ${href}`);
                    return href;
                }
              }
          }
      } catch { /* skip */ }
  }

  // Navigate back to homepage before LLM step
  try {
    await page.goto(officialWebsite, { timeout: 15000, waitUntil: "domcontentloaded" });
    await settle(page, 2000);
  } catch { /* ignore */ }

  // 3. LLM fallback
  return findCareersUrlWithLLM(runtime, page, officialWebsite, cb);
}

// ─── Aggregator resolver ──────────────────────────────────────────────────────

async function resolveAggregator(page: Page, aggregatorUrl: string, cb: (msg: string) => void): Promise<string> {
  console.log(`🌳 Aggregator detected — ${aggregatorUrl}`);
  await page.goto(aggregatorUrl, { timeout: 15000, waitUntil: "domcontentloaded" });
  await settle(page);

  const domain = new URL(page.url()).hostname.replace("www.", "");
  const links = await page.$$eval("a[href]", (els: any[], { d, skip }: any) =>
    els
      .map((a) => ({ href: (a.href || "").trim() }))
      .filter(({ href }) => {
        if (!href.startsWith("http")) return false;
        if (skip.some((s: string) => href.includes(s))) return false;
        try { return !new URL(href).hostname.includes(d); } catch { return false; }
      }),
    { d: domain, skip: SKIP_DOMAINS }
  ).catch(() => [] as { href: string }[]);

  const official = links.find(({ href }) => !isAggregator(href));
  if (official) { cb(`✅ Official site from aggregator: ${official.href}`); return official.href; }

  console.log(`⚠️  Could not resolve aggregator, using as-is`);
  return aggregatorUrl;
}

// ─── SPA-aware page content extraction ───────────────────────────────────────

async function extractPageContent(page: Page, url: string, cb: (msg: string) => void) {
  try {
    await page.goto(url, { timeout: 25000, waitUntil: "networkidle" });
  } catch {
    console.log("⚠️  networkidle timed out, proceeding with what loaded...");
  }
  await settle(page, 3000);

  const title = await page.title().catch(() => "");
  const bodyText = await page.innerText("body").catch(() => "");
  const allLinks = await page.$$eval("a[href]", (els: any[]) =>
    els
      .map((a) => ({
        href: (a.href || "").trim(),
        text: (a.innerText || "").replace(/\s+/g, " ").trim(),
      }))
      .filter(({ href, text }) => href.startsWith("http") && text.length > 2 && text.length < 200)
  ).catch(() => [] as { href: string; text: string }[]);

  console.log(`📄 Page: ${bodyText.length} chars, ${allLinks.length} links`);
  return { bodyText, allLinks, title };
}

// ─── Job extraction from careers page ────────────────────────────────────────

async function extractJobsFromPage(
  runtime: IAgentRuntime,
  page: Page,
  careersUrl: string,
  cb: (msg: string) => void
): Promise<{ title: string; description?: string; link?: string }[]> {
  const { bodyText, allLinks, title } = await extractPageContent(page, careersUrl, cb);

  // Build link dump for LLM — include ALL links so it can reason about which are jobs
  const linkDump = allLinks
    .map((l) => `${l.text} | ${l.href}`)
    .join("\n")
    .slice(0, 4000);

  const prompt = `Extract all job listings from this careers page.
Output ONLY a raw JSON array, nothing else. No markdown. No code fences. No explanation.
Schema: [{"title":"<job title>","description":"<one sentence max>","link":"<apply URL>"}]

Rules:
- "title" must be an actual job title (e.g. "Software Engineer", "Head of Marketing")
- Exclude navigation links, blog posts, events, generic "Apply" buttons without a title
- Use the most specific apply/job URL available as "link"
- If no real job listings exist, return []

Careers URL: ${careersUrl}
Page title: ${title}

=== BODY TEXT (first 3000 chars) ===
${bodyText.slice(0, 3000)}

=== ALL LINKS ON PAGE (text | url) ===
${linkDump}`;

  console.log("🤖 Asking LLM to extract jobs...");
  const raw = (await runtime.useModel(ModelType.TEXT_LARGE, { prompt })) as string;
  console.log(`📝 LLM preview: ${raw.slice(0, 150)}`);

  // Strip <think>...</think> from reasoning models (greedy for nested/multiline)
  let stripped = raw.replace(/<think>[\s\S]*<\/think>/gi, "").trim();

  // If stripping removed everything, use raw
  if (stripped.length < 5) stripped = raw;

  stripped = stripped.replace(/```json|```/g, "").trim();

  let jobs: { title: string; description?: string; link?: string }[] = [];

  // Try to find JSON array — use greedy match for nested objects
  const arrayMatch = stripped.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      jobs = JSON.parse(arrayMatch[0]);
      // Sanity-filter: title must look like a job, not a URL or nav item
      jobs = jobs.filter(
        (j) =>
          j.title &&
          j.title.length > 3 &&
          j.title.length < 120 &&
          !j.title.startsWith("http") &&
          !["cookie", "privacy", "terms", "home", "about", "blog"].some((bad) =>
            j.title.toLowerCase().includes(bad)
          )
      );
    } catch (e) {
      console.log(`⚠️  JSON parse error: ${(e as Error).message}`);
    }
  }

  console.log(`📊 LLM extracted: ${jobs.length} jobs`);

  // Fallback: external job board links only (not same-domain)
  if (jobs.length === 0) {
    const careersHost = new URL(careersUrl).hostname;
    const jobBoardLinks = allLinks.filter(({ href }) => {
      try {
        const host = new URL(href).hostname;
        return host !== careersHost && JOB_BOARD_DOMAINS.some((d) => host.includes(d));
      } catch { return false; }
    });

    if (jobBoardLinks.length > 0) {
      console.log(`🔁 Fallback: ${jobBoardLinks.length} external job board links`);
      jobs = jobBoardLinks.map(({ href, text }) => ({
        title: text || href.split("/").filter(Boolean).pop() || "Job Opening",
        description: "",
        link: href,
      }));
    }
  }

  return jobs;
}

// ─── Main Action ──────────────────────────────────────────────────────────────

export const scrapeXProfile: Action = {
  name: "DISCOVER_COMPANY_JOBS",
  similes: ["FIND_JOBS", "DISCOVER_JOBS", "CHECK_X_PROFILE", "FIND_COMPANY_JOBS", "GET_JOBS_FROM_X", "SCRAPE_WEBSITE"],
  description:
    "Given any company website URL or X (Twitter) profile URL, finds job listings by navigating to the website, finding the careers page, and extracting/storing all job listings. Preserves X profile checks if an X URL is provided.",

  validate: async (_runtime, message) => {
    const text = message.content?.text || "";
    return /https?:\/\/[^\s]+/.test(text);
  },

  handler: async (runtime, message, _state, _options, callback) => {
    const cb = (msg: string) => callback?.({ text: msg, responseId: randomUUID() });
    const text = message.content?.text || "";

    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) {
      cb("Provide a valid URL (e.g. https://x.com/arbitrum or https://tydrohq.com).");
      return { success: false, text: "No URL found." };
    }

    const inputUrl = urlMatch[0];
    const isXProfile = inputUrl.includes("x.com") || inputUrl.includes("twitter.com");
    
    let profileUrl = "";
    let handle = "";
    let displayName = "";
    let websiteUrl = inputUrl;
    let xProfileJobs: JobRow[] = [];

    const page = await createPage();

    try {
      if (isXProfile) {
        const handleMatch = inputUrl.match(/https?:\/\/(?:x\.com|twitter\.com)\/([A-Za-z0-9_]+)/);
        if (!handleMatch) {
            cb("Provide a valid X profile URL or company website.");
            return { success: false, text: "Invalid X URL." };
        }
        profileUrl = inputUrl;
        handle = handleMatch[1];
        displayName = handle;

        // ── 1. Load X profile ──────────────────────────────────────────────
        cb(`📍 Step 1 — Loading X profile: ${profileUrl}`);
        await page.goto(profileUrl, { timeout: 25000, waitUntil: "domcontentloaded" });
        await settle(page, 4000);

        const loginWall = await page.$('input[autocomplete="username"]').then(Boolean).catch(() => false);
        if (loginWall) {
          await page.close();
          console.log("⚠️ Login wall. Re-run: bun scripts/xLogin.ts");
          return { success: false, text: "Login wall detected." };
        }

        displayName = await page
          .$eval('[data-testid="UserName"] span', (el: any) => el.innerText.trim())
          .catch(() => handle);

        const bio = await page
          .$eval('[data-testid="UserDescription"]', (el: any) => el.innerText.trim())
          .catch(() => "");

        console.log(`✅ Profile: ${displayName} (@${handle})\n📝 ${bio || "(no bio)"}`);

        // ── 1b. Extract jobs shown directly on X profile (Arbitrum-style) ──
        console.log(`🔍 Checking for jobs shown directly on X profile...`);
        xProfileJobs = await extractXProfileJobs(page, cb);
        if (xProfileJobs.length > 0) {
          console.log(`🎯 Found ${xProfileJobs.length} jobs on X profile page itself — storing...`);
          const rows: JobRow[] = xProfileJobs.map((j) => ({
            ...j,
            company_name: displayName,
            company_x_handle: handle,
            company_website: "",
            source_url: profileUrl,
          }));
          const stored = await upsertJobs(rows);
          console.log(`✅ Stored ${stored} X-profile jobs. Continuing to find more from website...`);
        }

        // ── 2. Get website link from X profile ────────────────────────────
        websiteUrl =
          (await page.$eval('[data-testid="UserUrl"] a', (el: any) => el.href).catch(() => "")) ||
          (await page
            .$$eval('[data-testid="UserProfileHeader_Items"] a[href]', (els: any[]) =>
              els.map((a) => a.href)
            )
            .catch(() => [])
            .then((ls: string[]) =>
              ls.find((l) => !l.includes("x.com") && !l.includes("twitter.com")) || ""
            )) ||
          (await page
            .$$eval('a[href*="t.co"]', (els: any[]) => els.map((a) => a.href))
            .catch(() => [])
            .then((ls: string[]) => ls[0] || ""));

        if (!websiteUrl) {
          await page.close();
          if (xProfileJobs.length > 0) {
            console.log(`⚠️  No website link on @${handle}, but stored ${xProfileJobs.length} X-profile jobs.`);
            return { success: true, text: `Found ${xProfileJobs.length} jobs directly on @${handle}'s X profile.` };
          }
          console.log(`❌ No website link found on @${handle}'s profile.`);
          return { success: false, text: `No website link on @${handle}.` };
        }
      } else {
        // Direct website link
        cb(`📍 Step 1 — Direct website provided: ${inputUrl}`);
        try {
          const tempUrl = new URL(inputUrl);
          const atsMatch = JOB_BOARD_DOMAINS.some((d) => tempUrl.hostname.includes(d));
          if (atsMatch) {
            const segments = tempUrl.pathname.split("/").filter(Boolean);
            displayName = segments.length > 0 ? segments[0] : tempUrl.hostname.replace(/^www\./, "");
          } else {
            displayName = tempUrl.hostname.replace(/^www\./, "");
          }
        } catch {
          displayName = inputUrl;
        }
        handle = ""; // No X handle
        websiteUrl = inputUrl;
      }

      websiteUrl = normalizeInputUrl(websiteUrl);
      console.log(`🔗 Normalized Website: ${websiteUrl}`);

      // ── 3. Navigate to website ─────────────────────────────────────────
      console.log(`🌐 Step 2 — Navigating to: ${websiteUrl}`);
      await page.goto(websiteUrl, { timeout: 20000, waitUntil: "domcontentloaded" });
      await settle(page);
      let currentUrl = page.url();
      console.log(`   Landed: ${currentUrl}`);

      // ── 4. Resolve aggregator ──────────────────────────────────────────
      if (isAggregator(currentUrl)) {
        const officialSite = await resolveAggregator(page, currentUrl, cb);
        await page.goto(officialSite, { timeout: 20000, waitUntil: "domcontentloaded" });
        await settle(page);
        currentUrl = page.url();
        console.log(`   Now on: ${currentUrl}`);
      }

      const officialWebsite = currentUrl;

      // ── 5. Find careers page ───────────────────────────────────────────
      console.log(`🔍 Step 4 — Looking for careers page on ${new URL(officialWebsite).hostname}`);

      let careersUrl: string | null = null;
      if (isCareersUrl(officialWebsite)) {
        careersUrl = officialWebsite;
        console.log(`   Already on careers page!`);
      } else {
        careersUrl = await findCareersLink(runtime, page, officialWebsite, cb);
      }

      if (!careersUrl) {
        await page.close();
        const summary = xProfileJobs.length > 0
          ? `No careers page found, but stored ${xProfileJobs.length} jobs from X profile.`
          : `No careers page found for ${displayName} at ${officialWebsite}.`;
        console.log(`❌ ${summary}`);
        return { success: xProfileJobs.length > 0, text: summary };
      }

      console.log(`✅ Careers page: ${careersUrl}`);

      // ── 6. Crawl careers page for individual job URLs ──────────────────
      console.log(`📋 Step 5 — Crawling careers page for individual job URLs...`);
      await page.close(); // done with the navigation page

      const jobUrls = await crawlCareerListings(careersUrl!, cb);
      let careersPageJobs: JobRow[] = [];
      let totalStored = 0;

      if (jobUrls.length > 0) {
        // ── 7. Extract structured details from each job URL ──────────────
        const BATCH_SIZE = 3;
        const MAX_DETAIL_PAGES = 20;
        const urlsToProcess = jobUrls.slice(0, MAX_DETAIL_PAGES);
        console.log(`🔬 Step 6 — Extracting details from ${urlsToProcess.length} job pages (batches of ${BATCH_SIZE})...`);

        for (let i = 0; i < urlsToProcess.length; i += BATCH_SIZE) {
          const batch = urlsToProcess.slice(i, i + BATCH_SIZE);
          const results = await Promise.allSettled(
            batch.map((url) => extractJobDetail(runtime, url))
          );

          const batchJobs: JobRow[] = [];
          for (const result of results) {
            if (result.status === "fulfilled" && result.value) {
              const d = result.value;
              const row: JobRow = {
                title: d.title,
                description: d.description,
                summary: d.summary,
                category: d.category,
                content_hash: d.content_hash,
                canonical_url: d.canonical_url,
                link: d.apply_url,
                company_name: displayName,
                company_x_handle: handle,
                company_website: officialWebsite,
                source_url: careersUrl!,
              };
              batchJobs.push(row);
              careersPageJobs.push(row);
            }
          }

          // Upsert this batch immediately — skip on failure, continue to next batch
          const batchNum = Math.floor(i / BATCH_SIZE) + 1;
          const totalBatches = Math.ceil(urlsToProcess.length / BATCH_SIZE);

          if (batchJobs.length > 0) {
            try {
              const stored = await upsertJobs(batchJobs);
              totalStored += stored;
              console.log(`  ✅ Batch ${batchNum}/${totalBatches}: ${batchJobs.length} extracted, ${stored} stored (total: ${totalStored})`);
            } catch (dbErr: any) {
              console.log(`  ❌ Batch ${batchNum}/${totalBatches}: DB upsert failed (${dbErr.message}) — skipping, continuing...`);
            }
          } else {
            console.log(`  ⚠️  Batch ${batchNum}/${totalBatches}: 0 jobs extracted`);
          }
        }
      }

      // Fallback: if crawler found no individual job URLs, try single-page LLM extraction
      if (careersPageJobs.length === 0) {
        console.log(`⚠️  No jobs from crawler — falling back to page-level LLM extraction...`);
        const fallbackPage = await createPage();
        const fallbackJobs = await extractJobsFromPage(runtime, fallbackPage, careersUrl!, cb);
        await fallbackPage.close();

        const fallbackRows = fallbackJobs.map((j) => ({
          title: j.title,
          description: j.description || "",
          link: j.link || careersUrl!,
          company_name: displayName,
          company_x_handle: handle,
          company_website: officialWebsite,
          source_url: careersUrl!,
        }));

        if (fallbackRows.length > 0) {
          totalStored = await upsertJobs(fallbackRows);
          careersPageJobs = fallbackRows;
        }
      }

      const totalFound = xProfileJobs.length + careersPageJobs.length;

      if (careersPageJobs.length === 0) {
        const summary = xProfileJobs.length > 0
          ? `No additional jobs on careers page, but already stored ${xProfileJobs.length} from X profile.`
          : `Found careers page (${careersUrl}) but no jobs extracted.`;
        console.log(`⚠️  ${summary}`);
        return { success: true, text: summary };
      }

      cb(`🎉 ${displayName} — ${totalFound} total jobs found, ${totalStored} new from careers page stored.`);
      return {
        success: true,
        text: `✅ ${displayName} (@${handle}): found ${totalFound} jobs total, ${totalStored} stored from careers page. Careers: ${careersUrl}`,
        data: { companyName: displayName, xHandle: handle, website: officialWebsite, careersUrl, jobsFound: totalFound, jobsStored: totalStored },
      };

    } catch (err: any) {
      await page.close().catch(() => { });
      console.log(`❌ Pipeline failed: ${err.message}`);
      return { success: false, text: `Error: ${err.message}` };
    }
  },

  examples: [
    [
      { name: "user", content: { text: "Find jobs from https://x.com/arbitrum" } },
      { name: "agent", content: { text: "Starting job discovery for @arbitrum.", action: "DISCOVER_COMPANY_JOBS" } },
    ],
    [
      { name: "user", content: { text: "https://x.com/circle" } },
      { name: "agent", content: { text: "I'll scan Circle's profile and website for open roles.", action: "DISCOVER_COMPANY_JOBS" } },
    ],
  ],
};