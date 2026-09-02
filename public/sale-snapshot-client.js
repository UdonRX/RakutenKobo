(() => {
  const originalFetch = window.fetch.bind(window);
  const SNAPSHOT_URL = 'https://raw.githubusercontent.com/UdonRX/RakutenKobo/ranking-data/data/kobo-sale.json';
  const CACHE_PREFIX = 'kobo-sale-snapshot-response-v3:';
  const CACHE_TTL = 6 * 60 * 60 * 1000;
  const REFRESH_AFTER = 60 * 60 * 1000;
  const MAX_CANDIDATES = 30;

  function requestUrl(input) {
    try { return new URL(typeof input === 'string' ? input : input?.url, location.origin); }
    catch { return null; }
  }
  function isSaleRequest(input) {
    const url = requestUrl(input);
    return url?.pathname === '/api/kobo' && url.searchParams.get('action') === 'sales';
  }
  function cacheKey(input) {
    const url = requestUrl(input);
    return `${CACHE_PREFIX}${url?.searchParams.get('genreKey') || 'all'}`;
  }
  function readCache(input) {
    try {
      const value = JSON.parse(localStorage.getItem(cacheKey(input)) || 'null');
      if (!value?.ts || !value?.data) return null;
      const age = Date.now() - Number(value.ts);
      if (age < 0 || age > CACHE_TTL) return null;
      return { ...value, age };
    } catch { return null; }
  }
  function writeCache(input, data) {
    try { localStorage.setItem(cacheKey(input), JSON.stringify({ ts: Date.now(), data })); } catch {}
  }
  function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  async function readSnapshot() {
    const response = await originalFetch(`${SNAPSHOT_URL}?t=${Math.floor(Date.now() / 1800000)}`, { cache: 'no-store', mode: 'cors' });
    if (!response.ok) throw new Error(`SALE_SNAPSHOT_${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data?.items) || data.items.length < 1) throw new Error('SALE_SNAPSHOT_EMPTY');
    return data;
  }
  function snapshotData(snapshot) {
    const candidates = snapshot.items
      .filter(item => item?.title && Number(item?.regularPrice) > Number(item?.salePrice) && Number(item?.salePrice) > 0)
      .slice(0, MAX_CANDIDATES);
    return {
      items: [],
      candidates,
      page: 1,
      sourceUrl: snapshot.sourceUrl || 'https://books.rakuten.co.jp/',
      fetchedAt: snapshot.updatedAt || new Date().toISOString(),
      parsed: candidates.length,
      matched: 0,
      resolvedGenre: null,
      snapshot: true
    };
  }
  async function refresh(sourceRequest) {
    const snapshot = await readSnapshot();
    const data = snapshotData(snapshot);
    if (data.candidates.length) writeCache(sourceRequest, data);
    return jsonResponse(data);
  }

  window.fetch = async (input, init) => {
    if (!isSaleRequest(input)) return originalFetch(input, init);
    const cached = readCache(input);
    if (cached) {
      if (cached.age > REFRESH_AFTER) refresh(input).catch(() => {});
      return jsonResponse(cached.data);
    }
    try {
      return await refresh(input);
    } catch {
      const stale = readCache(input);
      if (stale) return jsonResponse(stale.data);
      try { return await originalFetch(input, init); }
      catch { return jsonResponse({ error: 'セール情報を取得できませんでした。少し時間をおいて再読み込みしてください。', detail: 'SALE_SNAPSHOT_UNAVAILABLE' }, 503); }
    }
  };
})();
