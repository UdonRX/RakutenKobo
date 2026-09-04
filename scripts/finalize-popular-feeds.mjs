import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import { GENRES, RANKING_SNAPSHOTS, RANKING_SOURCE_META } from '../catalog.js';

const API = String(process.env.KOBO_API_BASE || 'https://rakuten-kobo.vercel.app').replace(/\/+$/, '');
const DATA = 'https://raw.githubusercontent.com/UdonRX/RakutenKobo/ranking-data/data';
const outputDir = resolve(process.argv[2] || '/tmp/completed-feeds');
const ADULT = ['アダルト','成年コミック','成人向け','18禁','官能','成人漫画','エロティック','R18','R18+'];
const LIGHT_NOVEL = ['ライトノベル','ラノベ','電撃文庫','MF文庫J','GA文庫','富士見ファンタジア文庫','ガガガ文庫'];
const GENERIC_TITLES = /^(?:電子書籍|書籍|本|和書|洋書|コミック|漫画|ランキング|ベストセラー|週間|週刊|月間|年間|ウィークリー|マンスリー|デイリー|もっと見る|一覧|詳細|商品ページ)$/u;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = v => String(v || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const norm = v => String(v || '').normalize('NFKC').toLowerCase().replace(/[〜～]/g, '〜').replace(/[\s　・･:：!?！？()（）【】[\]「」『』〈〉《》#＃―ー\-]/g, '');
const text = b => [b?.title,b?.author,b?.publisher,b?.caption,b?.series].filter(Boolean).join(' ');
const isAdult = b => ADULT.some(w => text(b).includes(w));
const isLightNovel = b => LIGHT_NOVEL.some(w => text(b).includes(w));

function usableTitle(value) {
  const title = clean(value);
  return title.length >= 2 && title.length <= 220 && !GENERIC_TITLES.test(title) && !/^(?:Amazon|楽天ブックス|紀伊國屋|丸善|ジュンク堂|トーハン)$/u.test(title);
}
function dedupe(list, keyFn) {
  const seen = new Set(), out = [];
  for (const item of list || []) {
    const key = keyFn(item);
    if (!key || seen.has(key) || isAdult(item)) continue;
    seen.add(key); out.push(item);
  }
  return out;
}
const bookKey = b => String(b?.id || b?.isbn || '').trim() || `${norm(b?.title)}|${norm(b?.author)}`;
const dedupeBooks = list => dedupe(list, bookKey);

async function request(url, { json = false, options = {}, timeout = 28000, retries = 2 } = {}) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          Accept: json ? 'application/json' : 'text/html,application/xhtml+xml',
          'Accept-Language': 'ja-JP,ja;q=0.9',
          ...(options.headers || {})
        }
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      if (!json) return body;
      try { return body ? JSON.parse(body) : {}; }
      catch { throw new Error('JSON_PARSE'); }
    } catch (error) {
      last = error;
      if (attempt < retries) await sleep(600 * (attempt + 1));
    } finally { clearTimeout(timer); }
  }
  throw last;
}

function sourceMeta(id, extra = {}) {
  const base = RANKING_SOURCE_META?.[id] || {};
  return {
    id,
    label: extra.label || base.label || id,
    attribution: extra.attribution || base.attribution || id,
    sourceUrl: extra.sourceUrl || base.sourceUrl || '',
    periodLabel: extra.periodLabel || '',
    updatedAt: extra.updatedAt || new Date().toISOString().slice(0, 10),
    live: extra.live !== false
  };
}
function snapshot(id, items, extra = {}) {
  const meta = sourceMeta(id, extra);
  const rows = dedupe((items || []).filter(x => usableTitle(x?.title)), x => norm(x.title))
    .map((x, i) => ({ title: clean(x.title), author: clean(x.author), isbn: clean(x.isbn), rank: Number(x.rank || i + 1) }))
    .sort((a, b) => a.rank - b.rank);
  return { ...meta, items: rows };
}
function fallback(period, id) {
  const raw = RANKING_SNAPSHOTS?.[period]?.[id];
  if (!raw) return null;
  return snapshot(id, raw.items || [], {
    ...raw,
    label: RANKING_SOURCE_META?.[id]?.label,
    attribution: RANKING_SOURCE_META?.[id]?.attribution,
    live: false
  });
}

function titleFromAnchor($, a) {
  const node = $(a);
  const candidates = [
    node.attr('title'),
    node.find('img[alt]').first().attr('alt'),
    node.find('[class*="title"]').first().text(),
    node.text()
  ].map(clean).filter(usableTitle);
  return candidates.sort((a, b) => b.length - a.length)[0] || '';
}
function authorFromBlock($, node) {
  const candidates = [
    node.find('[class*="author"]').first().text(),
    node.find('a[href*="/f/dsd-"]').first().text(),
    node.find('a[href*="/author/"]').first().text()
  ].map(clean).filter(v => v && v.length <= 100 && !GENERIC_TITLES.test(v));
  return candidates[0] || '';
}
function nearestRank($, element, fallbackRank) {
  let node = $(element);
  for (let depth = 0; depth < 8; depth++) {
    node = node.parent();
    if (!node.length) break;
    const t = clean(node.text());
    if (t.length > 4000) continue;
    const m = t.match(/(?:^|\s|#)(\d{1,3})(?:位|[.．]|\s)/u);
    if (m) return Number(m[1]);
  }
  return fallbackRank;
}

async function kinokuniya(period) {
  if (!['week','month'].includes(period)) return null;
  const v = period === 'week' ? 'w' : 'm';
  const url = `https://www.kinokuniya.co.jp/disp/CKnRankingPageCList.jsp?dispNo=107002001001&vTp=${v}`;
  try {
    const html = await request(url);
    const $ = cheerio.load(html);
    const rows = [], seenHref = new Set(), seenTitle = new Set();
    $('a[href*="/f/dsg-"]').each((_, a) => {
      const href = String($(a).attr('href') || '');
      if (!href || seenHref.has(href)) return;
      const title = titleFromAnchor($, a);
      if (!usableTitle(title)) return;
      const key = norm(title);
      if (!key || seenTitle.has(key)) return;
      let block = $(a);
      for (let d = 0; d < 6; d++) {
        block = block.parent();
        if (!block.length) break;
        const t = clean(block.text());
        if ((/円|価格/u.test(t)) && t.length < 3500) break;
      }
      const blockText = clean(block.text());
      if (ADULT.some(w => blockText.includes(w))) return;
      const rank = nearestRank($, a, rows.length + 1);
      const author = authorFromBlock($, block);
      seenHref.add(href); seenTitle.add(key);
      rows.push({ title, author, rank });
    });
    rows.sort((a, b) => a.rank - b.rank);
    console.log(`Kinokuniya ${period}: ${rows.length} book links`);
    return rows.length ? snapshot('kinokuniya', rows, {
      label:'紀伊國屋書店', attribution:'紀伊國屋書店調べ', sourceUrl:url,
      periodLabel:period === 'week' ? 'ウィークリー' : 'マンスリー'
    }) : null;
  } catch (error) {
    console.warn(`Kinokuniya ${period}: ${error.message}`);
    return null;
  }
}

async function tohan(period) {
  try {
    const root = 'https://www.tohan.jp/bestsellers/';
    const html = await request(root);
    const $ = cheerio.load(html);
    const links = $('a[href]').map((_, a) => new URL($(a).attr('href'), root).href).get();
    const re = period === 'week' ? /20\d{2}_\d{4}_weekly\/?$/ : period === 'month' ? /20\d{2}_\d{2}_monthly\/?$/ : /20\d{2}_(?:firsthalf_total|yearly|total)\/?$/;
    const url = links.find(x => re.test(x));
    if (!url) return fallback(period, 'tohan');
    const page = cheerio.load(await request(url));
    const rows = [];
    page('h2,h3,h4').each((_, el) => {
      const title = clean(page(el).text()).replace(/^\s*\d{1,3}\s*(?:位|[.．])\s*/u, '');
      if (!usableTitle(title) || /ランキング|ベストセラー/u.test(title)) return;
      rows.push({ title, author:'', rank:rows.length + 1 });
    });
    console.log(`Tohan ${period}: ${rows.length} titles`);
    return rows.length ? snapshot('tohan', rows, {
      label:'トーハン', attribution:'トーハン調べ', sourceUrl:url,
      periodLabel:period === 'week' ? '週間' : period === 'month' ? '月間' : '年次'
    }) : fallback(period, 'tohan');
  } catch (error) {
    console.warn(`Tohan ${period}: ${error.message}`);
    return fallback(period, 'tohan');
  }
}

async function amazon() {
  try {
    const data = await request(`${DATA}/amazon-ranking.json?t=${Date.now()}`, { json:true, timeout:12000, retries:0 });
    const rows = Array.isArray(data?.items) ? data.items.filter(x => usableTitle(x?.title)) : [];
    console.log(`Amazon snapshot: ${rows.length} titles`);
    return rows.length ? snapshot('amazon', rows, {
      label:'Amazon', attribution:'Amazon.co.jp', sourceUrl:data.sourceUrl || 'https://www.amazon.co.jp/gp/bestsellers/books',
      periodLabel:data.periodLabel || '現在のベストセラー', updatedAt:data.updatedAt, live:false
    }) : null;
  } catch (error) {
    console.warn(`Amazon snapshot: ${error.message}`);
    return null;
  }
}

async function rakutenWeekly(browser) {
  const root = 'https://books.rakuten.co.jp/ranking/weekly/001/';
  const page = await browser.newPage({ locale:'ja-JP' });
  const rows = new Map();
  const harvest = async () => {
    const items = await page.evaluate(() => {
      const clean = v => String(v || '').replace(/\s+/g, ' ').trim();
      const out = [];
      for (const a of document.querySelectorAll('a[href*="/rb/"]')) {
        const title = clean(a.getAttribute('title')) || clean(a.querySelector('img')?.alt) || clean(a.textContent);
        if (!title) continue;
        let node = a, rank = 0, block = '';
        for (let d = 0; d < 9; d++) {
          node = node.parentElement;
          if (!node) break;
          block = clean(node.textContent);
          const m = block.match(/(?:^|\s)(\d{1,3})位(?:\s|$)/);
          if (m) { rank = Number(m[1]); break; }
        }
        if (rank) out.push({ title, rank, block });
      }
      return out;
    });
    for (const item of items) {
      if (item.rank > 300 || !usableTitle(item.title) || ADULT.some(w => item.block.includes(w))) continue;
      if (!rows.has(item.rank)) rows.set(item.rank, { title:item.title, author:'', rank:item.rank });
    }
  };
  try {
    await page.goto(root, { waitUntil:'domcontentloaded', timeout:45000 });
    await page.waitForTimeout(800);
    await harvest();
    const urls = await page.locator('a[href*="/ranking/weekly/001/"]').evaluateAll(els => [...new Set(els.map(x => x.href).filter(Boolean))]);
    for (const url of urls) {
      if (url === page.url()) continue;
      try {
        await page.goto(url, { waitUntil:'domcontentloaded', timeout:30000 });
        await page.waitForTimeout(300);
        await harvest();
      } catch {}
    }
  } catch (error) {
    console.warn(`Rakuten weekly: ${error.message}`);
  } finally { await page.close(); }
  const items = [...rows.values()].sort((a, b) => a.rank - b.rank);
  console.log(`Rakuten weekly: ${items.length} ranked books`);
  return items.length ? snapshot('rakuten', items, {
    label:'楽天ブックス', attribution:'楽天ブックス', sourceUrl:root, periodLabel:'週間'
  }) : null;
}

function mergeCandidates(sources) {
  const map = new Map();
  for (const [source, snap] of Object.entries(sources)) {
    for (const item of snap?.items || []) {
      if (!usableTitle(item?.title) || isAdult(item)) continue;
      const key = norm(item.title);
      if (!key) continue;
      const rank = Math.max(1, Number(item.rank || 999));
      const current = map.get(key) || { title:item.title, author:item.author || '', isbn:item.isbn || '', score:0, sources:[], source:'combined' };
      current.score += Math.max(1, 180 - Math.min(rank, 170));
      if (!current.author && item.author) current.author = item.author;
      if (!current.isbn && item.isbn) current.isbn = item.isbn;
      if (!current.sources.some(x => x.source === source)) current.sources.push({ source, label:snap.label || source, rank });
      map.set(key, current);
    }
  }
  return [...map.values()].sort((a, b) => b.sources.length - a.sources.length || b.score - a.score || Math.min(...a.sources.map(x => x.rank)) - Math.min(...b.sources.map(x => x.rank))).map((x, i) => ({ ...x, rank:i + 1 }));
}

function simplify(value='') {
  const full = String(value || '').normalize('NFKC').replace(/[〜～]/g, '〜').replace(/\s+/g, ' ').trim();
  return full
    .replace(/\s*[（(][^）)]*(?:コミックス|コミック|DIGITAL|電子|文庫|新書|単行本|BOOKS?)[^）)]*[）)]\s*$/iu, '')
    .replace(/\s*\[[^\]]*(?:電子|DIGITAL|コミック)[^\]]*\]\s*$/iu, '')
    .trim() || full;
}
function extractVolume(value='') {
  const t = simplify(value);
  for (const re of [/(?:第\s*)?(\d{1,3})\s*巻\s*$/u,/[（(]\s*(\d{1,3})\s*[）)]\s*$/u,/(?:^|[\s　])(\d{1,3})\s*$/u]) {
    const m = t.match(re); if (m) return Number(m[1]);
  }
  return null;
}
function titleCore(value='') {
  let t = simplify(value).replace(/\s*[（(][^）)]*[）)]\s*$/u, '').replace(/\s*\[[^\]]*\]\s*$/u, '').trim();
  t = t.replace(/(?:第\s*)?\d{1,3}\s*巻\s*$/u, '').replace(/[（(]\s*\d{1,3}\s*[）)]\s*$/u, '').replace(/(?:^|[\s　])\d{1,3}\s*$/u, '').trim();
  const first = t.split(/[〜～―—]/u).map(x => x.trim()).filter(Boolean)[0];
  return first && first.length >= 4 ? first : t;
}
function flexScore(book, candidate) {
  const bt = norm(book?.title), ct = norm(candidate?.title), bc = norm(titleCore(book?.title)), cc = norm(titleCore(candidate?.title));
  if (!bt || !ct) return -999;
  let score;
  if (bt === ct) score = 140;
  else if (bt.includes(ct) || ct.includes(bt)) score = 105;
  else if (bc && cc && bc === cc) score = 95;
  else if (bc && cc && (bc.includes(cc) || cc.includes(bc)) && Math.min(bc.length, cc.length) >= 4) score = 80;
  else return -999;
  const bv = extractVolume(book?.title), cv = extractVolume(candidate?.title);
  if (bv != null && cv != null) score += bv === cv ? 35 : -140;
  const ba = norm(book?.author), ca = norm(candidate?.author);
  if (ba && ca) score += ba === ca || ba.includes(ca) || ca.includes(ba) ? 25 : -25;
  return score;
}
function fallbackQueries(candidate) {
  const original = String(candidate?.title || '').trim(), simple = simplify(original), core = titleCore(original), volume = extractVolume(original), values = [];
  if (core && core !== simple) values.push(volume != null ? `${core} ${volume}` : core);
  if (simple && simple !== original) values.push(simple);
  if (core && !values.includes(core)) values.push(core);
  return [...new Set(values.filter(v => v.length >= 3))].slice(0, 3);
}
async function resolveChunk(chunk) {
  return request(`${API}/api/kobo?action=resolve`, {
    json:true, timeout:30000, retries:1,
    options:{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ items:chunk.map(x => ({ ...x, originalTitle:x.title, title:simplify(x.title) })) }) }
  });
}
async function flexibleResolveOne(candidate) {
  let best = null, bestScore = -999;
  for (const q of fallbackQueries(candidate)) {
    let data;
    try {
      const p = new URLSearchParams({ action:'search', q, mode:'keyword', hits:'30', sort:'standard' });
      data = await request(`${API}/api/kobo?${p}`, { json:true, timeout:22000, retries:1 });
    } catch { continue; }
    for (const book of data.items || []) {
      const score = flexScore(book, candidate);
      if (score > bestScore) { best = book; bestScore = score; }
    }
    if (bestScore >= 115) break;
  }
  return best && bestScore >= 75 ? { ...best, matchMeta:candidate } : null;
}
async function resolveAdditional(candidates, baseItems) {
  const base = dedupeBooks(baseItems);
  const represented = new Set();
  for (const book of base) {
    const m = book.matchMeta || book.ranking || {};
    for (const v of [m.originalTitle,m.title,book.title]) if (v) represented.add(norm(v));
  }
  const remaining = candidates.filter(c => !represented.has(norm(c.title)));
  let added = [], directlyMatchedKeys = new Set();
  for (let i = 0; i < remaining.length; i += 8) {
    const groups = [remaining.slice(i, i + 4), remaining.slice(i + 4, i + 8)].filter(x => x.length);
    const settled = await Promise.allSettled(groups.map(resolveChunk));
    for (const result of settled) {
      if (result.status !== 'fulfilled') continue;
      for (const book of result.value.items || []) {
        added.push(book);
        const m = book.matchMeta || {};
        if (m.originalTitle || m.title) directlyMatchedKeys.add(norm(m.originalTitle || m.title));
      }
    }
    added = dedupeBooks(added);
    console.log(`Popular add direct ${Math.min(i + 8, remaining.length)}/${remaining.length}; base=${base.length} added=${added.length}`);
    if (i + 8 < remaining.length) await sleep(120);
  }
  const unresolved = remaining.filter(c => !directlyMatchedKeys.has(norm(c.title)));
  for (let i = 0; i < unresolved.length; i += 4) {
    const chunk = unresolved.slice(i, i + 4);
    const settled = await Promise.allSettled(chunk.map(flexibleResolveOne));
    for (const result of settled) if (result.status === 'fulfilled' && result.value) added.push(result.value);
    added = dedupeBooks(added);
    console.log(`Popular add flexible ${Math.min(i + 4, unresolved.length)}/${unresolved.length}; base=${base.length} added=${added.length}`);
    if (i + 4 < unresolved.length) await sleep(100);
  }
  return dedupeBooks([...base, ...added]);
}

function candidateForBook(book, candidates) {
  const meta = book.matchMeta || book.ranking || {};
  const keys = [meta.originalTitle,meta.title,book.title].filter(Boolean).map(norm);
  for (const key of keys) {
    const exact = candidates.find(c => norm(c.title) === key);
    if (exact) return exact;
  }
  let best = null, score = -999;
  for (const candidate of candidates) {
    const s = flexScore(book, candidate);
    if (s > score) { best = candidate; score = s; }
  }
  return score >= 75 ? best : null;
}
function rankBooks(books, candidates) {
  return dedupeBooks(books).map(book => {
    const c = candidateForBook(book, candidates);
    const existing = book.ranking || book.matchMeta || {};
    const ranking = c ? { ...c } : { ...existing };
    return { ...book, ranking };
  }).sort((a, b) => {
    const ar = a.ranking || {}, br = b.ranking || {};
    return (br.sources?.length || 0) - (ar.sources?.length || 0) || Number(br.score || 0) - Number(ar.score || 0) || Math.min(...(ar.sources || [{rank:999}]).map(x => x.rank)) - Math.min(...(br.sources || [{rank:999}]).map(x => x.rank));
  }).map((book, index) => ({ ...book, ranking:{ ...(book.ranking || {}), rank:index + 1 } }));
}
function sourceSnapshots(sources, books) {
  const matchedByCandidate = new Set();
  for (const book of books) {
    const c = book.ranking || book.matchMeta || {};
    if (c.title) matchedByCandidate.add(norm(c.title));
    if (c.originalTitle) matchedByCandidate.add(norm(c.originalTitle));
  }
  const out = {};
  for (const [id, source] of Object.entries(sources)) {
    const rows = (source.items || []).filter(row => matchedByCandidate.has(norm(row.title)));
    if (rows.length) out[id] = { ...source, items:rows };
  }
  return out;
}
async function genreMap() {
  const out = {};
  for (const genre of GENRES) {
    try {
      const p = new URLSearchParams({ action:'genre-resolve', genreKey:genre.id, genreNames:genre.names.join('|'), parentNames:genre.parentNames.join('|') });
      out[genre.id] = (await request(`${API}/api/kobo?${p}`, { json:true, timeout:22000 })).resolvedGenre || null;
    } catch { out[genre.id] = null; }
  }
  return out;
}
function buildGenres(items, resolved) {
  const byGenre = {}, genreStatus = {};
  for (const genre of GENRES) {
    const id = String(resolved[genre.id]?.id || '');
    const books = items.filter(book => {
      if (genre.excludeLightNovel && isLightNovel(book)) return false;
      if (genre.id === 'essay') return /エッセイ|随筆/u.test(text(book));
      return id && String(book.genreId || '').split('/').some(x => x === id || x.startsWith(id));
    });
    byGenre[genre.id] = books.map(bookKey);
    genreStatus[genre.id] = { matched:books.length, complete:true };
  }
  return { byGenre, genreStatus };
}
async function previousFeed(period) {
  try { return await request(`${DATA}/popular-${period}.json?t=${Date.now()}`, { json:true, timeout:12000, retries:0 }); }
  catch { return null; }
}

const resolvedGenres = await genreMap();
const browser = await chromium.launch({ headless:true });
try {
  for (const period of ['week','month','year']) {
    const path = join(outputDir, `popular-${period}.json`);
    let base = {};
    try { base = JSON.parse(await readFile(path, 'utf8')); } catch {}
    const unavailable = new Set(base.unavailable || []);
    const sources = {};

    if (period === 'week') {
      const r = await rakutenWeekly(browser); if (r?.items?.length) { sources.rakuten = r; unavailable.delete('rakuten'); } else unavailable.add('rakuten');
      const a = await amazon(); if (a?.items?.length) { sources.amazon = a; unavailable.delete('amazon'); } else unavailable.add('amazon');
      const m = fallback('week','maruzen'); if (m?.items?.length) sources.maruzen = m;
    }
    const k = await kinokuniya(period); if (k?.items?.length) { sources.kinokuniya = k; unavailable.delete('kinokuniya'); } else if (period !== 'year') unavailable.add('kinokuniya');
    const t = await tohan(period); if (t?.items?.length) { sources.tohan = t; unavailable.delete('tohan'); } else unavailable.add('tohan');
    for (const [id, snap] of Object.entries(base.snapshots || {})) if (!sources[id] && snap?.items?.length) sources[id] = snap;

    const candidates = mergeCandidates(sources);
    if (!candidates.length) {
      console.warn(`Popular ${period}: no expanded candidates; keep base`);
      continue;
    }

    const baseItems = Array.isArray(base.items) ? base.items : [];
    const mergedItems = await resolveAdditional(candidates, baseItems);
    const ranked = rankBooks(mergedItems, candidates);
    const previous = await previousFeed(period);

    if (previous?.completed && Array.isArray(previous.items) && previous.items.length >= 8 && ranked.length < Math.floor(previous.items.length * 0.6) && candidates.length >= Math.floor(Number(previous.candidateCount || 0) * 0.7)) {
      console.warn(`Popular ${period}: stability guard kept previous ${previous.items.length} books instead of regressing to ${ranked.length}`);
      await writeFile(path, `${JSON.stringify(previous, null, 2)}\n`, 'utf8');
      continue;
    }

    const snapshots = sourceSnapshots(sources, ranked);
    const genreData = buildGenres(ranked, resolvedGenres);
    const payload = {
      kind:'popular', completed:true, expandedAllPublishedRanks:true, preserveResolvedMatches:true,
      period, updatedAt:new Date().toISOString(), candidateCount:candidates.length,
      baseMatched:baseItems.length, matched:ranked.length, addedMatches:Math.max(0, ranked.length - baseItems.length),
      unavailable:[...unavailable], snapshots, items:ranked, ...genreData
    };
    await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`Popular ${period} final: ${candidates.length} candidates; base=${baseItems.length}; final=${ranked.length}; ${Object.entries(snapshots).map(([id,s]) => `${id}:${s.items.length}`).join(' ')}`);
  }
} finally {
  await browser.close();
}
