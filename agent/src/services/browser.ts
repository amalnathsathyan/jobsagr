import { chromium, Browser, Page } from 'playwright';

export class BrowserService {
  private browser: Browser | null = null;

  async init() {
    this.browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  }

  async createPage(): Promise<Page> {
    if (!this.browser) await this.init();
    return await this.browser!.newPage();
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

export const browserService = new BrowserService();
