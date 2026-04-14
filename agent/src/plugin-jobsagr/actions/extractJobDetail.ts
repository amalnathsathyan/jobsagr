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

function sha256(text: string): string {
    return crypto.createHash("sha256").update(text).digest("hex");
}

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

/** Detect degenerate LLM output (repetitive token loops) */
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

/** Quick heuristic: does this page text look like a job posting? */
function looksLikeJobPage(text: string): boolean {
    const lower = text.toLowerCase();
    const jobSignals = [
        "apply", "responsibilities", "requirements", "qualifications",
        "experience", "salary", "role", "position", "about the",
        "what you'll do", "who you are", "what we're looking for",
        "job description", "full-time", "part-time", "remote", "hybrid",
        "compensation", "benefits", "we are looking", "you will",
    ];
    const matchCount = jobSignals.filter((s) => lower.includes(s)).length;
    return matchCount >= 2;
}

/** Extract a readable title from a URL slug as fallback */
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

/** Find first balanced { ... } block in text */
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

async function llmExtract(
    runtime: IAgentRuntime,
    pageText: string,
    url: string
): Promise<{ title: string; summary: string; description: string; category: JobCategory }> {
    // Shorter input for small models
    const inputText = pageText.slice(0, 2000);

    const prompt = `Extract job info from this posting. Return ONLY valid JSON, nothing else.

{"title": "JOB TITLE", "summary": "1-2 sentence summary max 200 chars", "description": "2-3 sentences about role max 400 chars", "category": "CATEGORY"}

Valid categories: ${JOB_CATEGORIES.join(", ")}

If NOT a job posting, return: {"title": "NOT_A_JOB", "summary": "", "description": "", "category": "Other"}

URL: ${url}
Text:
${inputText}`;

    const raw = (await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt,
        temperature: 0.1,
        maxTokens: 500,
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
        summary: (parsed.summary || "").slice(0, 200).trim(),
        description: (parsed.description || "").slice(0, 500).trim(),
        category: JOB_CATEGORIES.includes(parsed.category) ? parsed.category : "Other",
    };
}

// ─── Main extractor ───────────────────────────────────────────────────────────

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

        // Validate: does this page look like a job posting?
        if (!looksLikeJobPage(pageText)) {
            console.warn(`⚠️ Skipping non-job page: ${rawUrl}`);
            // Still try URL-based title
            const urlTitle = titleFromUrl(rawUrl);
            if (urlTitle) {
                return {
                    title: urlTitle,
                    summary: "",
                    category: "Other",
                    description: pageText.slice(0, 300).replace(/\s+/g, " ").trim(),
                    apply_url: rawUrl,
                    content_hash: hash,
                    canonical_url: canonical,
                };
            }
            return null;
        }

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