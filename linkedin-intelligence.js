const puppeteer = require('puppeteer-core');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const url = require('url');
const crypto = require('crypto');

const PORT = 6413;
const LINKEDIN_ROOT = 'https://www.linkedin.com';
const CHROME_DATA_DIR = path.join(os.homedir(), '.puppeteer-debug-session');
const CHROME_EXECUTABLE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const REMOTE_DEBUGGING_PORT = 9222;
const STORAGE_FILE = './posts.json';

const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const computeHash = (post) => {
  const content = JSON.stringify({
    text: post.text?.trim() || '',
    images: (post.images || []).sort() // sorting ensures consistent order
  });
  return crypto.createHash('sha1').update(content).digest('hex');
};

async function launchChrome(headless = false) {
  if (!fs.existsSync(CHROME_DATA_DIR)) fs.mkdirSync(CHROME_DATA_DIR, { recursive: true });
  const args = [
    `--remote-debugging-port=${REMOTE_DEBUGGING_PORT}`,
    `--user-data-dir=${CHROME_DATA_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];

  if (headless) {
    args.push('--headless', '--disable-gpu');
  }

  childProcess.spawn(CHROME_EXECUTABLE, args, { detached: true, stdio: 'ignore' }).unref();
}

async function waitForChrome() {
  const start = Date.now();
  while (Date.now() - start < 8000) {
    try {
      const res = await fetch(`http://localhost:${REMOTE_DEBUGGING_PORT}/json/version`);
      const json = await res.json();
      if (json.webSocketDebuggerUrl) return json.webSocketDebuggerUrl;
    } catch {
      await new Promise(r => setTimeout(r, 300));
    }
  }
  throw new Error('Timed out waiting for Chrome to be ready');
}

async function extractPosts(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  console.log('📡 Fetching hydrated activity feed...');
  try {
    await page.goto(`${LINKEDIN_ROOT}/in/matthieu-achard-168a5969/recent-activity/all/`, { waitUntil: 'domcontentloaded', timeout: 0 });

    const newPosts = [];

    const args = process.argv.slice(2);
    const batchFlagIndex = args.indexOf('--batch');
    const maxBatches = batchFlagIndex !== -1 ? parseInt(args[batchFlagIndex + 1], 10) : null;

    console.log('🌀 Aggressively scrolling and hydrating feed...');
    const extractedPosts = await page.evaluate(async (maxBatches) => {
      const posts = [];
      let stagnant = 0;
      let lastHeight = document.body.scrollHeight;
      let batchCount = 0;

      while (stagnant < 7 && (maxBatches === null || batchCount < maxBatches)) {
        window.scrollBy(0, -50); // upward nudge to stabilize layout
        await new Promise(r => setTimeout(r, 250));

        window.scrollTo(0, document.body.scrollHeight); // full bottom scroll

        // Force lazy image loading
        const imgs = [...document.querySelectorAll('img')];
        for (const img of imgs) {
          const src = img.getAttribute('data-src') || img.dataset?.src;
          if (!img.src && src) img.src = src;
          img.scrollIntoView({ behavior: 'instant', block: 'center' });
        }

        // Click 'Show more results' if visible
        const btn = [...document.querySelectorAll('button, span')]
          .find(el => /show more/i.test(el.innerText || ''));
        if (btn) btn.click();

        await new Promise(r => setTimeout(r, 1000));

        const newBatch = [...document.querySelectorAll('div.feed-shared-update-v2')].map(block => {
          const textBlock =
            block.querySelector('div.update-components-text') ||
            block.querySelector('div.feed-shared-update-v2__description');
          const text = textBlock?.innerText?.trim() || '';

          const images = [...block.querySelectorAll('img')]
            .map(img => img.src)
            .filter(src => /media\.licdn\.com/.test(src));

          const viewsNode = [...block.querySelectorAll('span, button, li')]
            .map(n => n.innerText?.trim())
            .find(t => /\d[\d,.]*\s+(views|impressions)/i.test(t));
          let views = null;
          if (viewsNode) {
            const match = viewsNode.match(/\d[\d,.]+/);
            if (match && match[0]) views = parseInt(match[0].replace(/,/g, ''));
          }

          return { text, images, views };
        });

        posts.push(...newBatch);
        batchCount++;

        const currentHeight = document.body.scrollHeight;
        if (currentHeight === lastHeight) {
          stagnant++;
        } else {
          stagnant = 0;
          lastHeight = currentHeight;
        }
      }

      return posts;
    }, maxBatches);

    newPosts.push(...extractedPosts);
    console.log(`Raw extracted: ${newPosts.length}`);

    let existing = [];
    try {
      existing = JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf8'));
    } catch {
      console.log('🆕 No existing posts.json found, creating new one.');
    }

    const memory = new Map();
    existing.forEach(p => memory.set(p.hash, p));

    const now = new Date().toISOString();
    let updated = 0;
    const merged = [...newPosts]
      .map(p => {
        const hash = computeHash(p);
        const existing = memory.get(hash);
        const fresh = { ...p, hash, fetchedAt: now };

        if (!existing) return fresh;

        if (p.views != null && p.views !== existing.views) {
          updated++;
          return { ...existing, views: p.views, fetchedAt: now };
        }

        return existing;
      });

    const uniqueHashes = new Set();
    const final = [...merged, ...existing]
      .filter(p => {
        if (uniqueHashes.has(p.hash)) return false;
        uniqueHashes.add(p.hash);
        return true;
      });

    fs.writeFileSync(STORAGE_FILE, JSON.stringify(final, null, 2));
    console.log(`✅ Added ${merged.length - updated} new post(s), updated ${updated} views. Total: ${final.length}`);
  } catch (error) {
    console.error(`❌ Failed to fetch activity feed: ${error.message}`);
    await browser.disconnect();
    process.exit(1);
  }
}

(async () => {
  const headless = !process.argv.includes('--config');
  await launchChrome(headless);
  const wsEndpoint = await waitForChrome();
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });

  if (headless) {
    await extractPosts(browser);
    console.log('🔧 Closing browser after extraction process.');
    await browser.close();
  } else {
    console.log('🔧 Configuration mode enabled. Launching browser to LinkedIn homepage.');
    const page = await browser.newPage();
    await page.goto(LINKEDIN_ROOT, { waitUntil: 'load' });
    console.log('🔧 Browser launched to LinkedIn homepage.');

    page.on('close', () => {
      console.log('🔧 Browser window closed. Terminating process.');
      childProcess.execSync(`pkill -f "${CHROME_EXECUTABLE}"`); // Forcefully kill Chrome process
      process.exit(0);
    });

    await new Promise(resolve => browser.on('disconnected', resolve));
  }
})();