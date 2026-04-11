/**
 * JobsAgr Plugin — ElizaOS Plugin for autonomous job discovery
 *
 * This plugin scrapes X (Twitter) company profiles, navigates to career pages,
 * extracts job listings, and stores them in Supabase.
 */

import { type Plugin } from "@elizaos/core";
import { scrapeXProfile } from "./actions/scrapeXProfile.js";
import { findCareersPage } from "./actions/findCareersPage.js";
import { parseAndStoreJobs } from "./actions/parseAndStoreJobs.js";
import { jobSeedsProvider } from "./providers/jobSeeds.js";

export const jobsPlugin: Plugin = {
    name: "jobsagr-plugin",
    description:
        "Discovers and stores job listings from X company profiles via a 3-step pipeline: scrape profile → find careers page → parse and store jobs.",
    actions: [scrapeXProfile, findCareersPage, parseAndStoreJobs],
    providers: [jobSeedsProvider],
    evaluators: [],
};

export default jobsPlugin;