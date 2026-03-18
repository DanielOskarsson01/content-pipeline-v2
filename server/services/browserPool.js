/**
 * Shared browser pool for Playwright-based page fetching.
 *
 * Singleton pattern: one Chromium instance shared across all submodule
 * executions. Each fetch creates an isolated BrowserContext (separate
 * cookies/state) that is closed after use.
 *
 * Auto-recovers if the browser crashes mid-run — checks isConnected()
 * before reuse and relaunches if needed.
 *
 * Lazy-loaded by stageWorker.js — only imported when a submodule
 * actually calls tools.browser.fetch(). Zero cost for modules that
 * don't use it.
 */

import { chromium as playwrightChromium } from 'playwright';

// Stealth mode: playwright-extra + stealth plugin to bypass Cloudflare/bot detection.
// Falls back to vanilla playwright if not installed.
let chromium = playwrightChromium;
try {
  const { chromium: stealthChromium } = await import('playwright-extra');
  const { default: StealthPlugin } = await import('puppeteer-extra-plugin-stealth');
  stealthChromium.use(StealthPlugin());
  chromium = stealthChromium;
  console.log('[browserPool] Stealth mode enabled');
} catch {
  console.warn('[browserPool] playwright-extra not installed — using vanilla Playwright');
}

let browserInstance = null;
let browserLaunchPromise = null;

/**
 * Get or create the shared Chromium instance.
 * Checks isConnected() to detect crashed browsers and relaunches.
 * Promise caching prevents multiple simultaneous launches.
 */
async function getBrowser() {
  // If browser exists but crashed, clear it and relaunch
  if (browserInstance && !browserInstance.isConnected()) {
    console.warn('[browserPool] Browser disconnected — relaunching');
    browserInstance = null;
  }

  if (browserInstance) return browserInstance;
  if (browserLaunchPromise) return browserLaunchPromise;

  browserLaunchPromise = chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  }).then((browser) => {
    browserInstance = browser;
    browserLaunchPromise = null;
    console.log('[browserPool] Chromium launched (stealth)');
    return browser;
  }).catch((err) => {
    browserLaunchPromise = null;
    browserInstance = null;
    throw err;
  });

  return browserLaunchPromise;
}

/**
 * Fetch a URL with a real browser. Returns same shape as tools.http.get()
 * so Readability extraction works identically on browser output.
 *
 * @param {string} url
 * @param {Object} options
 * @param {number} [options.timeout=30000]
 * @param {boolean} [options.waitForNetworkIdle=false]
 * @param {string} [options.waitForSelector]
 * @returns {Promise<{status: number, body: string, url: string, headers: Object}>}
 */
export async function browserFetch(url, options = {}) {
  const {
    timeout = 30000,
    waitForNetworkIdle = false,
    waitForSelector = null,
  } = options;

  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
  });

  const page = await context.newPage();

  try {
    await page.setExtraHTTPHeaders({
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
    });

    const response = await page.goto(url, {
      timeout,
      waitUntil: waitForNetworkIdle ? 'networkidle' : 'domcontentloaded',
    });

    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, { timeout: timeout / 2 });
    }

    // Small delay for final JS execution
    await page.waitForTimeout(500);

    const body = await page.content();
    const status = response?.status() || 200;
    const finalUrl = page.url();

    return { status, body, url: finalUrl, headers: {} };
  } finally {
    await context.close();
  }
}

/**
 * Close the shared browser instance. Called on process shutdown.
 */
export async function closeBrowser() {
  if (browserInstance) {
    try {
      await browserInstance.close();
    } catch (_) {
      // Browser may already be closed
    }
    browserInstance = null;
  }
}
