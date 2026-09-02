(() => {
  const originalFetch = window.fetch.bind(window);
  const SNAPSHOT_URL = 'https://raw.githubusercontent.com/UdonRX/RakutenKobo/ranking-data/data/amazon-ranking.json';

  function isWeeklyRankingRequest(input) {
    try {
      const value = typeof input === 'string' ? input : input?.url;
      const url = new URL(value, location.origin);
      return url.pathname === '/api/kobo'
        && url.searchParams.get('action') === 'rankings'
        && (url.searchParams.get('period') || 'week') === 'week';
    } catch {
      return false;
    }
  }

  async function readAmazonSnapshot() {
    try {
      const response = await originalFetch(`${SNAPSHOT_URL}?t=${Math.floor(Date.now() / 1800000)}`, {
        cache: 'no-store',
        mode: 'cors'
      });
      if (!response.ok) return null;
      const data = await response.json();
      if (!Array.isArray(data?.items) || data.items.length < 1) return null;
      return data;
    } catch {
      return null;
    }
  }

  window.fetch = async (input, init) => {
    if (!isWeeklyRankingRequest(input)) return originalFetch(input, init);

    const [baseResponse, amazon] = await Promise.all([
      originalFetch(input, init),
      readAmazonSnapshot()
    ]);

    if (!baseResponse.ok || !amazon) return baseResponse;

    try {
      const data = await baseResponse.clone().json();
      data.snapshots = { ...(data.snapshots || {}), amazon };
      data.unavailable = (data.unavailable || []).filter(id => id !== 'amazon');
      return new Response(JSON.stringify(data), {
        status: baseResponse.status,
        statusText: baseResponse.statusText,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store'
        }
      });
    } catch {
      return baseResponse;
    }
  };
})();
