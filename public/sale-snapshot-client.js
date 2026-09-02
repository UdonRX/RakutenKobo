(() => {
  const previousFetch = window.fetch.bind(window);
  const DATA_URL = 'https://raw.githubusercontent.com/UdonRX/RakutenKobo/ranking-data/data/kobo-sale.json';
  const CACHE_KEY = 'kobo-completed-sale-v2';
  const CACHE_TTL = 12 * 60 * 60 * 1000;
  let activeFeed=null;

  function urlOf(input) {
    try { return new URL(typeof input === 'string' ? input : input?.url, location.origin); }
    catch { return null; }
  }
  function savedGenre() {
    try { return JSON.parse(localStorage.getItem('kobo-genre-by-tab-v1') || '{}')?.sale || ''; }
    catch { return ''; }
  }
  function isSale(input) {
    const url=urlOf(input);
    return url?.pathname==='/api/kobo' && url.searchParams.get('action')==='sales';
  }
  function saleGenre(input) {
    const url=urlOf(input);
    return url?.searchParams.get('genreKey') || savedGenre() || '';
  }
  function isResolve(input,init) {
    const url=urlOf(input);
    return url?.pathname==='/api/kobo' && url.searchParams.get('action')==='resolve' && String(init?.method||'GET').toUpperCase()==='POST';
  }
  function normalize(value='') {
    return String(value).normalize('NFKC').toLowerCase().replace(/[〜～]/g,'〜').replace(/[\s　・･:：!?！？()（）【】[\]「」『』〈〉《》#＃―ー\-]/g,'');
  }
  function response(data,status=200) {
    return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
  }
  function readCache() {
    try {
      const value=JSON.parse(localStorage.getItem(CACHE_KEY)||'null');
      if(!value?.ts||!value?.data)return null;
      if(Date.now()-Number(value.ts)>CACHE_TTL)return null;
      return value.data;
    } catch { return null; }
  }
  function writeCache(data) {
    try { localStorage.setItem(CACHE_KEY,JSON.stringify({ts:Date.now(),data})); } catch {}
  }
  async function readFeed() {
    const cached=readCache();
    try {
      const r=await previousFetch(`${DATA_URL}?t=${Math.floor(Date.now()/900000)}`,{cache:'no-store',mode:'cors'});
      if(!r.ok)throw new Error(`SALE_${r.status}`);
      const data=await r.json();
      if(!data?.completed||!Array.isArray(data.items)||!data.items.length)throw new Error('SALE_INCOMPLETE');
      writeCache(data);return data;
    } catch(error) {
      if(cached)return cached;
      throw error;
    }
  }
  function candidateFor(book) {
    const meta=book.matchMeta||{};
    return {
      title:meta.originalTitle||meta.title||book.title,
      originalTitle:meta.originalTitle||'',
      author:meta.author||book.author||'',
      itemNumber:meta.itemNumber||book.isbn||'',
      regularPrice:Number(book.regularPrice||meta.regularPrice||0),
      salePrice:Number(book.salePrice||meta.salePrice||book.price||0),
      discountPercent:Number(book.discountPercent||meta.discountPercent||0),
      saleEndAt:book.saleEndAt||meta.saleEndAt||'',
      saleCampaign:book.saleCampaign||meta.saleCampaign||'',
      sourceGenre:book.sourceGenre||meta.sourceGenre||''
    };
  }
  function findBook(candidate) {
    if(!activeFeed)return null;
    const titles=[candidate?.originalTitle,candidate?.title].filter(Boolean).map(normalize);
    const author=normalize(candidate?.author||'');
    for(const book of activeFeed.items||[]) {
      const meta=book.matchMeta||{};
      const bookTitles=[meta.originalTitle,meta.title,book.title].filter(Boolean).map(normalize);
      const bookAuthor=normalize(meta.author||book.author||'');
      if(titles.some(t=>bookTitles.includes(t)) && (!author||!bookAuthor||author===bookAuthor)) return book;
    }
    return null;
  }

  window.fetch = async (input,init) => {
    if(isSale(input)) {
      try {
        const feed=await readFeed();
        const genreKey=saleGenre(input);
        const hasGenreFeed=Boolean(genreKey)&&Array.isArray(feed?.byGenre?.[genreKey]);
        const selected=hasGenreFeed?feed.byGenre[genreKey]:(feed.items||[]);
        activeFeed={...feed,items:selected};
        return response({
          completed:true,
          genreKey,
          genreTarget:Number(feed.genreTarget||10),
          genreStatus:genreKey?feed?.genreStatus?.[genreKey]||null:null,
          candidates:selected.map(candidateFor),
          items:[],
          page:1,
          sourceUrl:feed.sourceUrl||'https://books.rakuten.co.jp/',
          fetchedAt:feed.updatedAt,
          parsed:Number(hasGenreFeed?selected.length:(feed.candidateCount||selected.length)),
          matched:selected.length
        });
      } catch {
        return response({error:'セール完成データを取得できませんでした。',detail:'SALE_COMPLETED_FEED_UNAVAILABLE'},503);
      }
    }

    if(isResolve(input,init)) {
      let body={};
      try { body=typeof init.body==='string'?JSON.parse(init.body):{}; } catch {}
      const items=Array.isArray(body.items)?body.items:[];
      const isSaleResolve=items.length>0 && items.some(item=>Number(item?.regularPrice)>0 && Number(item?.salePrice)>0);
      if(isSaleResolve) {
        const resolved=[];
        for(const candidate of items) {
          const book=findBook(candidate);
          if(book) resolved.push({...book,matchMeta:candidate});
        }
        return response({items:resolved,requested:items.length,matched:resolved.length,completed:true});
      }
    }

    return previousFetch(input,init);
  };
})();
