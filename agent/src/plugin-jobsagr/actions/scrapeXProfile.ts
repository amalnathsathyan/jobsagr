import { type Action } from "@elizaos/core";
import { createPage, closeBrowser } from "../services/browser.js";

const COMPANY_SIGNALS = [
  "hiring", "building", "we are", "careers at", "team",
  "inc", "ltd", "corp", "foundation", "protocol", "labs",
  "dao", "network", "platform", "solutions", "ventures",
  "join us", "open roles", "we're hiring", "layer", "blockchain", "throughput"
];

export const scrapeXProfile: Action = {
  name: "SCRAPE_X_PROFILE",
  similes: ["CHECK_X_PROFILE", "SCRAPE_TWITTER", "CHECK_COMPANY"],
  description:
    "Opens an X (Twitter) profile URL, determines if it's a company (not personal), and extracts the website URL from the bio.",
  validate: async (_runtime, message) => {
    const text = message.content?.text || "";
    return text.includes("x.com") || text.includes("twitter.com");
  },
  handler: async (_runtime, message) => {
    const text = message.content?.text || "";
    const urlMatch = text.match(/https?:\/\/(x\.com|twitter\.com)\/[^\s]+/);
    if (!urlMatch) {
      return { success: false, text: "No valid X profile URL found in message." };
    }

    const profileUrl = urlMatch[0];
    let page;

    try {
      page = await createPage();
      await page.goto(profileUrl, { timeout: 20000, waitUntil: "domcontentloaded" });
      await page.waitForTimeout(3000);

      const bio = await page
        .$eval('[data-testid="UserDescription"]', (el: any) => el.innerText)
        .catch(() => "");

      const website = await page
        .$eval('[data-testid="UserUrl"] a', (el: any) => el.href)
        .catch(() => "");

      const displayName = await page
        .$eval('[data-testid="UserName"]', (el: any) => el.innerText.split("\n")[0])
        .catch(() => "");

      const handle = profileUrl.split("/").pop() || "";

      const isCompany =
        COMPANY_SIGNALS.some((s) => bio.toLowerCase().includes(s)) || true;

      await page.close();

      if (!isCompany) {
        return {
          success: true,
          text: `@${handle} appears to be a personal profile, skipping.`,
          data: { isCompany: false, handle },
        };
      }

      if (!website) {
        return {
          success: true,
          text: `@${handle} looks like a company but has no website link in bio.`,
          data: { isCompany: true, handle, companyName: displayName },
        };
      }

      return {
        success: true,
        text: `Found company: ${displayName} (@${handle}). Website: ${website}. Ready to find careers page.`,
        data: {
          isCompany: true,
          website,
          companyName: displayName,
          xHandle: handle,
          bio,
        },
      };
    } catch (err: any) {
      await page?.close().catch(() => { });
      return {
        success: false,
        text: `Failed to scrape X profile: ${err.message}`,
      };
    }
  },
  examples: [
    [
      {
        name: "user",
        content: { text: "Find jobs from https://x.com/arbitrum" },
      },
      {
        name: "agent",
        content: {
          text: "I'll check the Arbitrum X profile for their website.",
          action: "SCRAPE_X_PROFILE",
        },
      },
    ],
  ],
};