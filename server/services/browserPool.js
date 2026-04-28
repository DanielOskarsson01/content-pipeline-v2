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
 *
 * Bright Data Web Unlocker: automatic fallback when browser hits a
 * Cloudflare challenge page. Requires BRIGHT_DATA_API_KEY +
 * BRIGHT_DATA_UNLOCKER_ZONE env vars. Zero cost if not configured.
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
  '--disable-blink-features=AutomationControlled',
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
    autoScroll = false,
    clickSelector = null,
    maxClicks = 0,
    maxClickSeconds = 120,
  } = options;

  const contextOptions = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    colorScheme: 'light',
    permissions: ['geolocation'],
  };
  if (useProxy) contextOptions.ignoreHTTPSErrors = true;
  const context = await browser.newContext(contextOptions);

  const page = await context.newPage();

  // Remove automation fingerprints (belt-and-suspenders with stealth plugin)
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // Chrome runtime stub — Cloudflare checks for its absence
    if (!window.chrome) {
      window.chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
    }
    // Realistic languages (fallback when stealth plugin not loaded)
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });
  });

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

    // Auto-scroll to trigger lazy-loaded content
    if (autoScroll) {
      try {
        await page.evaluate(async () => {
          await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 400;
            const delay = 200;
            const maxScrolls = 30;
            let scrollCount = 0;
            const timer = setInterval(() => {
              const scrollHeight = document.body.scrollHeight;
              window.scrollBy(0, distance);
              totalHeight += distance;
              scrollCount++;
              if (totalHeight >= scrollHeight || scrollCount >= maxScrolls) {
                clearInterval(timer);
                window.scrollTo(0, 0);
                resolve();
              }
            }, delay);
            setTimeout(() => { clearInterval(timer); resolve(); }, maxScrolls * delay + 1000);
          });
        });
        await page.waitForTimeout(1000);
      } catch {
        // Non-fatal: continue with whatever loaded
      }
    }

    // Click "Load More" / "See More" buttons to reveal paginated content.
    // clickSelector: string (single selector) or array of strings (tried in
    // priority order — first visible match wins). Uses Playwright locator API
    // to support :has-text() pseudo-selectors for text-based button detection.
    if (clickSelector && maxClicks > 0) {
      let resolvedSelector = null;
      if (Array.isArray(clickSelector)) {
        for (const sel of clickSelector) {
          try {
            const loc = page.locator(sel).first();
            if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) {
              resolvedSelector = sel;
              console.log(`[browserPool] Auto-detected Load More: "${sel}" on ${url}`);
              break;
            }
          } catch { /* skip invalid selectors */ }
        }
        if (!resolvedSelector) {
          console.log(`[browserPool] No Load More button detected on ${url}`);
        }
      } else {
        resolvedSelector = clickSelector;
      }

      if (resolvedSelector) {
        let clicks = 0;
        let noChangeCount = 0;
        const deadline = Date.now() + maxClickSeconds * 1000;
        for (let i = 0; i < maxClicks; i++) {
          if (Date.now() >= deadline) {
            console.log(`[browserPool] Click loop hit wall-time budget (${maxClickSeconds}s) after ${clicks} click(s) on ${url}`);
            break;
          }
          try {
            const locator = page.locator(resolvedSelector).first();
            if (await locator.count() === 0) break;
            if (!await locator.isVisible().catch(() => false)) break;
            if (!await locator.isEnabled().catch(() => false)) {
              await page.waitForTimeout(2000);
              if (!await locator.isEnabled().catch(() => false)) break;
            }
            const beforeLen = (await page.content()).length;
            await locator.scrollIntoViewIfNeeded().catch(() => {});
            await locator.click();
            clicks++;
            await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
            await page.waitForTimeout(1000);
            const afterLen = (await page.content()).length;
            if (afterLen <= beforeLen) {
              noChangeCount++;
              if (noChangeCount >= 2) break;
            } else {
              noChangeCount = 0;
            }
          } catch {
            break;
          }
        }
        if (clicks > 0) {
          console.log(`[browserPool] Clicked "${resolvedSelector}" ${clicks} time(s) on ${url}`);
        }
      }
    }

    const body = await page.content();
    const status = response?.status() || 200;
    const finalUrl = page.url();

    return { status, body, url: finalUrl, headers: {} };
  } finally {
    await context.close();
  }
}

// Cloudflare challenge markers — if browser result body contains these,
// the page is a challenge page, not real content.
const CHALLENGE_MARKERS = [
  'cf-browser-verification',
  'Checking your browser',
  'Just a moment...',
];

function hasCloudflareChallenge(body) {
  return CHALLENGE_MARKERS.some(m => body.includes(m));
}

/**
 * Fetch a URL using Bright Data Web Unlocker API.
 * Handles Cloudflare, CAPTCHAs, and bot protection server-side.
 * Returns same shape as browserFetch() for drop-in compatibility.
 *
 * Requires: BRIGHT_DATA_API_KEY + BRIGHT_DATA_UNLOCKER_ZONE env vars.
 */
export async function webUnlockerFetch(url) {
  const apiKey = process.env.BRIGHT_DATA_API_KEY;
  const zone = process.env.BRIGHT_DATA_UNLOCKER_ZONE;

  if (!apiKey || !zone) {
    throw new Error('[webUnlocker] BRIGHT_DATA_API_KEY and BRIGHT_DATA_UNLOCKER_ZONE env vars required');
  }

  console.log(`[webUnlocker] Fetching ${url} via Web Unlocker (zone: ${zone})`);

  const response = await fetch('https://api.brightdata.com/request', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ zone, url, format: 'raw' }),
  });

  const body = await response.text();
  const status = response.status;

  if (status >= 200 && status < 300) {
    console.log(`[webUnlocker] Success for ${url} (${body.length} bytes)`);
  } else {
    console.warn(`[webUnlocker] Non-2xx response for ${url}: ${status}`);
  }

  return { status, body, url, headers: {} };
}

export async function browserFetch(url, options = {}) {
  const hasProxy = !!process.env.PROXY_URL;
  const hasUnlocker = !!(process.env.BRIGHT_DATA_API_KEY && process.env.BRIGHT_DATA_UNLOCKER_ZONE);

  let result;
  try {
    const browser = await getBrowser();
    result = await fetchWithBrowser(browser, url, options, hasProxy);
    // Proxy auth failure (407) — retry without proxy
    if (hasProxy && result.status === 407) {
      console.warn(`[browserPool] Proxy auth failed (407) for ${url} — retrying direct`);
      const directBrowser = await getDirectBrowser();
      result = await fetchWithBrowser(directBrowser, url, options, false);
    }
  } catch (err) {
    // Proxy tunnel failure — retry without proxy (direct connection)
    if (hasProxy && err.message?.includes('ERR_TUNNEL_CONNECTION_FAILED')) {
      console.warn(`[browserPool] Proxy tunnel failed for ${url} — retrying direct`);
      const directBrowser = await getDirectBrowser();
      result = await fetchWithBrowser(directBrowser, url, options, false);
    } else {
      throw err;
    }
  }

  // Cloudflare challenge detected — fall back to Web Unlocker if configured
  if (hasUnlocker && result.body && hasCloudflareChallenge(result.body)) {
    console.warn(`[browserPool] Cloudflare challenge detected for ${url} — falling back to Web Unlocker`);
    try {
      return await webUnlockerFetch(url);
    } catch (unlockErr) {
      console.warn(`[webUnlocker] Failed for ${url}: ${unlockErr.message} — returning browser result`);
    }
  }

  return result;
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
