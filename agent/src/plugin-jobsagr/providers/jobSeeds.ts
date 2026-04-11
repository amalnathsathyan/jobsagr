import { type Provider } from "@elizaos/core";
import fs from "fs";
import path from "path";

/**
 * Provider that loads seed X profile URLs into the agent's context.
 * The agent can then decide to scrape these profiles for job discovery.
 */
export const jobSeedsProvider: Provider = {
  name: "JOB_SEEDS",
  description: "Provides a list of X profile URLs to scrape for job listings",
  get: async () => {
    const seedsPath = path.resolve("seeds.txt");
    let seeds: string[] = [];

    try {
      if (fs.existsSync(seedsPath)) {
        seeds = fs
          .readFileSync(seedsPath, "utf8")
          .trim()
          .split("\n")
          .filter((line) => line.trim() && !line.startsWith("#"));
      }
    } catch {
      // Seeds file is optional
    }

    return {
      text: seeds.length
        ? `Seed X profiles to scrape for jobs:\n${seeds.join("\n")}`
        : "No seed profiles configured. User can provide X profile URLs directly.",
      data: { seeds },
    };
  },
};
