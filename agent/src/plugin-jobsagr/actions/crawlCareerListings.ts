/**
 * crawlCareerListings.ts
 *
 * BFS crawler: start at careers URL → discover all individual job detail URLs.
 *
 * Handles:
 *  - Pagination (next page buttons / numbered pages)
 *  - "Load more" / "Show more" buttons
 *  - Infinite scroll (scroll + detect new cards)
 *  - ATS domains (Greenhouse, Lever, Ashby, Workable, etc.)
 *  - Gateway CTAs ("View open roles", "See all positions", etc.)
 *  - Multi-hop navigation (BFS depth ≤ 4, max 25 pages / company)
 *
 * Returns: deduplicated list of job detail page URLs (canonical).
 */

import { type Page } from "playwright";
import { createPage } from "../services/browser.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const MAX_DEPTH = 4;
const MAX_PAGES = 25;
const SETTLE_MS = 2200;

const ATS_DOMAINS = [
    "lever.co", "greenhouse.io", "ashbyhq.com", "workable.com",
    "workday.com", "smartrecruiters.com", "breezy.hr", "recruitee.com",
    "jobvite.com", "icims.com", "taleo.net", "bamboohr.com",
    "jobs.ashbyhq.com", "apply.workable.com", "boards.greenhouse.io",
    "jobs.lever.co", "careers.smartrecruiters.com",
];

const LISTING_POSITIVE_KWS = [
    "careers", "jobs", "hiring", "open roles", "openings",
    "positions", "opportunities", "join", "apply",
];

const LISTING_NEGATIVE_KWS = [
    "blog", "press", "news", "about", "team", "culture", "benefits",
    "investor", "docs", "help", "support", "privacy", "terms",
    "twitter", "x.com", "linkedin", "github", "discord", "youtube",
    "instagram", "facebook", "tiktok", "medium",
    "cookie", "legal", "security", "vulnerability", "powered",
    "imprint", "disclaimer", "contact", "accessibility",
    "sitemap", "subscribe", "newsletter", "login", "sign-in", "signup",
];

/** Link text that is NEVER a job title — boilerplate / footer / nav */
const JUNK_LINK_TEXT = [
    "privacy policy", "privacy", "terms of service", "terms of use", "terms",
    "cookie policy", "cookies", "security", "vulnerability disclosure",
    "powered by", "powered by ashby", "imprint", "legal",
    "contact us", "contact", "accessibility", "sitemap",
    "log in", "sign in", "sign up", "register",
    "home", "back to top", "go back", "return",
    "twitter", "linkedin", "github", "discord", "facebook",
    "blog", "press", "news", "about us", "about",
    "subscribe", "newsletter",
];

const GATEWAY_CTA_TEXT = [
    "open roles", "view roles", "see roles", "current openings",
    "all positions", "see positions", "view positions", "see jobs",
    "view jobs", "explore jobs", "search jobs", "search results",
    "join us", "apply now", "see opportunities", "view opportunities",
    "explore opportunities", "get started",
];

const PAGINATION_TEXT = [
    "next", "next page", "›", "»", "load more", "show more",
    "see more", "view more", "more jobs", "more results",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalizes a URL by resolving it against a base URL, removing tracking parameters, fragments, and trailing slashes.
 * @param {string} raw - The raw URL string to normalize.
 * @param {string} base - The base URL to resolve relative paths against.
 * @returns {string | null} The normalized URL, or null if it's invalid or not HTTP(S).
 */
function normalizeUrl(raw: string, base: string): string | null {
    try {
        const u = new URL(raw, base);
        if (!["http:", "https:"].includes(u.protocol)) return null;
        // Remove fragments and tracking params
        u.hash = "";
        for (const p of ["utm_source", "utm_medium", "utm_campaign", "ref", "source"]) {
            u.searchParams.delete(p);
        }
        let clean = u.href.replace(/\/$/, "");
        // Strip common "apply" suffixes so we get the JD instead of just the application form
        clean = clean.replace(/\/(application|apply|apply-now|apply-for-this-job)$/i, "");
        return clean;
    } catch {
        return null;
    }
}

/**
 * Checks if a given URL belongs to either the company's domain or a known ATS domain.
 * @param {string} url - The URL to check.
 * @param {string} companyDomain - The base domain of the company.
 * @returns {boolean} True if the URL is allowed, false otherwise.
 */
function isAllowedDomain(url: string, companyDomain: string): boolean {
    try {
        const host = new URL(url).hostname.replace(/^www\./, "");
        const isCompanyDomain = host === companyDomain || host.endsWith("." + companyDomain);
        const isATS = ATS_DOMAINS.some((d) => host === d || host.endsWith("." + d));
        return isCompanyDomain || isATS;
    } catch {
        return false;
    }
}

/**
 * Calculates a relevance score for a link based on its URL and text matching positive/negative string keywords.
 * @param {string} href - The link's URL.
 * @param {string} text - The link's visible text.
 * @returns {number} The calculated integer score.
 */
function linkScore(href: string, text: string): number {
    const h = href.toLowerCase();
    const t = text.toLowerCase();
    let score = 0;
    for (const kw of LISTING_POSITIVE_KWS) {
        if (h.includes(kw)) score += 2;
        if (t.includes(kw)) score += 1;
    }
    for (const kw of LISTING_NEGATIVE_KWS) {
        if (h.includes(kw)) score -= 3;
        if (t.includes(kw)) score -= 2;
    }
    return score;
}

/**
 * Checks if a URL matches the pattern of an individual job detail page (not a listing index).
 * @param {string} url - The URL to evaluate.
 * @returns {boolean} True if the URL is likely a job detail page, false otherwise.
 */
function looksLikeJobDetail(url: string): boolean {
    const u = url.toLowerCase();

    // Explicitly reject known non-job URL patterns
    const nonJobPatterns = [
        "/privacy", "/terms", "/security", "/vulnerability",
        "/cookie", "/legal", "/imprint", "/contact",
        "/login", "/signin", "/signup", "/register",
        "/application",  // Ashby application form, not a listing
        "/powered",
        "/about", "/blog", "/press", "/news",
    ];
    for (const pattern of nonJobPatterns) {
        if (u.includes(pattern)) return false;
    }

    // ATS patterns for detail pages
    if (/\/jobs\/[a-z0-9\-]+\/?\??/i.test(u)) return true;       // Lever, custom
    if (/\/o\/[a-z0-9\-]+/i.test(u)) return true;                // Greenhouse
    if (/\/postings\/[a-z0-9\-]+/i.test(u)) return true;         // Ashby (old)
    if (/\/en\/search-results\/.+/i.test(u)) return true;         // Workday
    if (/\/job\/[a-z0-9\-]+/i.test(u)) return true;
    if (/\/position\/[a-z0-9\-]+/i.test(u)) return true;
    if (/\/opening\/[a-z0-9\-]+/i.test(u)) return true;
    
    // UUID in path, usually Ashby or similar ATS: /company/b877f336-7f38-4c31-a4b8-97abcf1e0c30
    if (/\/[a-z0-9\.\-]+\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i.test(u)) return true;
    
    // Has a UUID or slug segment after /jobs/ or /careers/ (Ashby format)
    if (/\/(jobs|careers|positions|openings)\/[a-f0-9\-]{8,}/i.test(u)) return true;
    return false;
}

/**
 * Determines if a link is a footer, boilerplate, or otherwise non-job link to be discarded.
 * @param {string} href - The URL of the link.
 * @param {string} text - The visible text of the link.
 * @returns {boolean} True if the link is considered junk, false otherwise.
 */
function isJunkLink(href: string, text: string): boolean {
    const t = text.toLowerCase().trim();
    const u = href.toLowerCase();

    // Exact match or starts-with on known junk text
    if (JUNK_LINK_TEXT.some((junk) => t === junk || t.startsWith(junk + " "))) return true;

    // Very short link text that's not a job title (1-2 words, generic)
    if (t.length > 0 && t.length < 4 && !/\d/.test(t)) return true;

    // URL contains obvious non-job paths
    const junkPaths = [
        "/privacy", "/terms", "/security", "/vulnerability",
        "/cookie", "/legal", "/imprint", "/contact",
        "/login", "/signin", "/signup",
    ];
    if (junkPaths.some((p) => u.includes(p))) return true;

    return false;
}

/**
 * Checks if a URL looks like a careers listing or gateway page based on URL keywords.
 * @param {string} url - The URL to check.
 * @returns {boolean} True if it looks like a listing page, false otherwise.
 */
function looksLikeListingPage(url: string): boolean {
    return LISTING_POSITIVE_KWS.some((kw) => url.toLowerCase().includes(kw));
}

// ─── Page interactions ────────────────────────────────────────────────────────

/**
 * Scrolls to the bottom of the page to detect dynamically loaded new content.
 * @param {Page} page - The Playwright Page instance.
 * @returns {Promise<boolean>} True if new links were detected after scrolling, false otherwise.
 */
async function scrollAndDetectMore(page: Page): Promise<boolean> {
    const before = await page.$$eval("a[href]", (els: any[]) => els.length).catch(() => 0);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1800);
    const after = await page.$$eval("a[href]", (els: any[]) => els.length).catch(() => 0);
    return after > before;
}

/**
 * Attempts to click "Load more" or "Show more" pagination buttons.
 * @param {Page} page - The Playwright Page instance.
 * @returns {Promise<boolean>} True if a button was clicked successfully, false otherwise.
 */
async function clickLoadMore(page: Page): Promise<boolean> {
    const buttons = await page.$$("button, a, [role='button']").catch(() => []);
    for (const btn of buttons) {
        const text = ((await btn.innerText().catch(() => "")) || "").toLowerCase().trim();
        if (PAGINATION_TEXT.some((p) => text === p || text.startsWith(p))) {
            try {
                await btn.click();
                await page.waitForTimeout(SETTLE_MS);
                return true;
            } catch { /* element gone */ }
        }
    }
    return false;
}

/**
 * Clicks a gateway call-to-action (CTA) to reach actual job listings (e.g. "View open roles").
 * @param {Page} page - The Playwright Page instance.
 * @param {string} baseUrl - The base URL of the current page.
 * @returns {Promise<string | null>} The new URL if navigated successfully, or null if no CTA was found/clicked.
 */
async function clickGatewayCTA(page: Page, baseUrl: string): Promise<string | null> {
    const links = await page.$$eval("a[href], button", (els: any[]) =>
        els.map((el) => ({
            href: (el.href || "").trim(),
            text: (el.innerText || "").toLowerCase().trim(),
        }))
    ).catch(() => [] as { href: string; text: string }[]);

    // Score CTA candidates
    let best: { href: string; text: string; score: number } | null = null;
    for (const { href, text } of links) {
        let score = 0;
        for (const cta of GATEWAY_CTA_TEXT) {
            if (text.includes(cta)) score += 4;
        }
        for (const kw of LISTING_POSITIVE_KWS) {
            if (href.toLowerCase().includes(kw)) score += 2;
        }
        if (score > 0 && (!best || score > best.score)) best = { href, text, score };
    }

    if (!best || !best.href || !best.href.startsWith("http")) return null;

    try {
        await page.goto(best.href, { timeout: 15000, waitUntil: "domcontentloaded" });
        await page.waitForTimeout(SETTLE_MS);
        return page.url();
    } catch {
        return null;
    }
}

/**
 * Extracts, normalizes, and filters all href links from the current page.
 * Filtered links are scored to evaluate their relevance.
 * @param {Page} page - The Playwright Page instance.
 * @param {string} companyDomain - The base domain string of the company.
 * @param {Set<string>} visited - Set of previously visited normalized URLs.
 * @returns {Promise<{href: string, text: string, score: number}[]>} Array of extracted and scored links.
 */
async function extractLinks(
    page: Page,
    companyDomain: string,
    visited: Set<string>
): Promise<{ href: string; text: string; score: number }[]> {
    const raw = await page.$$eval("a[href]", (els: any[]) =>
        els.map((a) => ({
            href: (a.href || "").trim(),
            text: (a.innerText || "").replace(/\s+/g, " ").trim().slice(0, 100),
        }))
    ).catch(() => [] as { href: string; text: string }[]);

    const results: { href: string; text: string; score: number }[] = [];
    const base = page.url();

    for (const { href, text } of raw) {
        const norm = normalizeUrl(href, base);
        if (!norm) continue;
        if (visited.has(norm)) continue;
        if (!isAllowedDomain(norm, companyDomain)) continue;
        // Filter out footer/boilerplate links
        if (isJunkLink(norm, text)) continue;
        const score = linkScore(norm, text);
        if (score < -2) continue; // clearly negative
        results.push({ href: norm, text, score });
    }

    return results;
}

// ─── Main BFS crawler ─────────────────────────────────────────────────────────

/**
 * Executes a Breadth-First Search (BFS) crawl starting at the careers URL to discover individual job details.
 * 
 * @param {string} careersUrl - The starting careers page URL.
 * @param {function} cb - Callback string for sending status updates.
 * @returns {Promise<string[]>} Array of discovered canonical job detail URLs.
 */
export async function crawlCareerListings(
    careersUrl: string,
    cb: (msg: string) => void
): Promise<string[]> {
    const companyDomain = (() => {
        try { return new URL(careersUrl).hostname.replace(/^www\./, ""); } catch { return ""; }
    })();

    const visited = new Set<string>();
    const jobDetailUrls = new Set<string>();

    // BFS queue: { url, depth }
    const queue: { url: string; depth: number }[] = [{ url: careersUrl, depth: 0 }];
    let pagesVisited = 0;
    let page: Page | null = null;

    try {
        page = await createPage();

        while (queue.length > 0 && pagesVisited < MAX_PAGES) {
            const { url, depth } = queue.shift()!;
            const normUrl = normalizeUrl(url, url) || url;
            if (visited.has(normUrl)) continue;
            visited.add(normUrl);
            pagesVisited++;

            // If it already looks like a job detail, add directly without visiting
            if (depth > 0 && looksLikeJobDetail(url)) {
                jobDetailUrls.add(url);
                continue;
            }

            console.log(`🔍 [depth=${depth}] Visiting: ${url}`);

            try {
                await page.goto(url, { timeout: 18000, waitUntil: "domcontentloaded" });
                await page.waitForTimeout(SETTLE_MS);
            } catch (e: any) {
                console.log(`  ⚠️  Failed to load: ${e.message}`);
                continue;
            }

            // Gateway CTA: if no jobs visible yet, try clicking a CTA
            if (depth === 0) {
                const links0 = await extractLinks(page, companyDomain, visited);
                const detailLinksCount = links0.filter((l) => looksLikeJobDetail(l.href)).length;
                if (detailLinksCount === 0) {
                    console.log(`  🚪 No job links visible — trying gateway CTA...`);
                    const newUrl = await clickGatewayCTA(page, url);
                    if (newUrl && newUrl !== url) {
                        console.log(`  ✅ Gateway CTA navigated to: ${newUrl}`);
                        const norm = normalizeUrl(newUrl, newUrl) || newUrl;
                        if (!visited.has(norm)) queue.unshift({ url: newUrl, depth: 1 });
                        continue;
                    }
                }
            }

            // Interact: load-more / infinite scroll
            let attempts = 0;
            while (attempts < 5) {
                const clicked = await clickLoadMore(page);
                if (!clicked) {
                    const scrolled = await scrollAndDetectMore(page);
                    if (!scrolled) break;
                }
                attempts++;
                console.log(`  📜 Load-more interaction #${attempts}`);
            }

            // Extract all links from current page
            const links = await extractLinks(page, companyDomain, visited);
            console.log(`  🔗 Found ${links.length} candidate links`);

            for (const { href, score } of links) {
                if (looksLikeJobDetail(href)) {
                    jobDetailUrls.add(href);
                    console.log(`  💼 Job detail: ${href}`);
                } else if (depth < MAX_DEPTH && (looksLikeListingPage(href) || score > 0)) {
                    queue.push({ url: href, depth: depth + 1 });
                }
            }

            // Pagination: look for "Next page" links
            const paginationLinks = links.filter(({ text }) =>
                PAGINATION_TEXT.some((p) => text.toLowerCase().includes(p))
            );
            for (const { href } of paginationLinks) {
                const norm = normalizeUrl(href, href) || href;
                if (!visited.has(norm)) {
                    console.log(`  ➡️  Pagination link: ${href}`);
                    queue.unshift({ url: href, depth: depth }); // same depth
                }
            }
        }

        await page.close();

        cb(`✅ Crawl done. Pages visited: ${pagesVisited}. Job URLs found: ${jobDetailUrls.size}`);
        return Array.from(jobDetailUrls);

    } catch (err: any) {
        await page?.close().catch(() => { });
        cb(`❌ Crawler error: ${err.message}`);
        return Array.from(jobDetailUrls);
    }
}