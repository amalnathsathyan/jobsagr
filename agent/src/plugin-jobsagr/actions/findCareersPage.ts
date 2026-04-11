import { type Action } from "@elizaos/core";
import { createPage } from "../services/browser.js";

const CAREER_KEYWORDS = [
  "careers", "jobs", "hiring", "join us", "work with us",
  "opportunities", "we're hiring", "open roles", "join the team",
  "join our team", "work at", "career", "vacancies", "positions",
];

export const findCareersPage: Action = {
  name: "FIND_CAREERS_PAGE",
  similes: ["FIND_JOBS_PAGE", "LOCATE_CAREERS", "FIND_OPENINGS"],
  description:
    "Given a company website URL, navigates to it and searches for a careers/jobs page link. Returns the careers page URL if found.",
  validate: async (_runtime, message) => {
    const text = message.content?.text || "";
    return text.includes("http") && !text.includes("x.com") && !text.includes("twitter.com");
  },
  handler: async (_runtime, message) => {
    const text = message.content?.text || "";
    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (!urlMatch) {
      return { success: false, text: "No valid URL found in message." };
    }

    const siteUrl = urlMatch[0];
    let page;

    try {
      page = await createPage();
      await page.goto(siteUrl, { timeout: 15000, waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2000);

      // Collect all links on the page
      const links = await page.$$eval("a", (els) =>
        els.map((a: any) => ({
          href: a.href,
          text: (a.innerText || "").toLowerCase().trim(),
        }))
      );

      // Score each link
      let bestMatch: { href: string; text: string; score: number } | null = null;

      for (const link of links) {
        if (!link.href || link.href === "#" || link.href.startsWith("javascript:")) continue;

        let score = 0;
        for (const keyword of CAREER_KEYWORDS) {
          if (link.text.includes(keyword)) score += 3;
          if (link.href.toLowerCase().includes(keyword)) score += 2;
        }

        if (score > 0 && (!bestMatch || score > bestMatch.score)) {
          bestMatch = { ...link, score };
        }
      }

      await page.close();

      if (!bestMatch) {
        // Try common career page URL patterns
        const commonPaths = ["/careers", "/jobs", "/join-us", "/work-with-us", "/opportunities"];
        const baseUrl = new URL(siteUrl).origin;

        for (const p of commonPaths) {
          try {
            page = await createPage();
            const resp = await page.goto(baseUrl + p, { timeout: 8000 });
            const status = resp?.status();
            await page.close();

            if (status && status >= 200 && status < 400) {
              return {
                success: true,
                text: `Found careers page at ${baseUrl + p} (via URL guessing).`,
                data: { careersUrl: baseUrl + p },
              };
            }
          } catch {
            await page?.close().catch(() => {});
          }
        }

        return {
          success: true,
          text: `No careers page found on ${siteUrl}.`,
          data: { careersUrl: null },
        };
      }

      return {
        success: true,
        text: `Found careers page: ${bestMatch.href} (link text: "${bestMatch.text}").`,
        data: { careersUrl: bestMatch.href },
      };
    } catch (err: any) {
      await page?.close().catch(() => {});
      return {
        success: false,
        text: `Failed to find careers page: ${err.message}`,
      };
    }
  },
  examples: [
    [
      {
        name: "user",
        content: { text: "Find the careers page on https://offchainlabs.com" },
      },
      {
        name: "agent",
        content: {
          text: "I'll look for a careers or jobs page on their website.",
          action: "FIND_CAREERS_PAGE",
        },
      },
    ],
  ],
};