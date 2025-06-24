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

// Remove posts.json if it exists
if (fs.existsSync(STORAGE_FILE)) {
  console.log(`Removing existing ${STORAGE_FILE}...`);
  fs.rmSync(STORAGE_FILE);
}

const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const computeHash = (post) => {
  const content = JSON.stringify({
    text: post.text?.trim() || '',
    images: (post.images || []).sort() // sorting ensures consistent order
  });
  return crypto.createHash('sha1').update(content).digest('hex');
};

console.log('Initializing Puppeteer setup...');

const args = process.argv.slice(2);
const headless = args.includes('--headless');
const extractPostsFlag = args.includes('--extractPosts');

async function launchChrome(headless = false) {
  console.log('Launching Chrome browser...');
  if (!fs.existsSync(CHROME_DATA_DIR)) {
    console.log('Creating Chrome data directory...');
    fs.mkdirSync(CHROME_DATA_DIR, { recursive: true });
  }
  const chromeArgs = [
    `--remote-debugging-port=${REMOTE_DEBUGGING_PORT}`,
    `--user-data-dir=${CHROME_DATA_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];

  if (headless) {
    console.log('Running in headless mode...');
    chromeArgs.push('--headless', '--disable-gpu');
  }

  console.log('Spawning Chrome process...');
  const chromeProcess = childProcess.spawn(CHROME_EXECUTABLE, chromeArgs, { detached: true, stdio: 'ignore' });
  chromeProcess.on('error', (err) => {
    console.error(`Failed to launch Chrome: ${err.message}`);
  });

  chromeProcess.kill = () => {
    try {
      process.kill(chromeProcess.pid);
      console.log('Chrome process terminated successfully.');
    } catch (error) {
      console.error(`Failed to terminate Chrome process: ${error.message}`);
    }
  };

  chromeProcess.unref();
  return chromeProcess;
}

async function waitForChrome() {
  console.log('Waiting for Chrome to be ready...');
  const start = Date.now();
  while (Date.now() - start < 8000) {
    try {
      const res = await fetch(`http://localhost:${REMOTE_DEBUGGING_PORT}/json/version`);
      const json = await res.json();
      if (json.webSocketDebuggerUrl) {
        console.log('Chrome is ready.');
        return json.webSocketDebuggerUrl;
      }
    } catch (error) {
      console.log(`Chrome not ready yet, retrying... (${error.message})`);
      await new Promise(r => setTimeout(r, 300));
    }
  }
  throw new Error('Timed out waiting for Chrome to be ready');
}

const IMAGE_DIR = './public/images';

// Ensure the images directory exists and is empty
if (fs.existsSync(IMAGE_DIR)) {
  console.log(`Clearing images directory at ${IMAGE_DIR}...`);
  fs.rmSync(IMAGE_DIR, { recursive: true, force: true });
}
fs.mkdirSync(IMAGE_DIR, { recursive: true });

async function downloadImage(url, hash, page) {
  try {
    // Skip saving images from static.licdn.com and profile-displayphoto
    if (url.includes('static.licdn.com') || url.includes('profile-displayphoto')) {
      console.log(`Skipping image: ${url}`);
      return null;
    }

    const imageBuffer = await page.evaluate(async (imageUrl) => {
      try {
        const response = await fetch(imageUrl);
        if (!response.ok) throw new Error(`Failed to fetch image: ${imageUrl}`);
        const arrayBuffer = await response.arrayBuffer();
        console.log(`Fetched arrayBuffer for URL: ${imageUrl}, size: ${arrayBuffer.byteLength}`); // Debugging statement
        return Array.from(new Uint8Array(arrayBuffer)); // Convert to Array-like object
      } catch (error) {
        console.error(`Error fetching image: ${error.message}`);
        return null;
      }
    }, url);

    if (!imageBuffer || !Array.isArray(imageBuffer)) {
      console.error(`Image buffer is undefined or not a valid Array-like object for URL: ${url}`);
      return null;
    }

    const filePath = path.join(IMAGE_DIR, `${hash}.jpg`);
    fs.writeFileSync(filePath, Buffer.from(imageBuffer));

    console.log(`Saved image to ${filePath}`);
    return filePath;
  } catch (error) {
    console.error(`Error saving image: ${error.message}`);
    return null;
  }
}

console.log('Starting script execution...');

(async () => {
  let chromeProcess;
  try {
    console.log('Launching Chrome...');
    chromeProcess = await launchChrome(headless);
    const debuggerUrl = await waitForChrome();
    console.log(`Debugger URL: ${debuggerUrl}`);

    const browser = await puppeteer.connect({ browserWSEndpoint: debuggerUrl });
    console.log('Browser connected successfully.');

    if (extractPostsFlag) {
      await extractPosts(browser);
      console.log('Posts extraction completed.');
    } else {
      console.log('Browser launched without extracting posts.');
      console.log('Please close the Chrome window manually to terminate the process.');

      // Wait for the Chrome process to exit
      await new Promise(resolve => {
        chromeProcess.on('exit', () => {
          console.log('Chrome window closed manually.');
          resolve();
        });
      });
    }

    await browser.disconnect();
    console.log('Browser disconnected.');
  } catch (error) {
    console.error(`Script failed: ${error.message}`);
  } finally {
    if (chromeProcess) {
      console.log('Closing Chrome process...');
      chromeProcess.kill();
    }
  }
})();

async function extractPosts(browser) {
  console.log('Launching browser...');
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  console.log('📡 Fetching hydrated activity feed...');
  try {
    await page.goto(`${LINKEDIN_ROOT}/in/matthieu-achard-168a5969/recent-activity/all/`, { waitUntil: 'domcontentloaded', timeout: 0 });
    console.log('Page loaded successfully.');

    console.log('🌀 Aggressively scrolling and hydrating feed...');
    let stagnant = 0;
    let lastHeight = await page.evaluate(() => document.body.scrollHeight);

    while (stagnant < 7) {
      await page.evaluate(() => window.scrollBy(0, -50)); // upward nudge to stabilize layout
      await new Promise(r => setTimeout(r, 250));

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); // full bottom scroll

      // Click 'Show more results' if visible
      const showMoreButton = await page.evaluate(() => {
        const button = [...document.querySelectorAll('button')].find(el => el.textContent.includes('Show more results'));
        if (button) button.click();
        return button;
      });

      await new Promise(r => setTimeout(r, 1000));

      const currentHeight = await page.evaluate(() => document.body.scrollHeight);
      if (currentHeight === lastHeight) {
        stagnant++;
      } else {
        stagnant = 0;
        lastHeight = currentHeight;
      }
    }

    console.log('Finished scrolling. Extracting posts...');

    const extractedPosts = await page.evaluate(() => {
      const posts = [];

      const postElements = document.querySelectorAll('div.feed-shared-update-v2');
      postElements.forEach(block => {
        const textBlock =
          block.querySelector('div.update-components-text') ||
          block.querySelector('div.feed-shared-update-v2__description');
        const text = textBlock?.innerText?.trim() || '';

        const images = [...block.querySelectorAll('img')]
          .map(img => img.src); // Removed filtering logic here

        const viewsNode = [...block.querySelectorAll('span, button, li')]
          .map(n => n.innerText?.trim())
          .find(t => /\d[\d,.]*\s+(views|impressions)/i.test(t));
        let views = null;
        if (viewsNode) {
          const match = viewsNode.match(/\d[\d,.]+/);
          if (match && match[0]) views = parseInt(match[0].replace(/,/g, ''));
        }

        const timeNode = block.querySelector('span.feed-shared-actor__sub-description');
        const time = timeNode?.innerText?.trim() || '';

        posts.push({ text, images, views, time });
      });

      return posts;
    });

    console.log(`Extracted ${extractedPosts.length} posts with valid image URLs.`);

    const now = new Date().toISOString();
    let updated = 0;
    const merged = [...extractedPosts]
      .map(p => {
        const hash = computeHash(p);
        const fresh = { ...p, hash, fetchedAt: now };

        return fresh;
      });

    const uniqueHashes = new Set();
    const final = [...merged]
      .filter(p => {
        if (uniqueHashes.has(p.hash)) return false;
        uniqueHashes.add(p.hash);
        return true;
      });

    fs.writeFileSync(STORAGE_FILE, JSON.stringify(final, null, 2));
    console.log(`✅ Added ${merged.length - updated} new post(s), updated ${updated} views. Total: ${final.length}`);

    // Moved the backup logic to just before downloading images
    console.log('📥 Downloading images and updating posts.json...');
    for (const post of final) {
      const localImages = [];
      for (const image of post.images) {
        const localPath = await downloadImage(image, post.hash, page);
        if (localPath) {
          localImages.push(localPath);
        }
      }
      post.localImages = localImages;
    }

    fs.writeFileSync(STORAGE_FILE, JSON.stringify(final, null, 2));
    console.log('🌟 Posts extraction and image download completed successfully.');

    // Incorporating postsTransformer logic
    console.log('🔄 Transforming posts to Hugo gallery items...');
    const contentDir = './content/gallery';
    if (!fs.existsSync(contentDir)) {
      fs.mkdirSync(contentDir, { recursive: true });
    }

    const galleryItems = final.flatMap((post, index) => {
      if (!post.localImages || post.localImages.length === 0) {
        return []; // Skip posts without localImages
      }
      return post.localImages.map((localImage, imageIndex) => ({
        title: post.text.replace(/"/g, '').replace(/\n/g, ' ').replace(/:/g, '').replace(/'/g, '').replace(/-/g, '') || `Gallery Item ${index + 1}-${imageIndex + 1}`,
        image: `./images/${path.basename(localImage)}`,
        watermark: post.hash || '',
      }));
    });

    galleryItems.forEach((item, index) => {
      const filePath = path.join(contentDir, `gallery-item-${index + 1}.md`);
      const markdownContent = `---\n` +
        `title: "${item.title}"\n` +
        `image: "${item.image}"\n` +
        `watermark: "${item.watermark}"\n` +
        `section: "gallery"\n` +
        `---\n`;
      try {
        fs.writeFileSync(filePath, markdownContent);
      } catch (error) {
        console.error(`Failed to write file ${filePath}:`, error);
      }
    });

    console.log('✅ Gallery items prepared for Hugo successfully.');
  } catch (error) {
    console.error(`Error in extractPosts: ${error.message}`);
  } finally {
    await page.close();
    console.log('Browser page closed.');
  }
}