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

async function downloadImage(url, itemNumber, page) {
  try {
    // Skip saving images from static.licdn.com and profile-displayphoto
    if (url.includes('profile-displayphoto')) {
      // console.log(`Skipping image: ${url}`);
      return null;
    }

    const imageBuffer = await page.evaluate(async (imageUrl) => {
      try {
        const response = await fetch(imageUrl);
        if (!response.ok) throw new Error(`Failed to fetch image: ${imageUrl}`);
        const arrayBuffer = await response.arrayBuffer();
        return Array.from(new Uint8Array(arrayBuffer));
      } catch (error) {
        console.error(`Error fetching image: ${error.message}`);
        return null;
      }
    }, url);

    if (!imageBuffer || !Array.isArray(imageBuffer)) {
      console.error(`Image buffer is undefined or not a valid Array-like object for URL: ${url}`);
      return null;
    }

    const filePath = path.join(IMAGE_DIR, `gallery-item-${String(itemNumber).padStart(3, '0')}.jpg`);
    fs.writeFileSync(filePath, Buffer.from(imageBuffer));

    // console.log(`Saved image to ${filePath} from ${url}`);
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
    // Enhanced scrolling logic to ensure all posts are loaded
    let stagnant = 0;
    let lastHeight = await page.evaluate(() => document.body.scrollHeight);
    let maxScrollAttempts = 20; // Increased scroll attempts to ensure more posts are loaded

    while (stagnant < 10 && maxScrollAttempts > 0) {
      console.log('Scrolling up slightly to stabilize layout...');
      await page.evaluate(() => window.scrollBy(0, -50)); // upward nudge to stabilize layout
      await new Promise(r => setTimeout(r, 250));

      console.log('Scrolling to the bottom of the page...');
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); // full bottom scroll

      const showMoreButton = await page.evaluate(() => {
        const button = [...document.querySelectorAll('button')].find(el => el.textContent.includes('Show more results'));
        if (button) {
          console.log('Clicking "Show more results" button...');
          button.click();
        }
        return button;
      });

      if (showMoreButton) {
        console.log('Resetting remaining scroll attempts after clicking "Show more results" button...');
        maxScrollAttempts = 20; // Reset scroll attempts
      }

      await new Promise(r => setTimeout(r, 2000)); // Increased wait time for posts to load

      // Ensure all posts are loaded before proceeding
      let postsLoaded = false;
      while (!postsLoaded) {
        postsLoaded = await page.evaluate(() => {
          const posts = document.querySelectorAll('div.feed-shared-update-v2');
          return posts.length > 0; // Check if posts exist
        });
        if (!postsLoaded) {
          console.log('Waiting for posts to load...');
          await new Promise(r => setTimeout(r, 500));
        } else {
          console.log('Posts detected. Proceeding...');
        }
      }

      const currentHeight = await page.evaluate(() => document.body.scrollHeight);
      if (currentHeight === lastHeight) {
        console.log('No change in page height detected. Incrementing stagnant counter...');
        stagnant++;
      } else {
        console.log('Page height changed. Resetting stagnant counter...');
        stagnant = 0;
        lastHeight = currentHeight;
      }

      maxScrollAttempts--;
      console.log(`Remaining scroll attempts: ${maxScrollAttempts}`);
    }

    if (maxScrollAttempts === 0) {
      console.warn('Reached maximum scroll attempts. Some posts might not be loaded.');
    }

    console.log('Finished scrolling. Extracting posts...');

        // Just before extracting posts, scroll up post by post to trigger any remaining lazy loading
    // Scroll up post by post until at the top of the page, even if new posts are loaded
    let scrollUpIdx = 0;
    let atTop = false;
    console.log('Final upward scroll post by post until at the top of the page...');
    while (!atTop) {
      await page.evaluate((idx) => {
        const posts = document.querySelectorAll('div.fie-impression-container');
        if (posts[posts.length - 1 - idx]) {
          posts[posts.length - 1 - idx].scrollIntoView({behavior: 'smooth', block: 'start'});
        }
      }, scrollUpIdx);
      await new Promise(r => setTimeout(r, 200));
      // Consider at top if scrollY is 0 or the first post is visible in the viewport
      atTop = await page.evaluate(() => {
        const posts = document.querySelectorAll('div.fie-impression-container');
        if (posts.length === 0) return window.scrollY === 0;
        const first = posts[0];
        const rect = first.getBoundingClientRect();
        return (window.scrollY === 0) || (rect.top >= 0 && rect.top < window.innerHeight/2);
      });
      scrollUpIdx++;
    }

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

        const timeNode = block.querySelector('span.feed-shared-actor__sub-description');
        const time = timeNode?.innerText?.trim() || '';

        posts.push({ text, images, time }); // Removed views from the post object
      });

      return posts;
    });

    console.log(`Extracted ${extractedPosts.length} posts with valid image URLs.`);

    // Removed intermediary save to disk and directly sort posts
    const now = new Date().toISOString();
    const final = extractedPosts.map((post, index) => ({
      ...post,
      order: index + 1 // Assign order based on scraping sequence
    }));

    console.log('🌟 Posts ordered as scraped successfully.');

    // Updated image download logic to use Promise.all for asynchronous fetching
    const downloadImages = async (images, order, page) => {
      const localImages = await Promise.all(
        images.map(async (image) => {
          if (image.includes('static.licdn.com')) {
            // console.log(`Skipping image: ${image}`);
            return null;
          }
          const localPath = await downloadImage(image, order, page);
          return localPath;
        })
      );
      return localImages.filter(Boolean); // Remove null values
    };

    // Invoke downloadImages function for each post
    for (const post of final) {
      post.localImages = await downloadImages(post.images, post.order, page);
    }

    console.log('📥 Images downloaded and associated with posts successfully.');

    // Logic to create markdown files for Hugo gallery items
    const contentDir = './content/gallery';
    if (!fs.existsSync(contentDir)) {
      fs.mkdirSync(contentDir, { recursive: true });
    }

    // Updated markdown generation logic to exclude posts without images
    const galleryItems = final.map((post, index) => {
      const localImages = post.localImages || [];
      if (localImages.length === 0) {
        console.log(`Skipping post without images: ${post.text}`);
        return null; // Exclude posts without images
      }
      return localImages.map((localImage, imageIndex) => ({
        title: post.text.replace(/"/g, '').replace(/\n/g, ' ').replace(/:/g, '').replace(/'/g, '').replace(/-/g, '') || `Gallery Item ${index + 1}-${imageIndex + 1}`,
        image: `./images/${path.basename(localImage)}`,
        watermark: post.order || '',
      }));
    }).flat().filter(Boolean); // Remove null values

    galleryItems.forEach((item, index) => {
      const filePath = path.join(contentDir, `gallery-item-${String(index + 1).padStart(3, '0')}.md`);
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

    console.log('✅ Gallery items prepared for Hugo successfully, including posts without images.');

    // Sort gallery items by their filenames before rendering
    const sortedGalleryItems = fs.readdirSync(contentDir)
      .filter(file => file.startsWith('gallery-item-') && file.endsWith('.md'))
      .sort((a, b) => {
        const numA = parseInt(a.match(/\d+/)[0], 10);
        const numB = parseInt(b.match(/\d+/)[0], 10);
        return numA - numB;
      });

    sortedGalleryItems.forEach((file, index) => {
      const filePath = path.join(contentDir, file);
      const markdownContent = fs.readFileSync(filePath, 'utf-8');
      const updatedContent = markdownContent.replace(/watermark: \"\d+\"/, `watermark: \"${index + 1}\"`);
      fs.writeFileSync(filePath, updatedContent);
    });

    console.log('Gallery items reordered and updated successfully.');

    // Logic to render gallery items in sorted order
    console.log('Gallery items sorted by filename:', sortedGalleryItems);

    return final;
  } catch (error) {
    console.error(`Error in extractPosts: ${error.message}`);
  } finally {
    await page.close();
    console.log('Browser page closed.');
  }
}