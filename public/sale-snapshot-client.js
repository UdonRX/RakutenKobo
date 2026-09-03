(() => {
  const previousFetch = window.fetch.bind(window);
  const DATA_URL = 'https://raw.githubusercontent.com/UdonRX/RakutenKobo/ranking-data/data/kobo-sale.json';
  let memoryFeed=null;
  let memoryStamp=0;

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
  function response(data,status=200) {
    return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
  }
  async function readFeed() {
    if(memoryFeed && Date.now()-memoryStamp<15*60*1000) return memoryFeed;
    const r=await previousFetch(`${DATA_URL}?t=${Math.floor(Date.now()/900000)}`,{cache:'default',mode:'cors'});
    if(!r.ok)throw new Error(`SALE_${r.status}`);
    const data=await r.json();
    if(!data?.completed||!data?.exhaustive||!Array.isArray(data.items))throw new Error('SALE_INCOMPLETE');
    memoryFeed=data;memoryStamp=Date.now();return data;
  }

  window.fetch = async (input,init) => {
    if(isSale(input)) {
      try {
        const feed=await readFeed();
        const genreKey=saleGenre(input);
        const hasGenreFeed=Boolean(genreKey)&&Array.isArray(feed?.byGenre?.[genreKey]);
        const selected=(hasGenreFeed?feed.byGenre[genreKey]:(feed.items||[])).filter(book=>book?.saleVerified);
        return response({
          completed:true,
          exhaustive:true,
          genreKey,
          genreStatus:genreKey?feed?.genreStatus?.[genreKey]||null:null,
          campaignCount:Number(feed.campaignCount||0),
          saleVerification:feed.saleVerification||'',
          candidates:[],
          items:selected,
          page:1,
          sourceUrl:feed.sourceUrl||'https://books.rakuten.co.jp/',
          officialSaleIndex:feed.officialSaleIndex||'',
          fetchedAt:feed.updatedAt,
          parsed:Number(feed.candidateCount||selected.length),
          matched:selected.length,
          verifiedByApi:Number(feed.verifiedByApi||0),
          verifiedByListing:Number(feed.verifiedByListing||0)
        });
      } catch {
        return response({error:'セール完成データを取得できませんでした。',detail:'SALE_COMPLETED_FEED_UNAVAILABLE'},503);
      }
    }
    return previousFetch(input,init);
  };
})();
