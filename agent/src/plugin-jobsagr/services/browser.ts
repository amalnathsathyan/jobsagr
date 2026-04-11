import { chromium, Browser, BrowserContext, Page } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// x_cookies.json lives at agent/x_cookies.json
const COOKIES_PATH = path.resolve(process.cwd(), "x_cookies.json");

let _browser: Browser | null = null;
let _context: BrowserContext | null = null;

async function getBrowser(): Promise<Browser> {
  if (_browser?.isConnected()) return _browser;
  _browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  return _browser;
}

async function getContext(): Promise<BrowserContext> {
  if (_context) return _context;

  const browser = await getBrowser();

  _context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  // Hide automation signals
  await _context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  // Load cookies from agent root
  if (fs.existsSync(COOKIES_PATH)) {
    const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, "utf8"));
    await _context.addCookies(cookies);
    console.log(`🍪 Loaded ${cookies.length} X cookies from ${COOKIES_PATH}`);
  } else {
    console.warn(`⚠️  No cookies found at ${COOKIES_PATH} — X scraping may fail`);
  }

  return _context;
}

export async function createPage(): Promise<Page> {
  const context = await getContext();
  const page = await context.newPage();
  return page;
}

export async function closeBrowser(): Promise<void> {
  if (_context) {
    await _context.close();
    _context = null;
  }
  if (_browser) {
    await _browser.close();
    _browser = null;
  }
}