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

// ─── Helpers ──────────────────────────────────────────────────────────────────

const isAggregator = (url: string) => LINK_AGGREGATOR_PATTERNS.some((p) => url.includes(p));
const isSkippable = (url: string) => SKIP_DOMAINS.some((d) => url.includes(d));
const isCareersUrl = (url: string) => CAREERS_KEYWORDS.some((k) => url.toLowerCase().includes(k));
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
      cb(`🎯 Found ${jobBoardLinks.length} job board links on X profile directly`);
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
      cb(`🎯 Found ${jobCards.length} job cards on X profile`);
      for (const { title, href } of jobCards) {
        if (title.length > 3) jobs.push({ title, link: href, description: "" });
      }
    }
  } catch (err: any) {
    cb(`⚠️  X profile job extraction skipped: ${err.message}`);
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
  cb("🤖 Using LLM to find careers page from site links...");

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

Find the URL that leads to their careers/jobs page where they post job openings.
Return ONLY the URL string, nothing else. No explanation. No markdown.
If no careers page link is found, return the word: null

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

  cb(`🤖 LLM identified careers URL: ${cleaned}`);
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
        cb(`✅ Found via path probe: ${base + p}`);
        return base + p;
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
  cb(`🌳 Aggregator detected — ${aggregatorUrl}`);
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

  cb(`⚠️  Could not resolve aggregator, using as-is`);
  return aggregatorUrl;
}

// ─── SPA-aware page content extraction ───────────────────────────────────────

async function extractPageContent(page: Page, url: string, cb: (msg: string) => void) {
  try {
    await page.goto(url, { timeout: 25000, waitUntil: "networkidle" });
  } catch {
    cb("⚠️  networkidle timed out, proceeding with what loaded...");
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

  cb(`📄 Page: ${bodyText.length} chars, ${allLinks.length} links`);
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

  cb("🤖 Asking LLM to extract jobs...");
  const raw = (await runtime.useModel(ModelType.TEXT_LARGE, { prompt })) as string;
  cb(`📝 LLM preview: ${raw.slice(0, 150)}`);

  // Strip <think>...</think> from reasoning models (DeepSeek R1 etc.)
  const stripped = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```json|```/g, "")
    .trim();

  let jobs: { title: string; description?: string; link?: string }[] = [];
  const match = stripped.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      jobs = JSON.parse(match[0]);
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
      cb(`⚠️  JSON parse error: ${(e as Error).message}`);
    }
  }

  cb(`📊 LLM extracted: ${jobs.length} jobs`);

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
      cb(`🔁 Fallback: ${jobBoardLinks.length} external job board links`);
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
  name: "SCRAPE_X_PROFILE",
  similes: ["FIND_JOBS", "DISCOVER_JOBS", "CHECK_X_PROFILE", "FIND_COMPANY_JOBS", "GET_JOBS_FROM_X"],
  description:
    "Given an X (Twitter) profile URL, finds job listings by: (1) extracting any jobs shown directly on the X profile, (2) navigating to the company website, (3) finding the careers page, (4) extracting and storing all job listings.",

  validate: async (_runtime, message) => {
    const text = message.content?.text || "";
    return text.includes("x.com/") || text.includes("twitter.com/");
  },

  handler: async (runtime, message, _state, _options, callback) => {
    const cb = (msg: string) => callback?.({ text: msg });
    const text = message.content?.text || "";

    const urlMatch = text.match(/https?:\/\/(x\.com|twitter\.com)\/([A-Za-z0-9_]+)/);
    if (!urlMatch) {
      cb("Provide a valid X profile URL (e.g. https://x.com/arbitrum).");
      return { success: false, text: "No X profile URL found." };
    }

    const profileUrl = urlMatch[0];
    const handle = urlMatch[2];
    let displayName = handle;
    const page = await createPage();

    try {
      // ── 1. Load X profile ──────────────────────────────────────────────
      cb(`📍 Step 1 — Loading X profile: ${profileUrl}`);
      await page.goto(profileUrl, { timeout: 25000, waitUntil: "domcontentloaded" });
      await settle(page, 4000);

      const loginWall = await page.$('input[autocomplete="username"]').then(Boolean).catch(() => false);
      if (loginWall) {
        await page.close();
        cb("⚠️ Login wall. Re-run: bun scripts/xLogin.ts");
        return { success: false, text: "Login wall detected." };
      }

      displayName = await page
        .$eval('[data-testid="UserName"] span', (el: any) => el.innerText.trim())
        .catch(() => handle);

      const bio = await page
        .$eval('[data-testid="UserDescription"]', (el: any) => el.innerText.trim())
        .catch(() => "");

      cb(`✅ Profile: ${displayName} (@${handle})\n📝 ${bio || "(no bio)"}`);

      // ── 1b. Extract jobs shown directly on X profile (Arbitrum-style) ──
      cb(`🔍 Checking for jobs shown directly on X profile...`);
      const xProfileJobs = await extractXProfileJobs(page, cb);
      if (xProfileJobs.length > 0) {
        cb(`🎯 Found ${xProfileJobs.length} jobs on X profile page itself — storing...`);
        const rows: JobRow[] = xProfileJobs.map((j) => ({
          ...j,
          company_name: displayName,
          company_x_handle: handle,
          company_website: "",
          source_url: profileUrl,
        }));
        const stored = await upsertJobs(rows);
        cb(`✅ Stored ${stored} X-profile jobs. Continuing to find more from website...`);
      }

      // ── 2. Get website link from X profile ────────────────────────────
      const websiteUrl: string =
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
          cb(`⚠️  No website link on @${handle}, but stored ${xProfileJobs.length} X-profile jobs.`);
          return { success: true, text: `Found ${xProfileJobs.length} jobs directly on @${handle}'s X profile.` };
        }
        cb(`❌ No website link found on @${handle}'s profile.`);
        return { success: false, text: `No website link on @${handle}.` };
      }

      cb(`🔗 Website: ${websiteUrl}`);

      // ── 3. Navigate to website ─────────────────────────────────────────
      cb(`🌐 Step 2 — Navigating to: ${websiteUrl}`);
      await page.goto(websiteUrl, { timeout: 20000, waitUntil: "domcontentloaded" });
      await settle(page);
      let currentUrl = page.url();
      cb(`   Landed: ${currentUrl}`);

      // ── 4. Resolve aggregator ──────────────────────────────────────────
      if (isAggregator(currentUrl)) {
        const officialSite = await resolveAggregator(page, currentUrl, cb);
        await page.goto(officialSite, { timeout: 20000, waitUntil: "domcontentloaded" });
        await settle(page);
        currentUrl = page.url();
        cb(`   Now on: ${currentUrl}`);
      }

      const officialWebsite = currentUrl;

      // ── 5. Find careers page ───────────────────────────────────────────
      cb(`🔍 Step 4 — Looking for careers page on ${new URL(officialWebsite).hostname}`);

      let careersUrl: string | null = null;
      if (isCareersUrl(officialWebsite)) {
        careersUrl = officialWebsite;
        cb(`   Already on careers page!`);
      } else {
        careersUrl = await findCareersLink(runtime, page, officialWebsite, cb);
      }

      if (!careersUrl) {
        await page.close();
        const summary = xProfileJobs.length > 0
          ? `No careers page found, but stored ${xProfileJobs.length} jobs from X profile.`
          : `No careers page found for ${displayName} at ${officialWebsite}.`;
        cb(`❌ ${summary}`);
        return { success: xProfileJobs.length > 0, text: summary };
      }

      cb(`✅ Careers page: ${careersUrl}`);

      // ── 6. Crawl careers page for individual job URLs ──────────────────
      cb(`📋 Step 5 — Crawling careers page for individual job URLs...`);
      await page.close(); // done with the navigation page

      const jobUrls = await crawlCareerListings(careersUrl!, cb);
      let careersPageJobs: JobRow[] = [];

      if (jobUrls.length > 0) {
        // ── 7. Extract structured details from each job URL ──────────────
        const BATCH_SIZE = 3;
        const MAX_DETAIL_PAGES = 20;
        const urlsToProcess = jobUrls.slice(0, MAX_DETAIL_PAGES);
        cb(`🔬 Step 6 — Extracting details from ${urlsToProcess.length} job pages (batches of ${BATCH_SIZE})...`);

        for (let i = 0; i < urlsToProcess.length; i += BATCH_SIZE) {
          const batch = urlsToProcess.slice(i, i + BATCH_SIZE);
          const results = await Promise.allSettled(
            batch.map((url) => extractJobDetail(runtime, url))
          );

          for (const result of results) {
            if (result.status === "fulfilled" && result.value) {
              const d = result.value;
              careersPageJobs.push({
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
              });
            }
          }
          cb(`  ✅ Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(urlsToProcess.length / BATCH_SIZE)}: ${careersPageJobs.length} jobs extracted so far`);
        }
      }

      // Fallback: if crawler found no individual job URLs, try single-page LLM extraction
      if (careersPageJobs.length === 0) {
        cb(`⚠️  No jobs from crawler — falling back to page-level LLM extraction...`);
        const fallbackPage = await createPage();
        const fallbackJobs = await extractJobsFromPage(runtime, fallbackPage, careersUrl!, cb);
        await fallbackPage.close();

        careersPageJobs = fallbackJobs.map((j) => ({
          title: j.title,
          description: j.description || "",
          link: j.link || careersUrl!,
          company_name: displayName,
          company_x_handle: handle,
          company_website: officialWebsite,
          source_url: careersUrl!,
        }));
      }

      const totalFound = xProfileJobs.length + careersPageJobs.length;

      if (careersPageJobs.length === 0) {
        const summary = xProfileJobs.length > 0
          ? `No additional jobs on careers page, but already stored ${xProfileJobs.length} from X profile.`
          : `Found careers page (${careersUrl}) but no jobs extracted.`;
        cb(`⚠️  ${summary}`);
        return { success: true, text: summary };
      }

      cb(`💾 Upserting ${careersPageJobs.length} jobs to DB...`);
      const stored = await upsertJobs(careersPageJobs);

      cb(`🎉 ${displayName} — ${totalFound} total jobs found, ${stored} new from careers page stored.`);
      return {
        success: true,
        text: `✅ ${displayName} (@${handle}): found ${totalFound} jobs total, ${stored} stored from careers page. Careers: ${careersUrl}`,
        data: { companyName: displayName, xHandle: handle, website: officialWebsite, careersUrl, jobsFound: totalFound, jobsStored: stored },
      };

    } catch (err: any) {
      await page.close().catch(() => { });
      cb(`❌ Pipeline failed: ${err.message}`);
      return { success: false, text: `Error: ${err.message}` };
    }
  },

  examples: [
    [
      { name: "user", content: { text: "Find jobs from https://x.com/arbitrum" } },
      { name: "agent", content: { text: "Starting job discovery for @arbitrum.", action: "SCRAPE_X_PROFILE" } },
    ],
    [
      { name: "user", content: { text: "https://x.com/Optimism find jobs" } },
      { name: "agent", content: { text: "On it — scraping @Optimism's profile.", action: "SCRAPE_X_PROFILE" } },
    ],
  ],
};