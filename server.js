const puppeteer = require('puppeteer-core');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const url = require('url');

const PORT = 6413;
const LINKEDIN_ROOT = 'https://www.linkedin.com';
const CHROME_DATA_DIR = path.join(os.homedir(), '.puppeteer-debug-session');
const CHROME_EXECUTABLE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const REMOTE_DEBUGGING_PORT = 9222;

const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));

async function launchChrome() {
  if (!fs.existsSync(CHROME_DATA_DIR)) fs.mkdirSync(CHROME_DATA_DIR, { recursive: true });
  childProcess.spawn(CHROME_EXECUTABLE, [
    '--headless=new',
    `--remote-debugging-port=${REMOTE_DEBUGGING_PORT}`,
    `--user-data-dir=${CHROME_DATA_DIR}`,
    '--no-first-run',
    '--no-default-browser-check'
  ], { detached: true, stdio: 'ignore' }).unref();
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

(async () => {
  await launchChrome();
  const wsEndpoint = await waitForChrome();
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });

  http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url);
    const targetUrl = LINKEDIN_ROOT + parsedUrl.path;

    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 800 });

      let bodyData = null;
      if (req.method !== 'GET') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        bodyData = Buffer.concat(chunks).toString();
      }

      await page.setRequestInterception(true);
      page.on('request', intercepted => {
        if (intercepted.isNavigationRequest()) {
          const overrides = {};
          if (req.method !== 'GET') {
            overrides.method = req.method;
            overrides.postData = bodyData;
            overrides.headers = {
              ...intercepted.headers(),
              'Content-Type': req.headers['content-type'] || 'application/x-www-form-urlencoded'
            };
          }
          intercepted.continue(overrides);
        } else {
          intercepted.continue();
        }
      });

      console.log(`🌐 Visiting ${targetUrl}`);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

      console.log('🌀 Aggressively scrolling and hydrating feed...');
      await page.evaluate(async () => {
        let stagnant = 0;
        let lastHeight = document.body.scrollHeight;

        while (stagnant < 7) {
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

          await new Promise(r => setTimeout(r, 2000));

          const newHeight = document.body.scrollHeight;
          if (newHeight === lastHeight) stagnant++;
          else {
            lastHeight = newHeight;
            stagnant = 0;
          }
        }
      });

      await page.waitForSelector('body', { timeout: 5000 });

      const html = await page.content();
      const cleaned = html
        .replace(/(["'])https:\/\/www\.linkedin\.com(\/[^"']*)\1/g, (_, q, p) => `${q}${p}${q}`)
        .replace(/<base[^>]*>/gi, '');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(cleaned);
      await page.close();
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Proxy error: ${err.message}`);
    }
  }).listen(PORT, () => {
    console.log(`\n✅ Proxy up → http://localhost:${PORT}/`);
  });
})();
