/**
 * SCRAPE_X_PROFILE
 *
 * Full navigation pipeline inside one action:
 * X profile → click website link → detect where we landed
 * → if link aggregator (linktr.ee etc.) find & click through to real site
 * → scan for careers/jobs link → navigate to it
 * → return careers page URL
 *
 * The "intelligence" is in the navigation logic here, not the LLM.
 */

import { type Action, type IAgentRuntime, ModelType } from "@elizaos/core";
import { type Page } from "playwright";
import { createPage } from "../services/browser.js";
import { upsertJobs, type JobRow } from "../services/supabase.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const LINK_AGGREGATOR_PATTERNS = [
  "linktr.ee", "bio.link", "beacons.ai",
  "lnk.bio", "campsite.bio", "taplink.cc", "allmylinks.com",
];

const SKIP_DOMAINS = [
  "twitter.com", "x.com", "instagram.com", "youtube.com",
  "discord.gg", "discord.com", "t.me", "telegram.me",
  "facebook.com", "tiktok.com", "medium.com", "docs.",
  "mirror.xyz", "substack.com", "warpcast.com",
];

const CAREERS_KEYWORDS = [
  "careers", "jobs", "hiring", "join us", "join the team",
  "open roles", "work with us", "opportunities", "work at us",
  "we're hiring", "positions", "vacancies",
];

const CAREERS_PATH_GUESSES = [
  "/careers", "/jobs", "/join", "/join-us",
  "/work-with-us", "/opportunities", "/hiring",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isAggregator(url: string): boolean {
  return LINK_AGGREGATOR_PATTERNS.some((p) => url.includes(p));
}

function isSkippable(url: string): boolean {
  return SKIP_DOMAINS.some((d) => url.includes(d));
}

function isCareersUrl(url: string): boolean {
  return CAREERS_KEYWORDS.some((k) => url.toLowerCase().includes(k));
}

async function waitAndSettle(page: Page, ms = 2500): Promise<void> {
  await page.waitForTimeout(ms);
}

// Get all visible external links from the current page
async function getExternalLinks(
  page: Page,
  currentDomain: string
): Promise<{ href: string; text: string }[]> {
  return page.$$eval(
    "a[href]",
    (els: any[], { domain, skip }: { domain: string; skip: string[] }) =>
      els
        .map((a) => ({ href: (a.href || "").trim(), text: (a.innerText || "").toLowerCase().trim() }))
        .filter(({ href }) => {
          if (!href.startsWith("http")) return false;
          if (skip.some((s) => href.includes(s))) return false;
          try {
            const h = new URL(href).hostname;
            return !h.includes(domain);
          } catch { return false; }
        }),
    { domain: currentDomain, skip: SKIP_DOMAINS }
  );
}

// Score a link for likelihood of being a careers page
function careersScore(href: string, text: string): number {
  let score = 0;
  for (const kw of CAREERS_KEYWORDS) {
    if (text.includes(kw)) score += 4;
    if (href.toLowerCase().includes(kw)) score += 3;
  }
  return score;
}

// Find the best careers link on the current page
async function findCareersLink(page: Page): Promise<string | null> {
  const currentDomain = new URL(page.url()).hostname.replace("www.", "");
  const links = await page.$$eval(
    "a[href]",
    (els: any[]) =>
      els.map((a) => ({ href: (a.href || "").trim(), text: (a.innerText || "").toLowerCase().trim() }))
  );

  let best: { href: string; score: number } | null = null;
  for (const { href, text } of links) {
    if (!href.startsWith("http")) continue;
    const score = careersScore(href, text);
    if (score > 0 && (!best || score > best.score)) best = { href, score };
  }

  if (best) return best.href;

  // Probe common paths
  const base = `https://${currentDomain}`;
  for (const p of CAREERS_PATH_GUESSES) {
    try {
      const resp = await page.goto(base + p, { timeout: 8000 });
      if (resp && resp.status() >= 200 && resp.status() < 400) return base + p;
    } catch { /* skip */ }
  }

  return null;
}

// Navigate through a link aggregator to find the official website
async function resolveAggregator(
  page: Page,
  aggregatorUrl: string,
  cb: (msg: string) => void
): Promise<string> {
  cb(`🌳 Link aggregator detected — opening ${aggregatorUrl}`);
  await page.goto(aggregatorUrl, { timeout: 15000, waitUntil: "domcontentloaded" });
  await waitAndSettle(page);

  const currentDomain = new URL(page.url()).hostname.replace("www.", "");
  const links = await getExternalLinks(page, currentDomain);

  cb(`   Found ${links.length} external links on aggregator page`);

  // Prefer links that look like official websites (not socials, not more aggregators)
  const official = links.find(
    ({ href }) => !isAggregator(href) && !isSkippable(href)
  );

  if (official) {
    cb(`✅ Official website found: ${official.href}`);
    return official.href;
  }

  cb(`⚠️  Could not find official website from aggregator, using aggregator URL`);
  return aggregatorUrl;
}

// ─── Job extraction ───────────────────────────────────────────────────────────

async function extractAndStoreJobs(
  runtime: IAgentRuntime,
  page: Page,
  careersUrl: string,
  companyName: string,
  xHandle: string,
  companyWebsite: string,
  cb: (msg: string) => void
): Promise<{ found: number; stored: number }> {
  try {
    await page.goto(careersUrl, { timeout: 15000, waitUntil: "domcontentloaded" });
    await waitAndSettle(page);

    const bodyText = await page.innerText("body").catch(() => "");
    const title = await page.title().catch(() => "");

    cb(`📄 Page loaded (${bodyText.length} chars). Asking LLM to extract jobs...`);

    const prompt = `You are extracting job listings from a careers page.
Return ONLY a JSON array. No markdown. No explanation.
Each item: {"title":"...","description":"...","link":"..."}
Empty array [] if no jobs found.

URL: ${careersUrl}
Page title: ${title}
Content (first 5000 chars):
${bodyText.slice(0, 5000)}`;

    const response = (await runtime.useModel(ModelType.TEXT_LARGE, { prompt })) as string;

    let jobs: { title: string; description?: string; link?: string }[] = [];
    const match = response.match(/\[[\s\S]*?\]/);
    if (match) {
      try { jobs = JSON.parse(match[0]); } catch { /* bad JSON */ }
    }

    if (jobs.length === 0) return { found: 0, stored: 0 };

    const rows: JobRow[] = jobs.map((j) => ({
      title: j.title,
      description: j.description || "",
      link: j.link || careersUrl,
      company_name: companyName,
      company_x_handle: xHandle,
      company_website: companyWebsite,
      source_url: careersUrl,
    }));

    const stored = await upsertJobs(rows);
    return { found: jobs.length, stored };
  } catch (err: any) {
    cb(`⚠️  Job extraction error: ${err.message}`);
    return { found: 0, stored: 0 };
  }
}

// ─── Main Action ──────────────────────────────────────────────────────────────

export const scrapeXProfile: Action = {
  name: "SCRAPE_X_PROFILE",
  similes: [
    "FIND_JOBS", "DISCOVER_JOBS", "CHECK_X_PROFILE",
    "FIND_COMPANY_JOBS", "GET_JOBS_FROM_X",
  ],
  description:
    "Given an X profile URL, navigates to their website (handling linktr.ee and redirects), finds the careers page, extracts job listings, and stores them.",

  validate: async (_runtime, message) => {
    const text = message.content?.text || "";
    return text.includes("x.com/") || text.includes("twitter.com/");
  },

  handler: async (runtime, message, _state, _options, callback) => {
    const cb = (msg: string) => callback?.({ text: msg });
    const text = message.content?.text || "";

    const urlMatch = text.match(/https?:\/\/(x\.com|twitter\.com)\/([A-Za-z0-9_]+)/);
    if (!urlMatch) {
      cb("Please provide a valid X profile URL (e.g. https://x.com/monad).");
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
      await waitAndSettle(page, 4000);

      // Login wall check
      const loginWall = await page.$('input[autocomplete="username"]').then(Boolean).catch(() => false);
      if (loginWall) {
        await page.close();
        cb("⚠️ X is showing a login wall. Re-run: bun scripts/xLogin.ts");
        return { success: false, text: "Login wall detected." };
      }

      // Extract display name
      displayName = await page
        .$eval('[data-testid="UserName"] span', (el: any) => el.innerText.trim())
        .catch(() => handle);

      // Extract bio
      const bio = await page
        .$eval('[data-testid="UserDescription"]', (el: any) => el.innerText.trim())
        .catch(() => "");

      cb(`✅ Profile loaded: ${displayName} (@${handle})\n📝 ${bio || "(no bio)"}`);

      // ── 2. Get the website link from profile ───────────────────────────
      // X shows: Name / Handle / Bio / Location | Website | Joined
      // The website field has data-testid="UserUrl"

      let websiteUrl = "";

      // Primary: dedicated website field
      websiteUrl = await page
        .$eval('[data-testid="UserUrl"] a', (el: any) => el.href)
        .catch(() => "");

      // Fallback A: any t.co link in the profile header area
      if (!websiteUrl) {
        const headerLinks: string[] = await page.$$eval(
          '[data-testid="UserProfileHeader_Items"] a[href]',
          (els: any[]) => els.map((a) => a.href)
        ).catch(() => []);
        websiteUrl = headerLinks.find((l) => !l.includes("x.com") && !l.includes("twitter.com")) || "";
      }

      // Fallback B: any t.co link anywhere in the profile card
      if (!websiteUrl) {
        const allTco: string[] = await page.$$eval(
          'a[href*="t.co"]',
          (els: any[]) => els.map((a) => a.href)
        ).catch(() => []);
        websiteUrl = allTco[0] || "";
      }

      if (!websiteUrl) {
        await page.close();
        cb(`❌ No website link found on @${handle}'s profile.`);
        return { success: false, text: `No website link on @${handle}.` };
      }

      cb(`🔗 Website link found: ${websiteUrl}`);

      // ── 3. Navigate to the link ────────────────────────────────────────
      cb(`🌐 Step 2 — Navigating to: ${websiteUrl}`);
      await page.goto(websiteUrl, { timeout: 20000, waitUntil: "domcontentloaded" });
      await waitAndSettle(page);

      let currentUrl = page.url();
      cb(`   Landed on: ${currentUrl}`);

      // ── 4. Detect & resolve link aggregator ───────────────────────────
      if (isAggregator(currentUrl)) {
        const officialSite = await resolveAggregator(page, currentUrl, cb);
        cb(`🌐 Step 3 — Navigating to official site: ${officialSite}`);
        await page.goto(officialSite, { timeout: 20000, waitUntil: "domcontentloaded" });
        await waitAndSettle(page);
        currentUrl = page.url();
        cb(`   Now on: ${currentUrl}`);
      }

      const officialWebsite = currentUrl;

      // ── 5. Find careers page ───────────────────────────────────────────
      cb(`🔍 Step 4 — Searching for careers page on ${new URL(officialWebsite).hostname}`);

      // First check if we're already on a careers page
      let careersUrl: string | null = null;
      if (isCareersUrl(officialWebsite)) {
        careersUrl = officialWebsite;
        cb(`   Already on careers page!`);
      } else {
        careersUrl = await findCareersLink(page);
      }

      if (!careersUrl) {
        await page.close();
        cb(`❌ No careers page found on ${officialWebsite}.`);
        return {
          success: false,
          text: `Could not find a careers page for ${displayName} at ${officialWebsite}.`,
        };
      }

      cb(`✅ Careers page found: ${careersUrl}`);

      // ── 6. Extract & store jobs ────────────────────────────────────────
      cb(`📋 Step 5 — Extracting job listings...`);
      const { found, stored } = await extractAndStoreJobs(
        runtime, page, careersUrl, displayName, handle, officialWebsite, cb
      );

      await page.close();

      if (found === 0) {
        cb(`⚠️  Careers page found but no job listings extracted from ${careersUrl}.`);
        return {
          success: true,
          text: `Found careers page for ${displayName} (${careersUrl}) but no job listings extracted.`,
        };
      }

      cb(`🎉 Done! ${displayName} — ${found} jobs found, ${stored} new stored in database.`);
      return {
        success: true,
        text: `✅ Job discovery complete for ${displayName} (@${handle}). Found ${found} jobs, stored ${stored}. Careers: ${careersUrl}`,
        data: { companyName: displayName, xHandle: handle, website: officialWebsite, careersUrl, jobsFound: found, jobsStored: stored },
      };

    } catch (err: any) {
      await page.close().catch(() => { });
      cb(`❌ Pipeline failed: ${err.message}`);
      return { success: false, text: `Error: ${err.message}` };
    }
  },

  examples: [
    [
      { name: "user", content: { text: "Find jobs from https://x.com/monad" } },
      {
        name: "agent",
        content: {
          text: "Starting job discovery for @monad — navigating their X profile to find the website and careers page.",
          action: "SCRAPE_X_PROFILE",
        },
      },
    ],
    [
      { name: "user", content: { text: "https://x.com/solana find jobs" } },
      {
        name: "agent",
        content: {
          text: "On it — scraping @solana's profile to find job listings.",
          action: "SCRAPE_X_PROFILE",
        },
      },
    ],
  ],
};