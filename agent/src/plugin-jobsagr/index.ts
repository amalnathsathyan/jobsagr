import { type Plugin } from "@elizaos/core";
import { scrapeXProfile } from "./actions/scrapeXProfile.js";

export const jobsPlugin: Plugin = {
    name: "jobsagr-plugin",
    description: "Discovers job listings from any company URL or X profile.",
    actions: [scrapeXProfile],
    providers: [],
    evaluators: [],
};

export default jobsPlugin;