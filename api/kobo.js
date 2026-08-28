const SEARCH_URL = 'https://openapi.rakuten.co.jp/services/api/Kobo/EbookSearch/20170426';
const GENRE_URL = 'https://openapi.rakuten.co.jp/services/api/Kobo/GenreSearch/20131010';
const VERSION = '0.1.2';
const ADULT_WORDS = ['アダルト','成年コミック','成人向け','18禁','官能'];
const LIGHT_NOVEL_WORDS = ['ライトノベル','ラノベ','電撃文庫','MF文庫J','GA文庫','富士見ファンタジア文庫','ガガガ文庫'];

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
    isbn: item.itemNumber || ''
  };
}

function isBlocked(item, excludeLightNovel) {
  const haystack = [item.title, item.itemName, item.itemCaption, item.seriesName, item.publisherName, item.koboGenreId]
    .filter(Boolean)
    .join(' ');
  if (ADULT_WORDS.some((word) => haystack.includes(word))) return true;
  return excludeLightNovel && LIGHT_NOVEL_WORDS.some((word) => haystack.includes(word));
}

function buildSearchParams(query) {
  const { appId, accessKey } = credentials();
  const p = new URLSearchParams({
    format: 'json',
    formatVersion: '2',
    applicationId: appId,
    accessKey,
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
    if (mode === 'title') {
      p.set('title', value);
      hasSelector = true;
    } else if (mode === 'author') {
      p.set('author', value);
      hasSelector = true;
    } else if (mode === 'publisher') {
      p.set('publisherName', value);
      hasSelector = true;
    } else if (mode === 'isbn') {
      p.set('itemNumber', value);
      hasSelector = true;
    } else if (value.length >= 2) {
      p.set('keyword', value);
      hasSelector = true;
    }
  }

  if (!hasSelector) p.set('koboGenreId', '101');

  const sortAliases = new Map([
    ['standard', 'standard'],
    ['+releaseDate', '+releaseDate'],
    ['-releaseDate', '-releaseDate'],
    ['+itemPrice', '+itemPrice'],
    ['-itemPrice', '-itemPrice'],
    ['reviewCount', 'reviewCount'],
    ['-reviewCount', 'reviewCount'],
    ['reviewAverage', 'reviewAverage'],
    ['-reviewAverage', 'reviewAverage']
  ]);
  const sort = sortAliases.get(String(query.sort || ''));
  if (sort) p.set('sort', sort);

  if (query.salesType === '0' || query.salesType === '1') p.set('salesType', String(query.salesType));
  return p;
}

async function fetchRakuten(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

function rakutenError(data, status) {
  return data?.error_description || data?.error || `Rakuten API ${status}`;
}

async function rakutenSearch(query) {
  const { appId, accessKey } = credentials();
  if (!appId || !accessKey) throw new Error('RAKUTEN_ENV_MISSING');

  const { response, data } = await fetchRakuten(`${SEARCH_URL}?${buildSearchParams(query)}`);
  if (!response.ok) throw new Error(rakutenError(data, response.status));

  const raw = data.Items || data.items || [];
  const excludeLightNovel = query.excludeLightNovel === '1';
  const items = raw
    .map((entry) => entry.Item || entry.item || entry)
    .filter((item) => !isBlocked(item, excludeLightNovel))
    .map(normalizeItem);

  return {
    items,
    page: Number(data.page || query.page || 1),
    pageCount: Number(data.pageCount || 1),
    count: Number(data.count || items.length)
  };
}

async function healthCheck() {
  const { appId, accessKey } = credentials();
  if (!appId || !accessKey) {
    return { ok: false, configured: false, rakutenOk: false, status: null, detail: 'environment variables are missing' };
  }

  const p = new URLSearchParams({
    format: 'json',
    formatVersion: '2',
    applicationId: appId,
    accessKey,
    koboGenreId: '101',
    hits: '1'
  });
  const { response, data } = await fetchRakuten(`${SEARCH_URL}?${p}`);
  return {
    ok: response.ok,
    configured: true,
    rakutenOk: response.ok,
    status: response.status,
    detail: response.ok ? 'Rakuten Kobo API authentication succeeded' : rakutenError(data, response.status)
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
      const { appId, accessKey } = credentials();
      if (!appId || !accessKey) return json(res, 503, { error: '楽天APIの環境変数が未設定です。' });
      const p = new URLSearchParams({
        format: 'json',
        formatVersion: '2',
        applicationId: appId,
        accessKey,
        koboGenreId: String(req.query.genreId || '101')
      });
      const { response, data } = await fetchRakuten(`${GENRE_URL}?${p}`);
      return json(res, response.ok ? 200 : response.status, data, response.ok ? 86400 : 0);
    }

    const result = await rakutenSearch(req.query);
    return json(res, 200, result, 300);
  } catch (error) {
    const missing = error.message === 'RAKUTEN_ENV_MISSING';
    return json(res, missing ? 503 : 502, {
      error: missing
        ? 'Vercelに RAKUTEN_APPLICATION_ID と RAKUTEN_ACCESS_KEY を設定してください。'
        : '楽天Kobo APIから書籍を取得できませんでした。',
      detail: error.message
    });
  }
}
