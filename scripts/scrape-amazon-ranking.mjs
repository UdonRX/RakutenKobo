import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const AMAZON_URL = 'https://www.amazon.co.jp/gp/bestsellers/books';
const outputPath = resolve(process.argv[2] || 'amazon-ranking.json');
const MAX_ITEMS = 100;
const PAGE_STABILIZE_MS = 1500;
const ADULT_WORDS = ['アダルト','成年コミック','成人向け','18禁','官能','成人漫画','エロティック','R18','R18+'];

function cleanText(value = '') {
  return String(value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function looksBlocked(status, html) {
  const text = cleanText(html).toLowerCase();
  return status === 503
    || status === 429
    || /captcha|robot check|enter the characters you see below|not a robot|automated access/.test(text);
}

function extractItems(html) {
  const $ = cheerio.load(html);
  const results = new Map();
  const selectors = [
    '#zg-ordered-list .zg-item-immersion',
    '.p13n-sc-uncoverable-faceout',
    '[id^="p13n-asin-index-"]',
    '.zg-grid-general-faceout'
  ];

  $(selectors.join(',')).each((_, element) => {
    const root = $(element);
    const blockText = cleanText(root.text());
    if (!blockText || ADULT_WORDS.some(word => blockText.includes(word))) return;

    const rankText = cleanText(root.find('.zg-bdg-text').first().text()) || blockText;
    const rankMatch = rankText.match(/#\s*(\d{1,3})|(?:^|\s)(\d{1,3})位/);
    const rank = Number(rankMatch?.[1] || rankMatch?.[2] || 0);
    if (!rank || rank > 100) return;

    const productLink = root.find('a[href*="/dp/"]').first();
    const href = String(productLink.attr('href') || '');
    const asinMatch = href.match(/\/dp\/([A-Z0-9]{10})/i);
    const asin = String(root.attr('data-asin') || asinMatch?.[1] || '').toUpperCase();

    let title = cleanText(root.find('[class*="p13n-sc-css-line-clamp"]').first().text());
    if (!title) title = cleanText(productLink.find('span').first().text());
    if (!title) title = cleanText(root.find('img[alt]').first().attr('alt') || '');
    if (!title || title.length < 2 || title.length > 200) return;

    let author = cleanText(root.find('a.a-size-small.a-link-child').first().text());
    if (!author) author = cleanText(root.find('span.a-size-small.a-color-base').first().text());
    if (author.length > 100) author = '';

    const canonicalUrl = asin ? `https://www.amazon.co.jp/dp/${asin}` : (href ? new URL(href, AMAZON_URL).href : '');
    if (!results.has(rank)) results.set(rank, { rank, title, author, asin, url: canonicalUrl });
  });

  return [...results.values()].sort((a, b) => a.rank - b.rank).slice(0, MAX_ITEMS);
}

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: { width: 1365, height: 900 }
  });
  const page = await context.newPage();

  const response = await page.goto(AMAZON_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 45000
  });

  await page.waitForTimeout(PAGE_STABILIZE_MS);
  const status = response?.status() || 0;
  const html = await page.content();

  if (looksBlocked(status, html)) {
    console.warn(`Amazon ranking fetch was blocked (HTTP ${status || 'unknown'} or challenge page). Keeping the previous snapshot.`);
    process.exitCode = 0;
  } else {
    const items = extractItems(html);
    if (items.length < 5) {
      console.warn(`Amazon ranking parser found only ${items.length} items. Keeping the previous snapshot.`);
      process.exitCode = 0;
    } else {
      const payload = {
        id: 'amazon',
        label: 'Amazon',
        attribution: 'Amazon.co.jp',
        sourceUrl: AMAZON_URL,
        periodLabel: '現在のベストセラー',
        updatedAt: new Date().toISOString(),
        live: false,
        items
      };
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      console.log(`Saved ${items.length} Amazon ranking items to ${outputPath}`);
    }
  }
} finally {
  await browser.close();
}
