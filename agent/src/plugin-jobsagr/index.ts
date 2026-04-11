import { type Plugin } from "@elizaos/core";
import { scrapeXProfile } from "./actions/scrapeXProfile.js";
import { findCareersPage } from "./actions/findCareersPage.js";
import { parseAndStoreJobs } from "./actions/parseAndStoreJobs.js";

export const jobsPlugin: Plugin = {
    name: "jobsagr-plugin",
    description: "Discovers job listings from X company profiles.",
    actions: [scrapeXProfile, findCareersPage, parseAndStoreJobs],
    providers: [],
    evaluators: [],
};

export default jobsPlugin;