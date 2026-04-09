# JobsAgr

**Theme:** Autonomous Web3 Job Discovery

## About the Project
**JobsAgr** is an autonomous, AI-powered job discovery platform designed to automate the painful process of hunting for Web3 and tech-related career opportunities. Powered by an intelligent [ElizaOS](https://github.com/elizaOS/eliza) agent, JobsAgr methodically discovers job openings by:
1. Identifying company profiles on platforms like X (Twitter).
2. Navigating to and locating their official career/hiring pages.
3. Automatically parsing job listings and synchronizing them into a shared Database (Supabase).

A real-time React/Next.js frontend then serves these aggregated job postings to users seamlessly. Originally built for the Nosana Builders' Challenge, this project demonstrates decentralized AI infrastructure by utilizing local LLM execution capabilities with Ollama.

---

## 🛠 Developer Setup Guide

This guide will walk you through spinning up the necessary services to run JobsAgr locally.

### Prerequisites
- [Bun](https://bun.sh/) (for the Eliza agent)
- [Node.js & npm](https://nodejs.org/) (for the frontend web application)
- [Ollama](https://ollama.com/) (for running the local LLM)

### Step 1: Local Ollama Setup

The JobsAgr agent relies on a local LLM to execute language tasks and embedding evaluations.

1. Ensure Ollama is installed on your machine.
2. Pull the required model (`qwen2.5:7b`):
   ```bash
   ollama pull qwen2.5:7b
   ```
3. Start the Ollama server:
   ```bash
   ollama serve
   ```
   *(Keep this terminal running in the background).*

### Step 2: Running the AI Agent

The `agent` directory houses the ElizaOS character configuration and the custom plugins for scraping data.

1. Open a new terminal window and navigate to the `agent/` directory:
   ```bash
   cd agent
   ```
2. *(Optional but required for initial checkout)* Install dependencies using bun:
   ```bash
   bun install
   ```
3. Ensure your `.env` is correctly populated with the required keys (e.g., Supabase URLs) and local API paths. 
4. Start the agent strictly in development mode:
   ```bash
   bun run dev
   ```
   *(You should see logs indicating ElizaOS connected to your database and local Ollama).*

### Step 3: Running the Web App Frontend

The `web` directory holds the user-facing job portal. 

1. Open a third terminal window and navigate to the `web/` directory:
   ```bash
   cd web
   ```
2. Install necessary node dependencies:
   ```bash
   npm install
   ```
3. Spin up the development server:
   ```bash
   npm run dev
   ```
4. Access the frontend app by visiting `http://localhost:3000` (or whatever specific port the console outputs).

---

## ✨ Contributors

A huge thanks to the developers who have contributed to making JobsAgr:
- **[@ajeeshRS](https://github.com/ajeeshRS)**
- **[@amalnathsathyan](https://github.com/amalnathsathyan)**
