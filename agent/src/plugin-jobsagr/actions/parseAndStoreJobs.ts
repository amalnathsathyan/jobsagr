import { type Action, type IAgentRuntime, ModelType } from "@elizaos/core";
import { createPage } from "../services/browser.js";
import { upsertJobs, type JobRow } from "../services/supabase.js";

export const parseAndStoreJobs: Action = {
  name: "PARSE_AND_STORE_JOBS",
  similes: ["EXTRACT_JOBS", "STORE_JOBS", "SCRAPE_CAREERS"],
  description:
    "Scrapes a careers/jobs page, uses LLM to extract structured job listings (title, description, link), and stores them in Supabase.",

  // FIX: exclude X/Twitter URLs — those go to SCRAPE_X_PROFILE instead.
  // Also exclude any URL that looks like it already has an x.com/twitter.com handle.
  validate: async (_runtime, message) => {
    const text = message.content?.text || "";
    if (!text.includes("http")) return false;
    if (text.includes("x.com") || text.includes("twitter.com")) return false;
    return true;
  },

  handler: async (runtime: IAgentRuntime, message, _state, _options, callback) => {
    const cb = (msg: string) => callback?.({ text: msg });
    const text = message.content?.text || "";
    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) {
      return { success: false, text: "No valid URL found in message." };
    }

    const careersUrl = urlMatch[0];
    let page;

    try {
      page = await createPage();
      await page.goto(careersUrl, { timeout: 15000, waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2000);

      const rawText = await page.innerText("body");
      const pageTitle = await page.title();
      await page.close();

      const prompt = `You are a job listing extractor. Given the text content from a careers page, extract all job listings.

Return ONLY a JSON array of objects with these fields:
- title: Job title (required)
- description: Brief description, max 100 chars (optional)
- link: Direct application URL if available (optional)

If no jobs are found, return an empty array [].
Do NOT include any text before or after the JSON array.
Do NOT wrap in markdown code fences.

Page URL: ${careersUrl}
Page Title: ${pageTitle}

Page content (first 6000 chars):
${rawText.slice(0, 6000)}`;

      const response = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt,
        temperature: 0.1,
      });

      // Strip <think>...</think> from Qwen3 / reasoning models
      const cleaned = (response as string)
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .replace(/```json|```/g, "")
        .trim();

      let jobs: { title: string; description?: string; link?: string }[] = [];
      try {
        const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          jobs = JSON.parse(jsonMatch[0]);
        }
      } catch {
        cb("⚠️  Failed to parse LLM response as JSON");
      }

      if (jobs.length === 0) {
        return {
          success: true,
          text: `No job listings found on ${careersUrl}.`,
          data: { count: 0 },
        };
      }

      const companyDomain = new URL(careersUrl).hostname.replace("www.", "");
      const companyName =
        (message as any).data?.companyName ||
        pageTitle.split(/[-–|]/)[0].trim() ||
        companyDomain;

      const jobRows: JobRow[] = jobs.map((j) => ({
        title: j.title,
        description: j.description || "",
        link: j.link || careersUrl,
        company_name: companyName,
        company_x_handle: (message as any).data?.xHandle || "",
        company_website: (message as any).data?.website || companyDomain,
        source_url: careersUrl,
      }));

      const stored = await upsertJobs(jobRows);

      return {
        success: true,
        text: `Found ${jobs.length} jobs from ${companyName}. Stored ${stored} new listings.`,
        data: { count: jobs.length, stored, company: companyName },
      };
    } catch (err: any) {
      await page?.close().catch(() => { });
      return {
        success: false,
        text: `Failed to parse jobs: ${err.message}`,
      };
    }
  },

  examples: [
    [
      {
        name: "user",
        content: { text: "Parse jobs from https://jobs.lever.co/offchainlabs" },
      },
      {
        name: "agent",
        content: {
          text: "I'll extract all job listings from that page and store them.",
          action: "PARSE_AND_STORE_JOBS",
        },
      },
    ],
  ],
};