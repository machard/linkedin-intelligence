const puppeteer = require('puppeteer-core');
const fs = require('fs');
const crypto = require('crypto');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const REMOTE_DEBUGGING_URL = 'http://localhost:9222/json/version';
const PROXY_ACTIVITY_URL = 'http://localhost:6413/in/matthieu-achard-168a5969/recent-activity/all/';
const STORAGE_FILE = './posts.json';

// Backup existing posts.json before changes
try {
  if (fs.existsSync(STORAGE_FILE)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `posts.${timestamp}.json`;
    fs.copyFileSync(STORAGE_FILE, backupPath);
    console.log(`🗂 Backup created: ${backupPath}`);
  }
} catch (err) {
  console.warn('⚠️  Could not create backup:', err.message);
}

const computeHash = (post) => {
  const content = JSON.stringify({
    text: post.text?.trim() || '',
    images: (post.images || []).sort()  // sorting ensures consistent order
  });
  return crypto.createHash('sha1').update(content).digest('hex');
};

(async () => {
  const res = await fetch(REMOTE_DEBUGGING_URL);
  const { webSocketDebuggerUrl } = await res.json();
  const browser = await puppeteer.connect({ browserWSEndpoint: webSocketDebuggerUrl });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  console.log('📡 Fetching hydrated activity feed...');
  await page.goto(PROXY_ACTIVITY_URL, { waitUntil: 'domcontentloaded', timeout: 0 });

  const newPosts = await page.evaluate(() =>
    [...document.querySelectorAll('div.feed-shared-update-v2')].map(block => {
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
    })
  );

  console.log(`Raw extracted: ${newPosts.length}`);

  // Load memory
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

      // Update views if they've changed
      if (p.views != null && p.views !== existing.views) {
        updated++;
        return { ...existing, views: p.views, fetchedAt: now };
      }

      return existing; // Keep original if no change
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

  process.exit(0);
})();
