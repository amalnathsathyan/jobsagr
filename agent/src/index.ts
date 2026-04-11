import type { Project } from "@elizaos/core";
import jobsPlugin from "./plugin-jobsagr/index.js";
import character from "../characters/agent.character.json";

const project: Project = {
  agents: [
    {
      character,
      plugins: [jobsPlugin],
    },
  ],
};

export default project;