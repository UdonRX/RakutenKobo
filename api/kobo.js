const SEARCH_URL = 'https://openapi.rakuten.co.jp/services/api/Kobo/EbookSearch/20170426';
const GENRE_URL = 'https://openapi.rakuten.co.jp/services/api/Kobo/GenreSearch/20131010';
const VERSION = '0.2.0';
const DEFAULT_ORIGIN = 'https://rakuten-kobo.vercel.app';
const ADULT_WORDS = ['アダルト','成年コミック','成人向け','18禁','官能','成人漫画','エロティック'];
const LIGHT_NOVEL_WORDS = ['ライトノベル','ラノベ','電撃文庫','MF文庫J','GA文庫','富士見ファンタジア文庫','ガガガ文庫'];
const ROOT_GENRE_ID = '101';
const MAX_RESOLVE_ITEMS = 12;

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

function normalizeItem(item) {
  return {
    id: item.itemNumber || item.itemUrl || item.title || item.itemName,
    title: item.title || item.itemName || '',
    author: item.author || '',
    publisher: item.publisherName || '',
    price: Number(item.itemPrice || 0),
    url: item.itemUrl || '',
    image: item.largeImageUrl || item.mediumImageUrl || item.smallImageUrl || '',
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
  return score;
}

async function resolveOne(meta) {
  const searches = [meta.title, meta.originalTitle].filter(Boolean);
  const specials = await specialGenrePrefixes();
  for (const title of searches) {
    const result = await rakutenSearch({ q: title, mode: 'title', hits: 6, sort: 'standard' }, specials);
    const ranked = (result.items || [])
      .map(book => ({ book, score: matchScore(book, meta) }))
      .filter(item => item.score >= 0)
      .sort((a, b) => b.score - a.score);
    if (ranked[0]) return { ...ranked[0].book, matchMeta: meta };
  }
  return null;
}

async function resolveBatch(entries) {
  const input = Array.isArray(entries) ? entries.slice(0, MAX_RESOLVE_ITEMS) : [];
  const out = [];
  const chunkSize = 3;
  for (let i = 0; i < input.length; i += chunkSize) {
    const chunk = input.slice(i, i + chunkSize);
    const results = await Promise.all(chunk.map(item => resolveOne(item).catch(() => null)));
    out.push(...results.filter(Boolean));
    if (i + chunkSize < input.length) await new Promise(resolve => setTimeout(resolve, 90));
  }
  return out;
}

async function healthCheck() {
  const { appId, accessKey } = credentials();
  const origin = allowedOrigin();
  if (!appId || !accessKey) {
    return { ok: false, configured: false, rakutenOk: false, status: null, origin, detail: 'environment variables are missing' };
  }

  const p = new URLSearchParams({
    format: 'json',
    formatVersion: '2',
    applicationId: appId,
    koboGenreId: ROOT_GENRE_ID,
    hits: '1'
  });
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

    if (action === 'resolve') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return json(res, 200, { items: [], requested: 0 });
      const resolved = await resolveBatch(items);
      return json(res, 200, { items: resolved, requested: Math.min(items.length, MAX_RESOLVE_ITEMS), matched: resolved.length }, 300);
    }

    if (action === 'search') {
      const result = await searchWithGenreMapping(req.query);
      return json(res, 200, result, 300);
    }

    return json(res, 400, { error: 'unknown action' });
  } catch (error) {
    const missing = error.message === 'RAKUTEN_ENV_MISSING';
    return json(res, missing ? 503 : 502, {
      error: missing
        ? 'Vercelに RAKUTEN_APPLICATION_ID と RAKUTEN_ACCESS_KEY を設定してください。'
        : '楽天Kobo APIから書籍を取得できませんでした。',
      detail: error.message,
      version: VERSION
    });
  }
}
