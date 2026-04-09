import { AgentRuntime, Character, ModelProviderName } from '@elizaos/core';
import * as fs from 'fs';
import * as path from 'path';
import { browseAndScrape } from './actions/browseAndScrape.js';
import dotenv from 'dotenv';

dotenv.config();

async function startAgent() {
  const characterPath = path.join(process.cwd(), 'characters', 'scout.json');
  const characterRaw = fs.readFileSync(characterPath, 'utf8');
  const character: Character = JSON.parse(characterRaw);

  const runtime = new AgentRuntime({
    token: process.env.OPENAI_API_KEY || '',
    modelProvider: ModelProviderName.OPENAI,
    character,
    actions: [browseAndScrape],
    providers: [],
    managers: [],
    databaseAdapter: null as any, // Add adapter if needed
    cacheManager: null as any
  });

  await runtime.initialize();
  console.log(`${character.name} started successfully!`);
}

startAgent().catch(err => {
  console.error('Fatal error starting agent:', err);
  process.exit(1);
});
