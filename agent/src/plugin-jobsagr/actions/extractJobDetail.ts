/**
 * extractJobDetail.ts
 *
 * Given a job detail page URL:
 * 1. Scrape page text
 * 2. LLM → extract title, summary (≤2 sentences), category
 * 3. Return structured JobDetail
 *
 * Category taxonomy mirrors Circle careers page + web3 roles.
 */

import { type IAgentRuntime, ModelType } from "@elizaos/core";
import { createPage } from "../services/browser.js";
import crypto from "crypto";

// ─── Category Taxonomy ────────────────────────────────────────────────────────
// Modelled after Circle's "Jobs By Team" groupings + web3-specific additions.

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
    description: string;       // first ~300 chars of raw JD text
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
        // Strip common tracking params
        for (const p of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref", "source", "gh_src"]) {
            u.searchParams.delete(p);
        }
        // Lowercase host, remove trailing slash
        return (u.origin + u.pathname + (u.search || "")).replace(/\/$/, "").toLowerCase();
    } catch {
        return url.toLowerCase();
    }
}

// ─── LLM extraction ───────────────────────────────────────────────────────────

async function llmExtract(
    runtime: IAgentRuntime,
    pageText: string,
    url: string
): Promise<{ title: string; summary: string; category: JobCategory }> {
    const prompt = `You are a job listing parser. Analyze the job posting text below.

Return ONLY a JSON object with these exact keys:
- "title": the job title (string)
- "summary": 1-2 sentence plain-English summary of what the role does and key skills (string, max 200 chars)
- "category": one of these exact strings: ${JOB_CATEGORIES.join(" | ")}

Rules:
- If page is NOT a real job posting (blog, culture page, etc.), set title="NOT_A_JOB"
- Pick category by matching department or title keywords
- No markdown, no extra keys, no preamble

URL: ${url}

Job posting text (first 4000 chars):
${pageText.slice(0, 4000)}`;

    const raw = (await runtime.useModel(ModelType.TEXT_LARGE, { prompt, temperature: 0.1 })) as string;

    // Strip <think>...</think> from reasoning models
    const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) throw new Error("LLM returned no JSON");

    const parsed = JSON.parse(jsonMatch[0]);
    return {
        title: (parsed.title || "Unknown Role").trim(),
        summary: (parsed.summary || "").slice(0, 200).trim(),
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
        await page.goto(rawUrl, { timeout: 18000, waitUntil: "domcontentloaded" });
        await page.waitForTimeout(2000);

        const pageText = await page.innerText("body").catch(() => "");
        await page.close();

        if (pageText.length < 100) return null; // empty/blocked page

        const hash = sha256(pageText);

        const { title, summary, category } = await llmExtract(runtime, pageText, rawUrl);

        if (title === "NOT_A_JOB") return null;

        return {
            title,
            summary,
            category,
            description: pageText.slice(0, 300).replace(/\s+/g, " ").trim(),
            apply_url: rawUrl,
            content_hash: hash,
            canonical_url: canonical,
        };
    } catch (err: any) {
        await page?.close().catch(() => { });
        console.error(`extractJobDetail failed for ${rawUrl}: ${err.message}`);
        return null;
    }
}