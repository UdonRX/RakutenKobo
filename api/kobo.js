import * as cheerio from 'cheerio';
import { RANKING_SNAPSHOTS, RANKING_SOURCE_META } from '../catalog.js';

const SEARCH_URL = 'https://openapi.rakuten.co.jp/services/api/Kobo/EbookSearch/20170426';
const GENRE_URL = 'https://openapi.rakuten.co.jp/services/api/Kobo/GenreSearch/20131010';
const BOOKS_BOOK_URL = 'https://openapi.rakuten.co.jp/services/api/BooksBook/Search/20170404';
const VERSION = '0.3.0';
const DEFAULT_ORIGIN = 'https://rakuten-kobo.vercel.app';
const ADULT_WORDS = ['アダルト','成年コミック','成人向け','18禁','官能','成人漫画','エロティック','R18','R18+'];
const LIGHT_NOVEL_WORDS = ['ライトノベル','ラノベ','電撃文庫','MF文庫J','GA文庫','富士見ファンタジア文庫','ガガガ文庫'];
const ROOT_GENRE_ID = '101';
const MAX_RESOLVE_ITEMS = 12;
const SALE_PAGE_SIZE = 12;

const RANKING_LIVE = {
  week: [
    { id:'amazon', label:'Amazon', attribution:'Amazon.co.jp', sourceUrl:'https://www.amazon.co.jp/gp/bestsellers/books', hrefHint:'/dp/', rankMode:'hash', periodLabel:'現在のベストセラー' },
    { id:'rakuten', label:'楽天ブックス', attribution:'楽天ブックス', sourceUrl:'https://books.rakuten.co.jp/', type:'rakuten-api', periodLabel:'売れ筋順' },
    { id:'kinokuniya', label:'紀伊國屋書店', attribution:'紀伊國屋書店調べ', sourceUrl:'https://www.kinokuniya.co.jp/disp/CKnRankingPageCList.jsp?dispNo=107002001001&vTp=w', hrefHint:'/f/dsg-', rankMode:'sequence', periodLabel:'ウィークリー' }
  ],
  month: [
    { id:'kinokuniya', label:'紀伊國屋書店', attribution:'紀伊國屋書店調べ', sourceUrl:'https://www.kinokuniya.co.jp/disp/CKnRankingPageCList.jsp?dispNo=107002001001&vTp=m', hrefHint:'/f/dsg-', rankMode:'sequence', periodLabel:'マンスリー' }
  ],
  year: []
};

const genreResponseCache = new Map();
const genreResolveCache = new Map();
let specialGenrePromise = null;

function json(res, status, body, maxAge = 0) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', maxAge ? `s-maxage=${maxAge}, stale-while-revalidate=${maxAge * 2}` : 'no-store');
  res.end(JSON.stringify(body));
}

function credentials() {
  return {
    appId: String(process.env.RAKUTEN_APPLICATION_ID || '').trim(),
    accessKey: String(process.env.RAKUTEN_ACCESS_KEY || '').trim()
  };
}

function allowedOrigin() {
  return String(process.env.RAKUTEN_ALLOWED_ORIGIN || DEFAULT_ORIGIN).trim().replace(/\/$/, '');
}

function normalizeText(value = '') {
  return String(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s　・･:：!?！？()（）【】\[\]「」『』〈〉《》#＃―ー\-]/g, '');
}

function cleanText(value = '') {
  return String(value).replace(/\u00a0/g, ' ').replace(/[ \t\r\f\v]+/g, ' ').replace(/\n+/g, '\n').trim();
}

function cleanTitle(value = '') {
  return cleanText(value)
    .replace(/^電子\s*/, '')
    .replace(/\s*\[電子書籍版\]\s*$/i, '')
    .replace(/^〖予約〗\s*/, '')
    .trim();
}

function highResImage(url, size = 600) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (/([?&])_ex=\d+x\d+/i.test(value)) return value.replace(/([?&])_ex=\d+x\d+/i, `$1_ex=${size}x${size}`);
  return `${value}${value.includes('?') ? '&' : '?'}_ex=${size}x${size}`;
}

function normalizeItem(item) {
  const sourceImage = item.largeImageUrl || item.mediumImageUrl || item.smallImageUrl || '';
  return {
    id: item.itemNumber || item.itemUrl || item.title || item.itemName,
    title: item.title || item.itemName || '',
    author: item.author || '',
    publisher: item.publisherName || '',
    price: Number(item.itemPrice || 0),
    url: item.itemUrl || '',
    image: highResImage(sourceImage, 600),
    caption: item.itemCaption || '',
    salesDate: item.salesDate || '',
    series: item.seriesName || '',
    reviewAverage: Number(item.reviewAverage || 0),
    reviewCount: Number(item.reviewCount || 0),
    genreId: item.koboGenreId || '',
    isbn: item.itemNumber || '',
    salesType: Number(item.salesType || 0)
  };
}

function genreIds(value = '') {
  return String(value).split('/').map(v => v.trim()).filter(Boolean);
}

function matchesGenrePrefix(value, prefixes) {
  if (!prefixes?.length) return false;
  return genreIds(value).some(id => prefixes.some(prefix => id === prefix || id.startsWith(prefix)));
}

function itemMatchesGenre(item, genreId) {
  if (!genreId) return true;
  return genreIds(item.genreId).some(id => id === genreId || id.startsWith(genreId));
}

function isBlocked(item, { excludeLightNovel = false, lightNovelPrefixes = [], adultPrefixes = [] } = {}) {
  const haystack = [item.title, item.itemName, item.itemCaption, item.seriesName, item.publisherName]
    .filter(Boolean)
    .join(' ');
  if (ADULT_WORDS.some(word => haystack.includes(word))) return true;
  if (matchesGenrePrefix(item.koboGenreId, adultPrefixes)) return true;
  if (!excludeLightNovel) return false;
  if (matchesGenrePrefix(item.koboGenreId, lightNovelPrefixes)) return true;
  return LIGHT_NOVEL_WORDS.some(word => haystack.includes(word));
}

function buildSearchParams(query) {
  const { appId } = credentials();
  const p = new URLSearchParams({
    format: 'json',
    formatVersion: '2',
    applicationId: appId,
    hits: String(Math.min(Math.max(Number(query.hits || 24), 1), 30)),
    page: String(Math.min(Math.max(Number(query.page || 1), 1), 100))
  });

  const mode = String(query.mode || 'keyword');
  const value = String(query.q || '').trim();
  let hasSelector = false;

  if (query.genreId) {
    p.set('koboGenreId', String(query.genreId));
    hasSelector = true;
  }

  if (value) {
    if (mode === 'title') p.set('title', value);
    else if (mode === 'author') p.set('author', value);
    else if (mode === 'publisher') p.set('publisherName', value);
    else if (mode === 'isbn') p.set('itemNumber', value);
    else p.set('keyword', value);
    hasSelector = true;
  }

  if (!hasSelector) p.set('koboGenreId', ROOT_GENRE_ID);

  const allowedSort = new Set(['standard', '+releaseDate', '-releaseDate', '+itemPrice', '-itemPrice', 'reviewCount', 'reviewAverage']);
  const sort = String(query.sort || '');
  if (allowedSort.has(sort)) p.set('sort', sort);

  if (query.salesType === '0' || query.salesType === '1') p.set('salesType', String(query.salesType));
  return p;
}

async function fetchRakuten(url) {
  const { accessKey } = credentials();
  const origin = allowedOrigin();
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      accessKey,
      Origin: origin,
      Referer: `${origin}/`,
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
    }
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { raw: text.slice(0, 500) }; }
  return { response, data };
}

async function fetchPublicHtml(url, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja-JP,ja;q=0.9,en;q=0.5',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
      }
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function rakutenError(data, status) {
  return data?.error_description
    || data?.error
    || data?.errors?.errorMessage
    || data?.errors?.message
    || data?.message
    || `Rakuten API ${status}`;
}

async function fetchGenreData(genreId = ROOT_GENRE_ID) {
  const id = String(genreId || ROOT_GENRE_ID);
  if (genreResponseCache.has(id)) return genreResponseCache.get(id);
  const { appId, accessKey } = credentials();
  if (!appId || !accessKey) throw new Error('RAKUTEN_ENV_MISSING');

  const task = (async () => {
    const p = new URLSearchParams({
      format: 'json',
      formatVersion: '2',
      applicationId: appId,
      koboGenreId: id,
      genrePath: '1'
    });
    const { response, data } = await fetchRakuten(`${GENRE_URL}?${p}`);
    if (!response.ok) throw new Error(rakutenError(data, response.status));
    return data;
  })();

  genreResponseCache.set(id, task);
  try { return await task; }
  catch (error) { genreResponseCache.delete(id); throw error; }
}

function unwrapGenreList(value, singularNames = []) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(item => unwrapGenreList(item, singularNames));
  for (const key of singularNames) {
    const child = value?.[key];
    if (child) return unwrapGenreList(child, singularNames);
  }
  return [value];
}

function genreNode(raw) {
  const node = raw?.child || raw?.Child || raw?.parent || raw?.Parent || raw?.current || raw?.Current || raw || {};
  const id = node.koboGenreId || node.KoboGenreId || node.genreId || '';
  const name = node.koboGenreName || node.KoboGenreName || node.genreName || '';
  const level = Number(node.genreLevel || node.GenreLevel || 0);
  return id && name ? { id: String(id), name: String(name), level } : null;
}

function genreChildren(data) {
  const raw = data?.children ?? data?.Children ?? [];
  return unwrapGenreList(raw, ['child', 'Child'])
    .map(genreNode)
    .filter(Boolean);
}

function findGenre(nodes, names) {
  const wanted = (names || []).map(name => ({ norm: normalizeText(name) })).filter(item => item.norm);
  for (const target of wanted) {
    const exact = nodes.find(node => normalizeText(node.name) === target.norm);
    if (exact) return exact;
  }
  for (const target of wanted) {
    const partial = nodes.find(node => {
      const n = normalizeText(node.name);
      return n.includes(target.norm) || target.norm.includes(n);
    });
    if (partial) return partial;
  }
  return null;
}

async function rootGenres() {
  return genreChildren(await fetchGenreData(ROOT_GENRE_ID));
}

async function resolveGenre({ genreKey = '', names = [], parentNames = [] } = {}) {
  const key = `${genreKey}|${names.join('|')}|${parentNames.join('|')}`;
  if (genreResolveCache.has(key)) return genreResolveCache.get(key);

  const task = (async () => {
    const roots = await rootGenres();

    if (genreKey === 'fiction') {
      return findGenre(roots, names) || findGenre(roots, parentNames);
    }

    if (parentNames.length) {
      const parent = findGenre(roots, parentNames);
      if (parent) {
        const children = genreChildren(await fetchGenreData(parent.id));
        const specificNames = names.filter(name => !parentNames.some(parentName => normalizeText(parentName) === normalizeText(name)));
        const child = findGenre(children, specificNames.length ? specificNames : names);
        if (child) return child;
      }
    }

    const direct = findGenre(roots, names);
    if (direct) return direct;
    return null;
  })();

  genreResolveCache.set(key, task);
  try { return await task; }
  catch (error) { genreResolveCache.delete(key); throw error; }
}

async function adultGenrePrefixes() {
  const roots = await rootGenres();
  return roots.filter(node => /アダルト|成人|adult/i.test(node.name)).map(node => node.id);
}

async function lightNovelGenrePrefixes() {
  const roots = await rootGenres();
  const fictionParent = findGenre(roots, ['小説・エッセイ', '小説']);
  if (!fictionParent) return [];
  try {
    const children = genreChildren(await fetchGenreData(fictionParent.id));
    const light = findGenre(children, ['ライトノベル']);
    return light ? [light.id] : [];
  } catch {
    return [];
  }
}

async function specialGenrePrefixes({ includeLightNovel = false } = {}) {
  if (!specialGenrePromise) {
    specialGenrePromise = adultGenrePrefixes()
      .then(adultPrefixes => ({ adultPrefixes }))
      .catch(() => ({ adultPrefixes: [] }));
  }
  const base = await specialGenrePromise;
  if (!includeLightNovel) return { ...base, lightNovelPrefixes: [] };
  const lightNovelPrefixes = await lightNovelGenrePrefixes();
  return { ...base, lightNovelPrefixes };
}

async function rakutenSearch(query, blockOptions = {}) {
  const { appId, accessKey } = credentials();
  if (!appId || !accessKey) throw new Error('RAKUTEN_ENV_MISSING');

  const { response, data } = await fetchRakuten(`${SEARCH_URL}?${buildSearchParams(query)}`);
  if (!response.ok) throw new Error(rakutenError(data, response.status));

  const raw = data.Items || data.items || [];
  const options = { excludeLightNovel: query.excludeLightNovel === '1', ...blockOptions };
  const items = raw
    .map(entry => entry.Item || entry.item || entry)
    .filter(item => !isBlocked(item, options))
    .map(normalizeItem);

  return {
    items,
    page: Number(data.page || query.page || 1),
    pageCount: Number(data.pageCount || 1),
    count: Number(data.count || items.length)
  };
}

function parsePipe(value) {
  return String(value || '').split('|').map(v => v.trim()).filter(Boolean);
}

async function searchWithGenreMapping(query) {
  let resolvedGenre = null;
  const effectiveQuery = { ...query };
  const specials = await specialGenrePrefixes({ includeLightNovel: query.excludeLightNovel === '1' });

  if (query.genreKey) {
    try {
      resolvedGenre = await resolveGenre({
        genreKey: String(query.genreKey),
        names: parsePipe(query.genreNames),
        parentNames: parsePipe(query.parentNames)
      });
    } catch {}

    if (resolvedGenre) {
      effectiveQuery.genreId = resolvedGenre.id;
      effectiveQuery.q = '';
    } else if (query.fallbackQuery) {
      effectiveQuery.q = String(query.fallbackQuery);
      effectiveQuery.mode = 'keyword';
      delete effectiveQuery.genreId;
    }
  }

  const result = await rakutenSearch(effectiveQuery, specials);
  return {
    ...result,
    resolvedGenre: resolvedGenre ? { id: resolvedGenre.id, name: resolvedGenre.name, level: resolvedGenre.level } : null,
    genreFallbackUsed: Boolean(query.genreKey && !resolvedGenre)
  };
}

function matchScore(book, meta) {
  const bt = normalizeText(book.title);
  const mt = normalizeText(meta.title);
  const ba = normalizeText(book.author);
  const ma = normalizeText(meta.author);
  let score = 0;
  if (bt === mt) score += 100;
  else if (bt.includes(mt) || mt.includes(bt)) score += 55;
  else return -1;

  if (ma) {
    if (ba === ma) score += 60;
    else if (ba.includes(ma) || ma.includes(ba)) score += 35;
    else return -1;
  }
  if (book.salesType === 0) score += 2;
  if (!/合本|分冊|コミック/i.test(book.title)) score += 1;
  return score;
}

async function resolveOne(meta) {
  const specials = await specialGenrePrefixes();
  if (meta.itemNumber || meta.isbn) {
    const itemNumber = String(meta.itemNumber || meta.isbn);
    const exact = await rakutenSearch({ q:itemNumber, mode:'isbn', hits:3, sort:'standard' }, specials).catch(() => null);
    if (exact?.items?.[0]) return { ...exact.items[0], matchMeta: meta };
  }
  const searches = [meta.title, meta.originalTitle].filter(Boolean);
  for (const title of searches) {
    for (const mode of ['title','keyword']) {
      const result = await rakutenSearch({ q: title, mode, hits: 10, sort: 'standard' }, specials);
      const ranked = (result.items || [])
        .map(book => ({ book, score: matchScore(book, meta) }))
        .filter(item => item.score >= 0)
        .sort((a, b) => b.score - a.score);
      if (ranked[0]) return { ...ranked[0].book, matchMeta: meta };
    }
  }
  return null;
}

async function resolveBatch(entries, maxItems = MAX_RESOLVE_ITEMS) {
  const input = Array.isArray(entries) ? entries.slice(0, maxItems) : [];
  const out = [];
  const chunkSize = 4;
  for (let i = 0; i < input.length; i += chunkSize) {
    const chunk = input.slice(i, i + chunkSize);
    const results = await Promise.all(chunk.map(item => resolveOne(item).catch(() => null)));
    out.push(...results.filter(Boolean));
    if (i + chunkSize < input.length) await new Promise(resolve => setTimeout(resolve, 60));
  }
  return out;
}

function saleEndAtFromText(text) {
  const value = cleanText(text);
  let match = value.match(/_(20\d{2})-(\d{1,2})-(\d{1,2})\s*(\d{1,2}):(\d{2})まで/);
  if (!match) match = value.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日(?:[（(][^）)]{0,4}[）)])?\s*(\d{1,2}):(\d{2})まで/);
  if (!match) match = value.match(/(20\d{2})[\/.](\d{1,2})[\/.](\d{1,2})\s*(\d{1,2}):(\d{2})まで/);
  if (!match) return '';
  const [,year,month,day,hour,minute]=match;
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}T${String(hour).padStart(2,'0')}:${minute}:00+09:00`;
}

function findContainingBlock($, element, required, maxDepth = 8) {
  let node = $(element);
  for (let i = 0; i < maxDepth; i += 1) {
    node = node.parent();
    if (!node.length) break;
    const text = cleanText(node.text());
    if (required.every(pattern => pattern.test(text))) return { node, text };
  }
  return null;
}

function parseSalePage(html) {
  const $ = cheerio.load(html);
  const found = new Map();
  $('a[href*="/rk/"]').each((_, element) => {
    const title = cleanTitle($(element).text());
    if (!title || title.length < 2 || title.length > 180) return;
    const container = findContainingBlock($, element, [/通常価格[：:]/, /セール価格[：:]/]);
    if (!container) return;
    const text = container.text;
    if (ADULT_WORDS.some(word => text.includes(word))) return;
    const regular = text.match(/通常価格[：:]\s*([\d,]+)円/);
    const sale = text.match(/セール価格[：:]\s*([\d,]+)円/);
    if (!regular || !sale) return;
    const regularPrice = Number(regular[1].replace(/,/g,''));
    const salePrice = Number(sale[1].replace(/,/g,''));
    if (!regularPrice || !salePrice || salePrice >= regularPrice) return;
    const number = text.match(/商品番号[：:]\s*([0-9A-Za-z-]+)/);
    const genre = text.match(/\d{4}年\d{2}月\d{2}日発売\s*／\s*([^／]+)\s*／/);
    const campaign = text.match(/(〖[^〗]{2,100}〗[^\n]{0,160})/);
    const campaignAnchor = container.node.find('a').filter((__, anchor) => /セール|フェア|OFF|半額|円|無料/.test(cleanText($(anchor).text()))).last();
    const campaignHref = String(campaignAnchor.attr('href') || '').trim();
    const campaignUrl = campaignHref ? new URL(campaignHref, 'https://books.rakuten.co.jp/').href : '';
    const itemNumber = number?.[1] || '';
    const key = itemNumber || normalizeText(title);
    if (!key || found.has(key)) return;
    found.set(key, {
      title,
      author:'',
      itemNumber,
      regularPrice,
      salePrice,
      discountPercent:Math.max(1, Math.round((1 - salePrice / regularPrice) * 100)),
      saleEndAt:saleEndAtFromText(text),
      saleCampaign:campaign?.[1] || '',
      campaignUrl,
      sourceGenre:genre?.[1]?.trim() || ''
    });
  });
  return [...found.values()];
}

async function enrichSaleEndings(items) {
  const urls=[...new Set(items.map(item=>item.campaignUrl).filter(url=>/^https?:\/\//.test(url)))].slice(0,6);
  if (!urls.length) return items;
  const results=await Promise.all(urls.map(async url=>{
    try{
      const html=await fetchPublicHtml(url,1800);
      const text=cleanText(cheerio.load(html).text());
      return [url,saleEndAtFromText(text)];
    }catch{return [url,'']}
  }));
  const endings=new Map(results);
  return items.map(item=>({...item,saleEndAt:item.saleEndAt||endings.get(item.campaignUrl)||''}));
}

async function fetchSaleBooks(query) {
  const page = Math.min(Math.max(Number(query.page || 1),1),20);
  const offset = (page - 1) * 30;
  const params = new URLSearchParams({ g:'101', merch:'53626', h:'50', v:'1', s:'8' });
  if (offset) params.set('o', String(offset));
  let sourceUrl = `https://books.rakuten.co.jp/search?${params}`;
  let html = await fetchPublicHtml(sourceUrl, 3200);
  let rawItems = parseSalePage(html).slice(0, SALE_PAGE_SIZE);
  if (!rawItems.length) {
    const fallbackParams = new URLSearchParams({ g:'101', h:'100', v:'1', maxp:'500', s:'8' });
    if (offset) fallbackParams.set('o', String(offset));
    sourceUrl = `https://books.rakuten.co.jp/search?${fallbackParams}`;
    html = await fetchPublicHtml(sourceUrl, 2200);
    rawItems = parseSalePage(html).slice(0, SALE_PAGE_SIZE);
  }
  if (!rawItems.length) throw new Error('SALE_PAGE_PARSE_EMPTY');
  rawItems = await enrichSaleEndings(rawItems);

  const resolved = await resolveBatch(rawItems, SALE_PAGE_SIZE);
  let resolvedGenre = null;
  if (query.genreKey) {
    resolvedGenre = await resolveGenre({
      genreKey:String(query.genreKey),
      names:parsePipe(query.genreNames),
      parentNames:parsePipe(query.parentNames)
    }).catch(() => null);
  }

  const items = resolved.map(book => {
    const meta = book.matchMeta || {};
    return {
      ...book,
      price:Number(meta.salePrice || book.price || 0),
      regularPrice:Number(meta.regularPrice || 0),
      salePrice:Number(meta.salePrice || book.price || 0),
      discountPercent:Number(meta.discountPercent || 0),
      saleEndAt:meta.saleEndAt || '',
      saleCampaign:meta.saleCampaign || '',
      sourceGenre:meta.sourceGenre || ''
    };
  }).filter(book => !resolvedGenre || itemMatchesGenre(book, resolvedGenre.id));

  return {
    items,
    page,
    sourceUrl,
    fetchedAt:new Date().toISOString(),
    parsed:rawItems.length,
    matched:resolved.length,
    resolvedGenre:resolvedGenre ? {id:resolvedGenre.id,name:resolvedGenre.name} : null
  };
}

function rankRegex(mode) {
  return mode === 'hash' ? /(?:^|\s)#\s*(\d{1,3})(?:\s|$)/ : /(?:^|\s)(\d{1,3})(?:位|[.．])(?:\s|$)/;
}

function parseRankingPage(html, config) {
  const $ = cheerio.load(html);
  const byRank = new Map();
  const anchors = config.hrefHint ? $(`a[href*="${config.hrefHint}"]`) : $('a');

  if (config.rankMode === 'sequence') {
    const seen = new Set();
    anchors.each((_, element) => {
      let title = cleanTitle($(element).text()) || cleanTitle($(element).find('img').attr('alt') || '');
      if (!title || title.length < 2 || title.length > 180) return;
      if (/もっと見る|一覧|カテゴリ|紀伊國屋/.test(title)) return;
      const key = normalizeText(title);if (!key || seen.has(key)) return;
      let node = $(element), blockText = '';
      for (let depth = 0; depth < 6; depth += 1) {
        node = node.parent();if (!node.length) break;
        const text = cleanText(node.text());
        if (text.includes('価格') && text.length < 2400) { blockText = text; break; }
      }
      if (blockText && ADULT_WORDS.some(word => blockText.includes(word))) return;
      seen.add(key);byRank.set(byRank.size + 1,{title,author:'',rank:byRank.size + 1});
    });
    return [...byRank.values()].slice(0,30);
  }

  const rankPattern = rankRegex(config.rankMode);
  anchors.each((_, element) => {
    const href = String($(element).attr('href') || '');
    const title = cleanTitle($(element).text()) || cleanTitle($(element).find('img').attr('alt') || '');
    if (!href || !title || title.length < 2 || title.length > 180) return;
    if (/ランキング|もっと見る|一覧|カテゴリ|Amazon|楽天ブックス|紀伊國屋|丸善|ジュンク堂/.test(title)) return;
    let node = $(element), rank = null, blockText = '';
    for (let depth = 0; depth < 8; depth += 1) {
      node = node.parent();if (!node.length) break;
      const text = cleanText(node.text());if (text.length > 3500) continue;
      const match = text.match(rankPattern);if (match) { rank = Number(match[1]);blockText = text;break; }
    }
    if (!rank || rank > 100) return;
    if (ADULT_WORDS.some(word => blockText.includes(word))) return;
    const current = byRank.get(rank);
    if (!current || title.length > current.title.length) byRank.set(rank,{title,author:'',rank});
  });
  return [...byRank.values()].sort((a,b)=>a.rank-b.rank).slice(0,30);
}

async function fetchRakutenBooksRanking(config) {
  const { appId, accessKey } = credentials();
  if (!appId || !accessKey) throw new Error('RAKUTEN_ENV_MISSING');
  const params = new URLSearchParams({format:'json',formatVersion:'2',applicationId:appId,booksGenreId:'001',sort:'sales',hits:'30',page:'1'});
  const {response,data}=await fetchRakuten(`${BOOKS_BOOK_URL}?${params}`);
  if (!response.ok) throw new Error(rakutenError(data,response.status));
  const raw=data.Items||data.items||[];
  const items=raw.map(entry=>entry.Item||entry.item||entry.Book||entry.book||entry).map((item,index)=>({title:item.title||item.itemName||'',author:item.author||'',isbn:item.isbn||'',rank:index+1})).filter(item=>item.title&&!ADULT_WORDS.some(word=>`${item.title} ${item.author}`.includes(word)));
  if (!items.length) throw new Error('RANKING_PARSE_EMPTY');
  return {id:config.id,label:config.label,attribution:config.attribution,sourceUrl:config.sourceUrl,periodLabel:config.periodLabel,updatedAt:new Date().toISOString().slice(0,10),live:true,items};
}

function fallbackRankingSnapshot(period) {
  const bucket = RANKING_SNAPSHOTS[period] || {};
  const out = {};
  for (const [id,snapshot] of Object.entries(bucket)) {
    const meta = RANKING_SOURCE_META[id] || {id,label:id,attribution:id};
    out[id] = { id, label:meta.label || id, attribution:meta.attribution || id, ...snapshot, live:false };
  }
  return out;
}

async function fetchRankingSource(config) {
  if (config.type === 'rakuten-api') return fetchRakutenBooksRanking(config);
  const html = await fetchPublicHtml(config.sourceUrl, config.id === 'amazon' ? 4500 : 6500);
  const items = parseRankingPage(html, config);
  if (!items.length) throw new Error('RANKING_PARSE_EMPTY');
  return {
    id:config.id,
    label:config.label,
    attribution:config.attribution,
    sourceUrl:config.sourceUrl,
    periodLabel:config.periodLabel,
    updatedAt:new Date().toISOString().slice(0,10),
    live:true,
    items
  };
}

async function fetchRankings(period = 'week') {
  const normalizedPeriod = ['week','month','year'].includes(period) ? period : 'week';
  const configs = RANKING_LIVE[normalizedPeriod] || [];
  const settled = await Promise.allSettled(configs.map(fetchRankingSource));
  const snapshots = {};
  settled.forEach((result,index) => {
    if (result.status === 'fulfilled') snapshots[configs[index].id] = result.value;
  });

  const fallback = fallbackRankingSnapshot(normalizedPeriod);
  for (const [id,snapshot] of Object.entries(fallback)) {
    if (!snapshots[id]) snapshots[id] = snapshot;
  }

  return {
    period:normalizedPeriod,
    snapshots,
    unavailable:configs.filter((config,index)=>settled[index]?.status !== 'fulfilled').map(config=>config.id),
    fetchedAt:new Date().toISOString()
  };
}

async function healthCheck() {
  const { appId, accessKey } = credentials();
  const origin = allowedOrigin();
  if (!appId || !accessKey) {
    return { ok: false, configured: false, rakutenOk: false, status: null, origin, detail: 'environment variables are missing' };
  }

  const p = new URLSearchParams({ format:'json', formatVersion:'2', applicationId:appId, koboGenreId:ROOT_GENRE_ID, hits:'1' });
  const { response, data } = await fetchRakuten(`${SEARCH_URL}?${p}`);
  return {
    ok: response.ok,
    configured: true,
    rakutenOk: response.ok,
    status: response.status,
    origin,
    detail: response.ok ? 'Rakuten Kobo API authentication succeeded' : rakutenError(data, response.status),
    upstreamErrorCode: data?.errors?.errorCode ?? null
  };
}

export default async function handler(req, res) {
  try {
    const action = String(req.query.action || 'search');

    if (action === 'health') {
      const result = await healthCheck();
      return json(res, result.ok ? 200 : (result.configured ? 502 : 503), { version: VERSION, ...result });
    }

    if (action === 'genres') {
      const data = await fetchGenreData(String(req.query.genreId || ROOT_GENRE_ID));
      return json(res, 200, data, 86400);
    }

    if (action === 'genre-resolve') {
      const resolved = await resolveGenre({
        genreKey:String(req.query.genreKey || ''),
        names:parsePipe(req.query.genreNames),
        parentNames:parsePipe(req.query.parentNames)
      });
      return json(res, 200, { resolvedGenre:resolved ? {id:resolved.id,name:resolved.name,level:resolved.level} : null }, 86400);
    }

    if (action === 'resolve') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return json(res, 200, { items: [], requested: 0, matched: 0 });
      const resolved = await resolveBatch(items);
      return json(res, 200, { items: resolved, requested: Math.min(items.length, MAX_RESOLVE_ITEMS), matched: resolved.length }, 300);
    }

    if (action === 'sales') {
      const result = await fetchSaleBooks(req.query);
      return json(res, 200, result, 900);
    }

    if (action === 'rankings') {
      const result = await fetchRankings(String(req.query.period || 'week'));
      return json(res, 200, result, 1800);
    }

    if (action === 'search') {
      const result = await searchWithGenreMapping(req.query);
      return json(res, 200, result, 300);
    }

    return json(res, 400, { error: 'unknown action' });
  } catch (error) {
    const missing = error.message === 'RAKUTEN_ENV_MISSING';
    const saleError = error.message === 'SALE_PAGE_PARSE_EMPTY';
    return json(res, missing ? 503 : 502, {
      error: missing
        ? 'Vercelに RAKUTEN_APPLICATION_ID と RAKUTEN_ACCESS_KEY を設定してください。'
        : saleError
          ? '楽天Koboのセール一覧を解析できませんでした。時間をおいて再読み込みしてください。'
          : '楽天Kobo関連データを取得できませんでした。',
      detail: error.message,
      version: VERSION
    });
  }
}
