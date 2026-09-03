(() => {
  const previousFetch = window.fetch.bind(window);
  const DATA_URL = '/data/kobo-sale.json';
  const CACHE_KEY = 'kobo-sale-curated-cache-v1';
  const CACHE_MAX_AGE = 24 * 60 * 60 * 1000;
  const MEMORY_TTL = 15 * 60 * 1000;
  const NETWORK_TIMEOUT = 12000;
  let memoryFeed = null;
  let memoryStamp = 0;

  function urlOf(input) {
    try { return new URL(typeof input === 'string' ? input : input?.url, location.origin); }
    catch { return null; }
  }
  function savedGenre() {
    try { return JSON.parse(localStorage.getItem('kobo-genre-by-tab-v1') || '{}')?.sale || ''; }
    catch { return ''; }
  }
  function isSale(input) {
    const url = urlOf(input);
    return url?.pathname === '/api/kobo' && url.searchParams.get('action') === 'sales';
  }
  function saleGenre(input) {
    const url = urlOf(input);
    return url?.searchParams.get('genreKey') || savedGenre() || '';
  }
  function response(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}
    });
  }
  function validFeed(data) {
    return Boolean(data?.completed && Array.isArray(data?.items) && data.items.length > 0);
  }
  function readLocalCache() {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (!cached?.ts || !validFeed(cached.data)) return null;
      const age = Date.now() - Number(cached.ts);
      if (age < 0 || age > CACHE_MAX_AGE) return null;
      return {data: cached.data, age};
    } catch { return null; }
  }
  function writeLocalCache(data) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ts:Date.now(),data}));
    } catch {
      // Safari private mode / storage quota: memory cache still works.
    }
  }
  async function fetchNetworkFeed() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT);
    try {
      const stamp = Math.floor(Date.now() / (15 * 60 * 1000));
      const r = await previousFetch(`${DATA_URL}?t=${stamp}`, {
        cache:'no-store',
        credentials:'same-origin',
        signal:controller.signal
      });
      if (!r.ok) throw new Error(`SALE_HTTP_${r.status}`);
      const data = await r.json();
      if (!validFeed(data)) throw new Error('SALE_FEED_INVALID');
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
  async function readFeed() {
    if (memoryFeed && Date.now() - memoryStamp < MEMORY_TTL) {
      return {feed:memoryFeed,source:'memory'};
    }
    const cached = readLocalCache();
    try {
      const feed = await fetchNetworkFeed();
      memoryFeed = feed;
      memoryStamp = Date.now();
      writeLocalCache(feed);
      return {feed,source:'network'};
    } catch (error) {
      if (cached) {
        memoryFeed = cached.data;
        memoryStamp = Date.now();
        return {feed:cached.data,source:'local-cache',cacheAge:cached.age,error:error?.message||'NETWORK_FAILED'};
      }
      throw error;
    }
  }
  function selectGenre(feed, genreKey) {
    const all = (feed.items || []).filter(book => book?.saleVerified !== false);
    if (!genreKey) return all;
    const bucket = feed?.byGenre?.[genreKey];
    if (!Array.isArray(bucket)) return [];
    if (!bucket.length) return [];
    if (typeof bucket[0] === 'string' || typeof bucket[0] === 'number') {
      const byId = new Map(all.map(book => [String(book.id), book]));
      return bucket.map(id => byId.get(String(id))).filter(Boolean);
    }
    return bucket.filter(book => book?.saleVerified !== false);
  }

  window.fetch = async (input, init) => {
    if (isSale(input)) {
      try {
        const loaded = await readFeed();
        const feed = loaded.feed;
        const genreKey = saleGenre(input);
        const selected = selectGenre(feed, genreKey);
        return response({
          completed:true,
          exhaustive:Boolean(feed.scannedExhaustive || feed.exhaustive),
          displayCurated:Boolean(feed.displayCurated),
          genreKey,
          genreStatus:genreKey ? feed?.genreStatus?.[genreKey] || null : null,
          campaignCount:Number(feed.campaignCount||0),
          saleVerification:feed.saleVerification||'',
          qualityStrategy:feed.qualityStrategy||'',
          candidates:[],
          items:selected,
          page:1,
          sourceUrl:feed.sourceUrl||'https://books.rakuten.co.jp/',
          officialSaleIndex:feed.officialSaleIndex||'',
          fetchedAt:feed.updatedAt,
          parsed:Number(feed.candidateCount||feed.scanned||selected.length),
          scanned:Number(feed.scanned||feed.candidateCount||selected.length),
          matched:selected.length,
          displayTotal:Number(feed.items?.length||selected.length),
          reviewedSelected:Number(feed.reviewedSelected||0),
          dataSource:loaded.source,
          staleFallback:loaded.source==='local-cache',
          cacheAgeMs:Number(loaded.cacheAge||0)
        });
      } catch (error) {
        return response({
          error:'セールデータを取得できませんでした。',
          detail:'セールデータを取得できませんでした。通信状態を確認して、少し待ってからもう一度開いてください。',
          debugCode:error?.name==='AbortError'?'SALE_FEED_TIMEOUT':(error?.message||'SALE_COMPLETED_FEED_UNAVAILABLE')
        },503);
      }
    }
    return previousFetch(input,init);
  };
})();
