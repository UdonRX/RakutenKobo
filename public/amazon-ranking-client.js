(() => {
  const nativeFetch = window.fetch.bind(window);
  const DATA_BASE = '/data';
  const CACHE_PREFIX = 'kobo-completed-popular-v3:';
  const CACHE_TTL = 12 * 60 * 60 * 1000;
  const activeFeeds = new Map();

  try {
    for (const period of ['week','month','year']) localStorage.removeItem(`kobo-completed-popular-v2:${period}`);
    localStorage.removeItem('kobo-feed-cache-v4');
    localStorage.removeItem('kobo-ranking-cache-v2');
    localStorage.setItem('kobo-completed-feed-migration-v3', '1');
  } catch {}

  function urlOf(input) {
    try { return new URL(typeof input === 'string' ? input : input?.url, location.origin); }
    catch { return null; }
  }
  function savedGenre(tab) {
    try { return JSON.parse(localStorage.getItem('kobo-genre-by-tab-v1') || '{}')?.[tab] || ''; }
    catch { return ''; }
  }
  function rankingRequest(input) {
    const url=urlOf(input);
    if(url?.pathname!=='/api/kobo' || url.searchParams.get('action')!=='rankings') return null;
    return {period:url.searchParams.get('period') || 'week',genreKey:url.searchParams.get('genreKey') || savedGenre('popular') || ''};
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
      const meta=book.matchMeta||book.ranking||{},author=normalize(meta.author||book.author||'');
      for(const raw of [meta.originalTitle,meta.title,book.title]) {
        const title=normalize(raw||'');if(!title)continue;exact.set(`${title}|${author}`,book);if(!titleOnly.has(title))titleOnly.set(title,book);
      }
    }
    return {exact,titleOnly};
  }
  function findBook(feed,candidate) {
    const maps=feedMaps(feed);
    for(const key of lookupKeys(candidate)) { const hit=key.includes('|')?maps.exact.get(key):maps.titleOnly.get(key);if(hit)return hit; }
    return null;
  }
  function response(data,status=200) {return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}})}
  function cacheKey(period){return `${CACHE_PREFIX}${period}`}
  function readCache(period) {try{const v=JSON.parse(localStorage.getItem(cacheKey(period))||'null');if(!v?.ts||!v?.data||Date.now()-Number(v.ts)>CACHE_TTL)return null;return v.data}catch{return null}}
  function writeCache(period,data) {try{localStorage.setItem(cacheKey(period),JSON.stringify({ts:Date.now(),data}))}catch{}}
  async function readFeed(period) {
    const cached=readCache(period);
    try {
      const r=await nativeFetch(`${DATA_BASE}/popular-${period}.json?t=${Math.floor(Date.now()/900000)}`,{cache:'no-store'});
      if(!r.ok)throw new Error(`POPULAR_${r.status}`);const data=await r.json();
      if(!data?.completed||!Array.isArray(data.items)||!data.items.length)throw new Error('POPULAR_INCOMPLETE');
      writeCache(period,data);return data;
    } catch(error) {if(cached)return cached;throw error}
  }
  function selectedItems(feed,genreKey) {if(genreKey&&Array.isArray(feed?.byGenre?.[genreKey]))return feed.byGenre[genreKey];return feed.items||[]}
  function candidateFromBook(book) {
    const meta=book.ranking||book.matchMeta||{};
    return {title:meta.originalTitle||meta.title||book.title,originalTitle:meta.originalTitle||'',author:meta.author||book.author||'',source:meta.source||'kobo',sources:Array.isArray(meta.sources)&&meta.sources.length?meta.sources:[{source:'kobo',label:'楽天Kobo人気',rank:meta.rank||0}],rank:Number(meta.rank||0)};
  }
  function snapshotsFor(feed,items) {
    const grouped=new Map();
    for(const book of items||[])for(const sourceInfo of candidateFromBook(book).sources||[]){const c=candidateFromBook(book),source=sourceInfo.source||'kobo';if(!grouped.has(source))grouped.set(source,[]);grouped.get(source).push({title:c.title,author:c.author,rank:Number(sourceInfo.rank||c.rank||grouped.get(source).length+1)})}
    const out={};
    for(const [source,rows] of grouped){rows.sort((a,b)=>a.rank-b.rank);const base=feed?.snapshots?.[source]||{};out[source]={id:source,label:base.label||(source==='kobo'?'楽天Kobo人気':source),attribution:base.attribution||(source==='kobo'?'楽天Kobo':source),sourceUrl:base.sourceUrl||(source==='kobo'?'https://books.rakuten.co.jp/e-book/':''),periodLabel:base.periodLabel||(source==='kobo'?'人気補完':''),updatedAt:feed.updatedAt,live:false,items:rows}}
    return out;
  }

  window.fetch = async (input, init) => {
    const req=rankingRequest(input);
    if(req) {
      try {
        const feed=await readFeed(req.period),items=selectedItems(feed,req.genreKey),active={...feed,items};activeFeeds.set(`${req.period}:${req.genreKey||'all'}`,active);
        return response({period:req.period,completed:true,genreKey:req.genreKey,genreStatus:req.genreKey?feed?.genreStatus?.[req.genreKey]||null:null,snapshots:snapshotsFor(feed,items),unavailable:feed.unavailable||[],fetchedAt:feed.updatedAt,completedMatched:items.length,candidateCount:Number(feed.candidateCount||0),expandedAllPublishedRanks:Boolean(feed.expandedAllPublishedRanks)});
      } catch {return response({error:'人気ランキングの準備データを取得できませんでした。',detail:'POPULAR_COMPLETED_FEED_UNAVAILABLE'},503)}
    }
    if(isResolve(input,init)) {
      let body={};try{body=typeof init.body==='string'?JSON.parse(init.body):{}}catch{}
      const items=Array.isArray(body.items)?body.items:[],isPopular=items.length>0&&items.some(item=>Array.isArray(item?.sources)||item?.source==='combined'||item?.source);
      if(isPopular) {
        const feeds=[...activeFeeds.values()].reverse();if(!feeds.length)return response({items:[],requested:items.length,matched:0,completed:true});
        const resolved=[];for(const candidate of items){let book=null;for(const feed of feeds){book=findBook(feed,candidate);if(book)break}if(book)resolved.push({...book,matchMeta:candidate})}
        return response({items:resolved,requested:items.length,matched:resolved.length,completed:true});
      }
    }
    return nativeFetch(input,init);
  };
})();
