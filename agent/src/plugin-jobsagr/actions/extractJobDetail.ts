/**
 * extractJobDetail.ts
 *
 * Given a job detail page URL:
 * 1. Scrape page text
 * 2. Validate it looks like a job posting
 * 3. LLM → extract title, summary, description, category
 * 4. Detect degenerate model output (repetitive loops)
 * 5. Fallback to URL-based title if LLM fails
 * 6. Return structured JobDetail
 *
 * Category taxonomy mirrors Circle careers page + web3 roles.
 */

import { type IAgentRuntime, ModelType } from "@elizaos/core";
import { createPage } from "../services/browser.js";
import crypto from "crypto";

// ─── Category Taxonomy ────────────────────────────────────────────────────────

export const JOB_CATEGORIES = [
    "Engineering",
    "Product",
    "Design",
    "Data & AI",
    "Security",
    "DevRel & Developer Education",
    "Business & Sales",
    "Marketing & Growth",
    "Finance",
    "Legal & Compliance",
    "People & Workplace",
    "Operations & Program Management",
    "Customer Success & Support",
    "Tech Ops & IT",
    "Research",
    "Other",
] as const;

export type JobCategory = (typeof JOB_CATEGORIES)[number];

export interface JobDetail {
    title: string;
    summary: string;           // ≤2 sentences, LLM-generated
    category: JobCategory;
    description: string;       // LLM-extracted or first ~300 chars of page text
    apply_url: string;
    content_hash: string;      // sha256 of raw page text — dedup key
    canonical_url: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Computes the SHA-256 hash of a given text.
 * @param {string} text - The input text.
 * @returns {string} The computed hexadecimal hash.
 */
function sha256(text: string): string {
    return crypto.createHash("sha256").update(text).digest("hex");
}

/**
 * Canonicalizes a URL by removing common tracking parameters and trailing slashes, and converting to lowercase.
 * @param {string} url - The URL to canonicalize.
 * @returns {string} The canonicalized URL string.
 */
function canonicalize(url: string): string {
    try {
        const u = new URL(url);
        for (const p of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref", "source", "gh_src"]) {
            u.searchParams.delete(p);
        }
        return (u.origin + u.pathname + (u.search || "")).replace(/\/$/, "").toLowerCase();
    } catch {
        return url.toLowerCase();
    }
}

/**
 * Detects degenerate LLM output, such as repetitive token loops.
 * @param {string} text - The LLM generated text.
 * @returns {boolean} True if the text indicates a degenerate repetitive loop, false otherwise.
 */
function isDegenerate(text: string): boolean {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const freq: Record<string, number> = {};
    for (const line of lines) {
        freq[line] = (freq[line] || 0) + 1;
        if (freq[line] > 5) return true;
    }
    if (text.length > 500) {
        const sample = text.slice(0, 80);
        const count = text.split(sample).length - 1;
        if (count > 3) return true;
    }
    return false;
}

// Heuristic looksLikeJobPage removed to allow LLM to make the decision

/**
 * Extracts a readable title from a URL slug as a fallback mechanism.
 * @param {string} url - The URL to extract the title from.
 * @returns {string | null} The formatted title string, or null if unextractable.
 */
function titleFromUrl(url: string): string | null {
    try {
        const path = new URL(url).pathname;
        const slug = path.split("/").filter(Boolean).pop() || "";
        const cleaned = slug.replace(/^\d+-/, "").replace(/-/g, " ").trim();
        if (cleaned.length > 3 && cleaned.length < 120) {
            return cleaned.split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
        }
    } catch { /* ignore */ }
    return null;
}

/**
 * Finds the first balanced { ... } JSON block in a given text string.
 * @param {string} text - The text to search within.
 * @returns {string | null} The extracted JSON string, or null if no balanced block is found.
 */
function findBalancedJson(text: string): string | null {
    const start = text.indexOf("{");
    if (start === -1) return null;
    let depth = 0;
    for (let i = start; i < text.length; i++) {
        if (text[i] === "{") depth++;
        if (text[i] === "}") depth--;
        if (depth === 0) return text.slice(start, i + 1);
    }
    return null;
}

// ─── LLM extraction ───────────────────────────────────────────────────────────

/**
 * Uses an LLM to extract structured job details (title, summary, description, category) from page text.
 * 
 * @param {IAgentRuntime} runtime - The agent runtime containing the LLM model.
 * @param {string} pageText - The scraped text from the job detail page.
 * @param {string} url - The URL of the job posting (used as context).
 * @returns {Promise<{ title: string; summary: string; description: string; category: JobCategory }>} The extracted details.
 */
async function llmExtract(
    runtime: IAgentRuntime,
    pageText: string,
    url: string
): Promise<{ title: string; summary: string; description: string; category: JobCategory }> {
    // Shorter input for small models
    const inputText = pageText.slice(0, 2000);

    const prompt = `Extract job info from this posting. Return ONLY valid JSON, nothing else.

{"title": "JOB TITLE", "summary": "1-2 sentence summary max 150 chars", "description": "Extract the core requirements, responsibilities, and role overview. Max 1000 chars", "category": "CATEGORY"}

Categories: ${JOB_CATEGORIES.join(", ")}

CRITICAL: If the text does NOT describe a specific job role (e.g., it is just a plain application form, a login page, or generic text without responsibilities), return: 
{"title": "NOT_A_JOB", "summary": "", "description": "", "category": "Other"}

URL: ${url}
Text:
${inputText}`;

    const raw = (await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt,
        temperature: 0.1,
        maxTokens: 1500,
    })) as string;

    // Detect degenerate output early
    if (isDegenerate(raw)) {
        console.warn(`⚠️ Degenerate LLM output for ${url}, skipping`);
        throw new Error("Degenerate LLM output (repetitive loop)");
    }

    // Strip <think>...</think> (greedy)
    let cleaned = raw.replace(/<think>[\s\S]*<\/think>/gi, "").trim();
    if (cleaned.length < 5) cleaned = raw;

    // Try fenced JSON block
    let jsonStr: string | null = null;
    const fencedMatch = cleaned.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (fencedMatch) jsonStr = fencedMatch[1];

    // Try balanced braces from cleaned output
    if (!jsonStr) jsonStr = findBalancedJson(cleaned);

    // Fallback: try raw output
    if (!jsonStr) jsonStr = findBalancedJson(raw);

    if (!jsonStr) {
        console.error(`LLM returned no JSON for ${url}. Preview: ${raw.slice(0, 300)}`);
        throw new Error("LLM returned no JSON");
    }

    const parsed = JSON.parse(jsonStr);

    // Validate parsed output
    const title = (parsed.title || "").trim();
    if (!title || title.length < 2 || title.length > 200) {
        throw new Error(`Invalid title: "${title.slice(0, 50)}"`);
    }

    return {
        title,
        summary: (parsed.summary || "").slice(0, 300).trim(),
        description: (parsed.description || "").slice(0, 1500).trim(),
        category: JOB_CATEGORIES.includes(parsed.category) ? parsed.category : "Other",
    };
}

// ─── Main extractor ───────────────────────────────────────────────────────────

/**
 * Primary action to process a job URL. Extracts and structures its details into a `JobDetail` object.
 * 
 * @param {IAgentRuntime} runtime - The agent runtime instance.
 * @param {string} rawUrl - The job detail page URL to process.
 * @returns {Promise<JobDetail | null>} Valid JobDetail object, or null if extraction fails or it's not a job.
 */
export async function extractJobDetail(
    runtime: IAgentRuntime,
    rawUrl: string
): Promise<JobDetail | null> {
    const canonical = canonicalize(rawUrl);
    let page;

    try {
        page = await createPage();
        await page.goto(rawUrl, { timeout: 30000, waitUntil: "domcontentloaded" });
        await page.waitForTimeout(2000);

        const pageText = await page.innerText("body").catch(() => "");
        await page.close();

        if (pageText.length < 100) return null;

        const hash = sha256(pageText);

        // Let the LLM decide if this is actually a job description

        const { title, summary, description, category } = await llmExtract(runtime, pageText, rawUrl);

        if (title === "NOT_A_JOB") return null;

        return {
            title,
            summary,
            category,
            description: description || pageText.slice(0, 300).replace(/\s+/g, " ").trim(),
            apply_url: rawUrl,
            content_hash: hash,
            canonical_url: canonical,
        };
    } catch (err: any) {
        await page?.close().catch(() => { });

        // Fallback: if LLM failed but URL has a readable slug, use it
        const urlTitle = titleFromUrl(rawUrl);
        if (urlTitle) {
            console.warn(`⚠️ LLM failed for ${rawUrl}, using URL title: "${urlTitle}"`);
            return {
                title: urlTitle,
                summary: "",
                category: "Other",
                description: "",
                apply_url: rawUrl,
                content_hash: sha256(rawUrl),
                canonical_url: canonical,
            };
        }

        console.error(`extractJobDetail failed for ${rawUrl}: ${err.message}`);
        return null;
    }
}