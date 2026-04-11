import { chromium } from "playwright";
import fs from "fs";
import path from "path";

async function loginAndSaveCookies() {
    console.log("🚀 Launching YOUR real Chrome — log in manually...");

    // Use your actual Chrome with a temp user data dir
    // This makes it indistinguishable from a real browser
    const userDataDir = path.resolve("scripts/chrome_profile");

    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        executablePath: getChromePath(),
        slowMo: 50,
        viewport: { width: 1280, height: 800 },
        args: [
            "--no-sandbox",
            "--disable-blink-features=AutomationControlled", // hides automation flag
        ],
        ignoreDefaultArgs: ["--enable-automation"], // removes "Chrome is being controlled" banner
    });

    const page = await context.newPage();

    // Remove webdriver flag
    await page.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    console.log("📂 Navigating to X login...");
    await page.goto("https://x.com/login", { waitUntil: "domcontentloaded" });

    console.log("\n👤 Log in manually in the browser window (email + password + 2FA if needed)");
    console.log("⏳ Waiting up to 3 minutes...\n");

    await page.waitForURL("https://x.com/home", { timeout: 180000 });

    console.log("✅ Login detected! Saving cookies...");
    const cookies = await context.cookies();
    fs.writeFileSync(
        path.resolve("x_cookies.json"),
        JSON.stringify(cookies, null, 2)
    );

    console.log(`💾 Saved ${cookies.length} cookies to x_cookies.json`);
    await context.close();
    console.log("✅ Done!");
}

function getChromePath(): string {
    const paths = [
        // Mac
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        // Linux
        "/usr/bin/google-chrome",
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
        // Windows
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    ];

    for (const p of paths) {
        if (fs.existsSync(p)) {
            console.log(`🔍 Found Chrome at: ${p}`);
            return p;
        }
    }

    throw new Error(
        "Chrome not found! Install Google Chrome or set executablePath manually."
    );
}

loginAndSaveCookies().catch((err) => {
    console.error("❌ Failed:", err.message);
    process.exit(1);
});