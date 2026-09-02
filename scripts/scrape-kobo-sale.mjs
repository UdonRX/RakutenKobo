import * as cheerio from 'cheerio';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const SOURCE_URL = 'https://books.rakuten.co.jp/search?g=101&merch=53626&h=100&v=1&s=8';
const outputPath = resolve(process.argv[2] || 'kobo-sale.json');
const ADULT_WORDS = ['アダルト','成年コミック','成人向け','18禁','官能','成人漫画','エロティック','R18','R18+'];

function cleanText(value = '') { return String(value).replace(/\u00a0/g, ' ').replace(/[ \t\r\f\v]+/g, ' ').replace(/\n+/g, '\n').trim(); }
function cleanTitle(value = '') { return cleanText(value).replace(/^電子\s*/, '').replace(/\s*\[電子書籍版\]\s*$/i, '').replace(/^〖予約〗\s*/, '').trim(); }
function normalizeText(value = '') { return String(value).normalize('NFKC').toLowerCase().replace(/[\s　・･:：!?！？()（）【】\[\]「」『』〈〉《》#＃―ー\-]/g, ''); }
function invalidTitle(title) { return /^\d+\s*件$/.test(title) || /^(レビュー|商品レビュー|もっと見る|一覧)$/.test(title); }
function saleEndAtFromText(text) {
  const value = cleanText(text);
  let match = value.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日(?:[（(][^）)]{0,4}[）)])?\s*(\d{1,2}):(\d{2})まで/);
  if (!match) match = value.match(/(20\d{2})[\/.](\d{1,2})[\/.](\d{1,2})\s*(\d{1,2}):(\d{2})まで/);
  if (!match) return '';
  const [,year,month,day,hour,minute] = match;
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}T${String(hour).padStart(2,'0')}:${minute}:00+09:00`;
}
function findBlock($, element) {
  let node = $(element);
  for (let i = 0; i < 9; i += 1) {
    node = node.parent(); if (!node.length) break;
    const text = cleanText(node.text());
    if (/通常価格[：:]/.test(text) && /セール価格[：:]/.test(text)) return { node, text };
  }
  return null;
}
function parse(html) {
  const $ = cheerio.load(html), found = new Map();
  $('a[href*="/rk/"]').each((_, element) => {
    const title = cleanTitle($(element).text()); if (!title || title.length < 2 || title.length > 180 || invalidTitle(title)) return;
    const block = findBlock($, element); if (!block) return;
    const text = block.text; if (ADULT_WORDS.some(word => text.includes(word))) return;
    const regular = text.match(/通常価格[：:]\s*([\d,]+)円/), sale = text.match(/セール価格[：:]\s*([\d,]+)円/);
    if (!regular || !sale) return;
    const regularPrice = Number(regular[1].replace(/,/g,'')), salePrice = Number(sale[1].replace(/,/g,''));
    if (!regularPrice || !salePrice || salePrice >= regularPrice) return;
    const number = text.match(/商品番号[：:]\s*([0-9A-Za-z-]+)/);
    const genre = text.match(/\d{4}年\d{2}月\d{2}日発売\s*／\s*([^／]+)\s*／/);
    const campaign = text.match(/(〖[^〗]{2,100}〗[^\n]{0,160})/);
    const itemNumber = number?.[1] || '';
    const key = itemNumber || normalizeText(title); if (!key || found.has(key)) return;
    found.set(key, {
      title, author: '', itemNumber, regularPrice, salePrice,
      discountPercent: Math.max(1, Math.round((1 - salePrice / regularPrice) * 100)),
      saleEndAt: saleEndAtFromText(text), saleCampaign: campaign?.[1] || '', sourceGenre: genre?.[1]?.trim() || ''
    });
  });
  return [...found.values()].slice(0, 100);
}

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 20000);
try {
  const response = await fetch(SOURCE_URL, {
    signal: controller.signal,
    headers: {
      Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'ja-JP,ja;q=0.9',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'
    }
  });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  const items = parse(await response.text());
  if (items.length < 5) throw new Error(`SALE_PARSE_TOO_FEW_${items.length}`);
  const payload = { sourceUrl: SOURCE_URL, updatedAt: new Date().toISOString(), items };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Saved ${items.length} sale candidates to ${outputPath}`);
} finally { clearTimeout(timer); }
