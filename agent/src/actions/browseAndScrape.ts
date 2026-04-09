import { Action, IAgentRuntime, Memory, State } from '@elizaos/core';
import { browserService } from '../services/browser.js';
import { supabase } from '../services/database.js';

export const browseAndScrape: Action = {
  name: "BROWSE_AND_SCRAPE",
  similes: ["SCRAPE_JOBS", "FIND_ROLES", "BROWSE_WEBSITE"],
  description: "Browse a website and scrape job listings to save them to the database.",
  validate: async (runtime: IAgentRuntime, _message: Memory) => {
    return true;
  },
  handler: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    // Logic to extract URL from message and scrape
    const text = message.content.text;
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const url = text.match(urlRegex)?.[0];

    if (!url) {
      return { text: "I couldn't find a URL to scrape in your message." };
    }

    try {
      const page = await browserService.createPage();
      await page.goto(url);
      
      // Placeholder for actual scraping logic
      const title = await page.title();
      
      // Example DB operation
      // await supabase.from('scraped_jobs').insert({ url, title });

      await browserService.close();

      return { text: `Successfully browsed ${url}. Page title: ${title}` };
    } catch (error) {
      console.error("Scraping error:", error);
      return { text: `Failed to scrape ${url}.` };
    }
  },
  examples: [
    [
      {
        user: "{{user1}}",
        content: { text: "Scrape jobs from https://jobs.arbitrum.io" }
      },
      {
        user: "{{user2}}",
        content: { text: "I'll check that site for job listings right now.", action: "BROWSE_AND_SCRAPE" }
      }
    ]
  ]
};
