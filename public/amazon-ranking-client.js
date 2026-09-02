(() => {
  const nativeFetch = window.fetch.bind(window);
  const DATA_BASE = 'https://raw.githubusercontent.com/UdonRX/RakutenKobo/ranking-data/data';
  const CACHE_PREFIX = 'kobo-completed-popular-v1:';
  const CACHE_TTL = 12 * 60 * 60 * 1000;
  const activeFeeds = new Map();

  try {
    // Dynamic ranking/feed caches can bypass the completed JSON loader on a new page load.
    // Clear them every session; completed JSON has its own local cache below.
    localStorage.removeItem('kobo-feed-cache-v3');
    localStorage.removeItem('kobo-ranking-cache-v2');
    localStorage.removeItem('kobo-sale-snapshot-response-v3:all');
    localStorage.setItem('kobo-completed-feed-migration-v1', '1');
  } catch {}

  function urlOf(input) {
    try { return new URL(typeof input === 'string' ? input : input?.url, location.origin); }
    catch { return null; }
  }
  function rankingPeriod(input) {
    const url=urlOf(input);
    if(url?.pathname!=='/api/kobo' || url.searchParams.get('action')!=='rankings') return null;
    return url.searchParams.get('period') || 'week';
  }
  function isResolve(input,init) {
    const url=urlOf(input);
    return url?.pathname==='/api/kobo' && url.searchParams.get('action')==='resolve' && String(init?.method||'GET').toUpperCase()==='POST';
  }
  function normalize(value='') {
    return String(value).normalize('NFKC').toLowerCase().replace(/[〜～]/g,'〜').replace(/[\s　・･:：!?！？()（）【】[\]「」『』〈〉《》#＃―ー\-]/g,'');
  }
  function lookupKeys(item) {
    const titles=[item?.originalTitle,item?.title].filter(Boolean).map(normalize).filter(Boolean);
    const author=normalize(item?.author||'');
    return [...new Set(titles.flatMap(t=>[`${t}|${author}`,t]))];
  }
  function feedMaps(feed) {
    const exact=new Map(), titleOnly=new Map();
    for(const book of feed?.items||[]) {
      const meta=book.matchMeta||book.ranking||{};
      const author=normalize(meta.author||book.author||'');
      for(const raw of [meta.originalTitle,meta.title,book.title]) {
        const title=normalize(raw||''); if(!title) continue;
        exact.set(`${title}|${author}`,book);
        if(!titleOnly.has(title)) titleOnly.set(title,book);
      }
    }
    return {exact,titleOnly};
  }
  function findBook(feed,candidate) {
    const maps=feedMaps(feed);
    const keys=lookupKeys(candidate);
    for(const key of keys) {
      const hit=key.includes('|')?maps.exact.get(key):maps.titleOnly.get(key);
      if(hit) return hit;
    }
    return null;
  }
  function response(data,status=200) {
    return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
  }
  function cacheKey(period){return `${CACHE_PREFIX}${period}`}
  function readCache(period) {
    try {
      const value=JSON.parse(localStorage.getItem(cacheKey(period))||'null');
      if(!value?.ts||!value?.data)return null;
      if(Date.now()-Number(value.ts)>CACHE_TTL)return null;
      return value.data;
    } catch { return null; }
  }
  function writeCache(period,data) {
    try { localStorage.setItem(cacheKey(period),JSON.stringify({ts:Date.now(),data})); } catch {}
  }
  async function readFeed(period) {
    const cached=readCache(period);
    try {
      const r=await nativeFetch(`${DATA_BASE}/popular-${period}.json?t=${Math.floor(Date.now()/900000)}`,{cache:'no-store',mode:'cors'});
      if(!r.ok)throw new Error(`POPULAR_${r.status}`);
      const data=await r.json();
      if(!data?.completed||!Array.isArray(data.items)||!data.items.length)throw new Error('POPULAR_INCOMPLETE');
      writeCache(period,data); activeFeeds.set(period,data); return data;
    } catch(error) {
      if(cached){activeFeeds.set(period,cached);return cached}
      throw error;
    }
  }

  window.fetch = async (input, init) => {
    const period=rankingPeriod(input);
    if(period) {
      try {
        const feed=await readFeed(period);
        return response({
          period,
          completed:true,
          snapshots:feed.snapshots||{},
          unavailable:feed.unavailable||[],
          fetchedAt:feed.updatedAt,
          completedMatched:feed.matched||feed.items.length
        });
      } catch {
        return response({error:'人気ランキングの準備データを取得できませんでした。',detail:'POPULAR_COMPLETED_FEED_UNAVAILABLE'},503);
      }
    }

    if(isResolve(input,init)) {
      let body={};
      try { body=typeof init.body==='string'?JSON.parse(init.body):{}; } catch {}
      const items=Array.isArray(body.items)?body.items:[];
      const isPopular=items.length>0 && items.some(item=>Array.isArray(item?.sources)||item?.source==='combined'||item?.source);
      if(isPopular) {
        const feeds=[...activeFeeds.values()].reverse();
        if(!feeds.length) return response({items:[],requested:items.length,matched:0,completed:true});
        const resolved=[];
        for(const candidate of items) {
          let book=null;
          for(const feed of feeds) {
            book=findBook(feed,candidate);
            if(book) break;
          }
          if(book) resolved.push({...book,matchMeta:candidate});
        }
        return response({items:resolved,requested:items.length,matched:resolved.length,completed:true});
      }
    }

    return nativeFetch(input,init);
  };
})();
