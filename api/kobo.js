const SEARCH_URL = 'https://openapi.rakuten.co.jp/services/api/Kobo/EbookSearch/20170426';
const GENRE_URL = 'https://openapi.rakuten.co.jp/services/api/Kobo/GenreSearch/20131010';
const ADULT_WORDS = ['アダルト','成年コミック','成人向け','18禁','官能'];
const LIGHT_NOVEL_WORDS = ['ライトノベル','ラノベ','電撃文庫','MF文庫J','GA文庫','富士見ファンタジア文庫','ガガガ文庫'];

function json(res, status, body, maxAge = 0) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', maxAge ? `s-maxage=${maxAge}, stale-while-revalidate=${maxAge * 2}` : 'no-store');
  res.end(JSON.stringify(body));
}

function credentials() {
  return { appId: process.env.RAKUTEN_APPLICATION_ID, accessKey: process.env.RAKUTEN_ACCESS_KEY };
}

function normalizeItem(item) {
  return {
    id: item.itemNumber || item.itemUrl || item.itemName,
    title: item.itemName || '',
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
    isbn: item.isbn || item.itemNumber || ''
  };
}

function isBlocked(item, excludeLightNovel) {
  const haystack = [item.itemName, item.itemCaption, item.seriesName, item.publisherName, item.koboGenreId].filter(Boolean).join(' ');
  if (ADULT_WORDS.some((word) => haystack.includes(word))) return true;
  return excludeLightNovel && LIGHT_NOVEL_WORDS.some((word) => haystack.includes(word));
}

function buildSearchParams(query) {
  const p = new URLSearchParams({ format:'json', formatVersion:'2' });
  const { appId, accessKey } = credentials();
  p.set('applicationId', appId);
  p.set('accessKey', accessKey);
  p.set('hits', String(Math.min(Number(query.hits || 24), 30)));
  p.set('page', String(Math.max(Number(query.page || 1), 1)));
  p.set('elements', 'itemName,author,publisherName,itemPrice,itemUrl,largeImageUrl,mediumImageUrl,smallImageUrl,itemCaption,salesDate,seriesName,reviewAverage,reviewCount,koboGenreId,itemNumber,isbn');
  const mode = query.mode || 'keyword';
  const value = String(query.q || '').trim();
  if (mode === 'title') p.set('title', value);
  else if (mode === 'author') p.set('author', value);
  else if (mode === 'publisher') p.set('publisherName', value);
  else if (mode === 'isbn') p.set('itemNumber', value);
  else p.set('keyword', value || '本');
  if (query.genreId) p.set('koboGenreId', query.genreId);
  const allowedSort = new Set(['standard','-releaseDate','+itemPrice','-itemPrice','-reviewCount','-reviewAverage']);
  if (allowedSort.has(query.sort)) p.set('sort', query.sort);
  return p;
}

async function rakutenSearch(query) {
  const { appId, accessKey } = credentials();
  if (!appId || !accessKey) throw new Error('RAKUTEN_ENV_MISSING');
  const response = await fetch(`${SEARCH_URL}?${buildSearchParams(query)}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error_description || data.error || `Rakuten API ${response.status}`);
  const raw = data.Items || data.items || [];
  const excludeLightNovel = query.excludeLightNovel === '1';
  const items = raw.map((entry) => entry.Item || entry.item || entry).filter((item) => !isBlocked(item, excludeLightNovel)).map(normalizeItem);
  return { items, page: Number(data.page || query.page || 1), pageCount: Number(data.pageCount || 1), count: Number(data.count || items.length) };
}

export default async function handler(req, res) {
  try {
    const action = req.query.action || 'search';
    if (action === 'health') return json(res, 200, { ok:true, version:'0.1.0', configured:Boolean(credentials().appId && credentials().accessKey) }, 60);
    if (action === 'genres') {
      const { appId, accessKey } = credentials();
      if (!appId || !accessKey) return json(res, 503, { error:'楽天APIの環境変数が未設定です。' });
      const p = new URLSearchParams({ format:'json', formatVersion:'2', applicationId:appId, accessKey, koboGenreId:String(req.query.genreId || '101') });
      const response = await fetch(`${GENRE_URL}?${p}`);
      const data = await response.json().catch(() => ({}));
      return json(res, response.ok ? 200 : response.status, data, 86400);
    }
    const result = await rakutenSearch(req.query);
    return json(res, 200, result, 300);
  } catch (error) {
    const missing = error.message === 'RAKUTEN_ENV_MISSING';
    return json(res, missing ? 503 : 502, { error: missing ? 'Vercelに RAKUTEN_APPLICATION_ID と RAKUTEN_ACCESS_KEY を設定してください。' : '楽天Kobo APIから書籍を取得できませんでした。', detail: error.message });
  }
}
