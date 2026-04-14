# JobsAgr 🕵️

[![Live Demo](https://img.shields.io/badge/Live_Demo-Vercel-black?logo=vercel)](https://jobsagr.vercel.app/)
[![YouTube](https://img.shields.io/badge/YouTube-Video_Demo-red?logo=youtube)](https://youtu.be/_d07KBSTmr8)
[![Nosana Builders Challenge](https://img.shields.io/badge/Nosana_Builders_x_ElizaOS-Agent_Challenge-blue.svg)](https://nosana.io)

**JobsAgr** is an autonomous Web3 job discovery agent built on the [ElizaOS framework](https://github.com/elizaOS/eliza). Designed and submitted for the **Nosana Builders x ElizaOS Agent Challenge**, it solves the fragmentation of the Web3 job market by extracting high-signal hiring data directly from their source: company X (Twitter) profiles.

---

## 🎯 The Problem

Web3 job hunting is extremely fragmented. Paid aggregators often gatekeep listings, and free boards struggle to stay current with fast-moving ecosystems. While company social media profiles provide the most up-to-date and robust hiring signals, manually monitoring hundreds of accounts is an impossible task for a human.

## 💡 The Solution: How JobsAgr Works

Given an X profile URL, the JobsAgr agent autonomously executes the following workflow:
1. **Discovery**: Navigates the company’s X profile to find their official website.
2. **Navigation**: Locates the careers/jobs page, expertly handling Single Page Applications (SPAs) and complex redirects.
3. **Extraction**: Uses LLM-powered data parsing to fetch and extract relevant job listings.
4. **Delivery**: Pushes the structured results to a live dashboard database in real-time.

A real-time React/Next.js frontend then serves these aggregated job postings to users seamlessly.

## 🏗️ Technical Stack

- **Core Framework**: ElizaOS
- **Inference**: DeepSeek R1 (Running on Nosana GPU Cloud) / local LLM fallbacks
- **Browser Automation**: Playwright
- **Database**: Supabase
- **Language**: TypeScript

## 🚀 Current State & Roadmap

The MVP successfully processes manual X profile inputs and has been actively verified across various ecosystems, including Solana, Arbitrum, LayerZero, and Mantle.

**Future milestones include:**
- **Full Autonomy**: Proactive X exploration without manual triggers, and gathering from more robust data sources like CoinMarketCap and CoinGecko.
- **Enhanced Navigation**: Advanced handling of JavaScript-heavy, third-party job boards (e.g., Ashby, Greenhouse, Lever).
- **Categorization**: Intelligent filtering and tagging directly on the user dashboard.
- **Expansion**: Extending the same AI-driven approach beyond Web3 niches.

---

## 🛠 Developer Setup Guide

This guide will walk you through spinning up the necessary services to run the JobsAgr agent locally.

### Prerequisites
- [Bun](https://bun.sh/) (for the Eliza agent)
- [Node.js & npm](https://nodejs.org/) (for the frontend web application)
- [Ollama](https://ollama.com/) (for running local LLM inference)

### Step 1: Local Ollama Setup (Development Inference)

The JobsAgr agent relies on an LLM to execute language tasks and parsing evaluations. 

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

The `agent` directory houses the ElizaOS character configuration and the custom automation plugins.

1. Open a new terminal window and navigate to the `agent/` directory:
   ```bash
   cd agent
   ```
2. Install dependencies using bun:
   ```bash
   bun install
   ```
3. Ensure your `.env` is correctly populated with the required keys (e.g., Supabase URLs) and local API connections. 
4. Start the agent strictly in development mode:
   ```bash
   bun run dev
   ```
   *(You should see logs indicating ElizaOS connected to your database and inference nodes).*

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

## ✨ Team & Contributors

Proudly built by:
- **[Amalnath Sathyan](https://github.com/amalnathsathyan)** 
- **[Ajeesh RS](https://github.com/ajeeshRS)** 

---

## 🔗 Project Links
- [Live Web App Demo](https://jobsagr.vercel.app/)
- [Video Demo (<1 minute)](https://youtu.be/_d07KBSTmr8)
