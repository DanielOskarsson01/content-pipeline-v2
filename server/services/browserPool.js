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
let directBrowserInstance = null;
let directBrowserLaunchPromise = null;

const BASE_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
];

/**
 * Get or create the shared Chromium instance (with proxy if configured).
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

  const launchOptions = { headless: true, args: [...BASE_LAUNCH_ARGS] };

  // Residential proxy support: PROXY_URL=http://host:port, PROXY_USERNAME, PROXY_PASSWORD
  // Playwright requires credentials separate from the server URL.
  if (process.env.PROXY_URL) {
    launchOptions.proxy = { server: process.env.PROXY_URL };
    if (process.env.PROXY_USERNAME) launchOptions.proxy.username = process.env.PROXY_USERNAME;
    if (process.env.PROXY_PASSWORD) launchOptions.proxy.password = process.env.PROXY_PASSWORD;
    console.log('[browserPool] Using proxy:', process.env.PROXY_URL, '(user:', process.env.PROXY_USERNAME || 'none', ')');
  }

  browserLaunchPromise = chromium.launch(launchOptions).then((browser) => {
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
 * Get or create a direct (no-proxy) browser instance.
 * Used as fallback when proxy tunnel fails (ERR_TUNNEL_CONNECTION_FAILED).
 * Only launched on first fallback need — zero cost if proxy always works.
 */
async function getDirectBrowser() {
  if (directBrowserInstance && !directBrowserInstance.isConnected()) {
    console.warn('[browserPool] Direct browser disconnected — relaunching');
    directBrowserInstance = null;
  }

  if (directBrowserInstance) return directBrowserInstance;
  if (directBrowserLaunchPromise) return directBrowserLaunchPromise;

  directBrowserLaunchPromise = chromium.launch({
    headless: true,
    args: [...BASE_LAUNCH_ARGS],
    // No proxy — direct connection
  }).then((browser) => {
    directBrowserInstance = browser;
    directBrowserLaunchPromise = null;
    console.log('[browserPool] Direct browser launched (no proxy, fallback)');
    return browser;
  }).catch((err) => {
    directBrowserLaunchPromise = null;
    directBrowserInstance = null;
    throw err;
  });

  return directBrowserLaunchPromise;
}

/**
 * Fetch a page with a given browser instance.
 * Returns same shape as tools.http.get() so Readability extraction
 * works identically on browser output.
 */
async function fetchWithBrowser(browser, url, options, useProxy) {
  const {
    timeout = 30000,
    waitForNetworkIdle = false,
    waitForSelector = null,
  } = options;

  const contextOptions = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
  };
  if (useProxy) contextOptions.ignoreHTTPSErrors = true;
  const context = await browser.newContext(contextOptions);

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
      try {
        await page.waitForSelector(waitForSelector, { timeout: timeout / 2 });
      } catch (_) {
        // Non-fatal: selector didn't appear before timeout.
        // Continue with whatever content is on the page.
        console.warn(`[browserPool] waitForSelector timed out for "${waitForSelector}" on ${url} — continuing`);
      }
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

export async function browserFetch(url, options = {}) {
  const hasProxy = !!process.env.PROXY_URL;

  try {
    const browser = await getBrowser();
    return await fetchWithBrowser(browser, url, options, hasProxy);
  } catch (err) {
    // Proxy tunnel failure — retry without proxy (direct connection)
    if (hasProxy && err.message?.includes('ERR_TUNNEL_CONNECTION_FAILED')) {
      console.warn(`[browserPool] Proxy tunnel failed for ${url} — retrying direct`);
      const directBrowser = await getDirectBrowser();
      return await fetchWithBrowser(directBrowser, url, options, false);
    }
    throw err;
  }
}

/**
 * Close the shared browser instance. Called on process shutdown.
 */
export async function closeBrowser() {
  const instances = [
    { ref: 'browserInstance', inst: browserInstance },
    { ref: 'directBrowserInstance', inst: directBrowserInstance },
  ];
  for (const { ref, inst } of instances) {
    if (inst) {
      try { await inst.close(); } catch (_) { /* may already be closed */ }
    }
  }
  browserInstance = null;
  directBrowserInstance = null;
}
