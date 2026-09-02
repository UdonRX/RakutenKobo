import { GENRES, AWARD_BOOKS } from './catalog.js';
import { layout, popularView, newView, saleView, awardView } from './ui.js';

const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
const load=(k,f)=>{try{return JSON.parse(localStorage.getItem(k)||JSON.stringify(f))}catch{return f}};
const save=(k,v)=>localStorage.setItem(k,JSON.stringify(v));
const normalize=(v='')=>String(v).normalize('NFKC').toLowerCase().replace(/[\s　・･:：!?！？()（）【】\[\]「」『』〈〉《》#＃―ー\-]/g,'');
const FEED_CACHE_TTL=6*60*60*1000;
const FEED_REFRESH_AFTER=30*60*1000;
const RANKING_CACHE_TTL=6*60*60*1000;
const RESOLVE_BATCH_SIZE=4;
const TARGET_BOOKS=30;
const MAX_CANDIDATES=60;

const HONTAI_2024 = [
  ['水車小屋のネネ','津村記久子','2位',2],
  ['存在のすべてを','塩田武士','3位',3],
  ['スピノザの診察室','夏川草介','4位',4],
  ['レーエンデ国物語','多崎礼','5位',5],
  ['黄色い家','川上未映子','6位',6],
  ['リカバリー・カバヒコ','青山美智子','7位',7],
  ['星を編む','凪良ゆう','8位',8],
  ['放課後ミステリクラブ 1 金魚の泳ぐプール事件','知念実希人','9位',9],
  ['君が手にするはずだった黄金について','小川哲','10位',10]
].map(([title,author,status,rank])=>({award:'hontai',year:2024,title,author,status,edition:'第21回',rank}));
const AWARD_DATA = [...AWARD_BOOKS, ...HONTAI_2024].filter((item,index,list)=>list.findIndex(other=>other.award===item.award&&other.year===item.year&&normalize(other.title)===normalize(item.title))===index);

const genreByTab=load('kobo-genre-by-tab-v1',{popular:null,new:null,sale:null,awards:null});
const state={
  tab:'popular',period:'week',source:'combined',award:'hontai',awardYear:null,
  genre:genreByTab.popular||null,genreByTab,genreResolved:null,genreSheetOpen:false,
  selected:null,searchOpen:false,favoritesOpen:false,listMode:'favorites',
  favorites:load('kobo-favorites-v1',[]),watchList:load('kobo-price-watch-v1',[]),watchLoading:false,
  priceHistory:load('kobo-price-history-v1',{}),
  searchMode:'title',sort:'standard',query:'',books:[],saleBooks:[],saleSort:'recommended',saleMeta:null,
  loading:false,error:'',popularMeta:null,rankingData:{},rankingPeriod:null,rankingUnavailable:[]
};
let requestToken=0, watchRequestToken=0, searchTimer=null;
const chipScroll=load('kobo-chip-scroll-v1',{});
const feedCache=load('kobo-feed-cache-v4',{});
const rankingCache=load('kobo-ranking-cache-v2',{});

function readCache(store,key,ttl){
  const entry=store?.[key];if(!entry||!entry.ts)return null;
  const age=Date.now()-Number(entry.ts);if(age<0||age>ttl)return null;
  return {...entry,age};
}
function writeCache(store,storageKey,key,value){store[key]={ts:Date.now(),...value};save(storageKey,store)}
function popularCacheKey(){return `popular:${state.period}:${state.source}:${state.genre||'all'}`}
function newCacheKey(){return `new:${state.genre||'all'}`}
function saleCacheKey(){return `sale:${state.genre||'all'}`}

async function api(params){
  let response;
  if(params.action==='resolve'){
    response=await fetch('/api/kobo?action=resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:JSON.parse(params.items||'[]')})});
  }else response=await fetch('/api/kobo?'+new URLSearchParams(params));
  const data=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(data.detail||data.error||'データを取得できませんでした');
  return data;
}

function dedupe(list){
  const seen=new Set();
  return list.filter(book=>{
    const id=String(book?.id||book?.isbn||'').trim();
    const key=id?`id:${id}`:`title:${normalize(book?.title)}|${normalize(book?.author)}`;
    if(!key||seen.has(key))return false;
    seen.add(key);return true;
  });
}
function fav(id){return state.favorites.some(book=>book.id===id)}
function watched(id){return state.watchList.some(book=>book.id===id)}
function toggleFav(book){state.favorites=fav(book.id)?state.favorites.filter(item=>item.id!==book.id):[book,...state.favorites].slice(0,100);save('kobo-favorites-v1',state.favorites);render()}
function toggleWatch(book){
  if(!book?.id)return;
  if(watched(book.id)) state.watchList=state.watchList.filter(item=>item.id!==book.id);
  else {
    const baselinePrice=Number(book.salePrice||book.price||0);
    state.watchList=[{...book,baselinePrice,watchedAt:new Date().toISOString()},...state.watchList].slice(0,50);
  }
  save('kobo-price-watch-v1',state.watchList);render();
}

function historyKey(book){return String(book?.id||book?.isbn||`${normalize(book?.title)}|${normalize(book?.author)}`)}
function recordPrices(books){
  if(!Array.isArray(books)||!books.length)return;
  const next={...state.priceHistory},now=new Date().toISOString();
  for(const book of books){
    const price=Number(book.salePrice||book.price||0);if(!price)continue;
    const key=historyKey(book),prev=next[key]||{};
    next[key]={min:prev.min?Math.min(Number(prev.min),price):price,last:price,regular:Number(book.regularPrice||prev.regular||0),seenAt:now};
  }
  state.priceHistory=next;save('kobo-price-history-v1',next);
}

function awardYears(){return [...new Set(AWARD_DATA.filter(item=>item.award===state.award).map(item=>item.year))].sort((a,b)=>b-a)}
function ensureAwardYear(){const years=awardYears();if(!years.includes(Number(state.awardYear)))state.awardYear=years[0]||null}
function statusPriority(item){const s=item.status||'';if(s.includes('大賞')||s.includes('受賞'))return item.rank||0;if(item.rank)return item.rank;if(s.includes('候補')||s.includes('ノミネート'))return 20;return 30}

function activeGenreConfig(){return GENRES.find(item=>item.id===state.genre)||null}
function genreParams(){
  const genre=activeGenreConfig();if(!genre)return {};
  return {genreKey:genre.id,genreNames:genre.names.join('|'),parentNames:genre.parentNames.join('|'),fallbackQuery:genre.fallbackQuery,excludeLightNovel:genre.excludeLightNovel?'1':'0'};
}
function matchesGenreId(book,resolvedId){return String(book.genreId||'').split('/').map(x=>x.trim()).filter(Boolean).some(id=>id===resolvedId||id.startsWith(resolvedId))}
async function activeGenreId(){
  const genre=activeGenreConfig();if(!genre)return '';
  if(state.genreResolved?.id)return state.genreResolved.id;
  try{
    const data=await api({action:'genre-resolve',genreKey:genre.id,genreNames:genre.names.join('|'),parentNames:genre.parentNames.join('|')});
    state.genreResolved=data.resolvedGenre||null;
    return state.genreResolved?.id||'';
  }catch{return ''}
}
async function filterByActiveGenre(books){
  const id=await activeGenreId();
  return id?books.filter(book=>matchesGenreId(book,id)):books;
}

function rankingSeeds(){
  const bucket=state.rankingData||{};
  if(state.source!=='combined') return (bucket[state.source]?.items||[]).map(item=>({...item,source:state.source,sources:[{source:state.source,label:bucket[state.source]?.label||state.source,rank:item.rank}]}));
  const merged=new Map();
  for(const [source,snap] of Object.entries(bucket)) for(const item of snap.items||[]){
    const key=`${normalize(item.title)}|${normalize(item.author)}`;
    const cur=merged.get(key)||{title:item.title,author:item.author,score:0,sources:[]};
    cur.score+=Math.max(5,110-Number(item.rank||30)*4);
    cur.sources.push({source,label:snap.label||source,rank:item.rank});merged.set(key,cur);
  }
  return [...merged.values()].sort((a,b)=>b.score-a.score||b.sources.length-a.sources.length).map((item,index)=>({...item,rank:index+1,source:'combined'}));
}

function simplifyResolveTitle(value=''){
  const full=String(value||'').normalize('NFKC').replace(/[〜～]/g,'〜').replace(/\s+/g,' ').trim();
  return full
    .replace(/\s*[（(][^）)]*(?:コミックス|コミック|DIGITAL|電子|文庫|新書|単行本|BOOKS?)[^）)]*[）)]\s*$/iu,'')
    .replace(/\s*\[[^\]]*(?:電子|DIGITAL|コミック)[^\]]*\]\s*$/iu,'')
    .trim()||full;
}
function resolveCandidate(item){
  const originalTitle=String(item?.title||'').trim();
  const title=simplifyResolveTitle(originalTitle);
  return {...item,title,originalTitle:originalTitle!==title?originalTitle:(item?.originalTitle||'')};
}
async function requestResolveChunk(chunk){
  let firstError=null;
  for(let attempt=0;attempt<2;attempt++){
    try{return await api({action:'resolve',items:JSON.stringify(chunk)})}
    catch(error){firstError=firstError||error;if(attempt===0)await new Promise(resolve=>setTimeout(resolve,180))}
  }
  throw firstError||new Error('Kobo照合に失敗しました');
}
async function resolveUntilTarget(entries,{target=TARGET_BOOKS,maxCandidates=MAX_CANDIDATES,genreId='',onProgress}={}){
  const candidates=(entries||[]).slice(0,maxCandidates).map(resolveCandidate);
  let visible=[],checked=0,rawMatched=0,failedBatches=0,lastError=null;
  for(let i=0;i<candidates.length&&visible.length<target;i+=RESOLVE_BATCH_SIZE){
    const chunk=candidates.slice(i,i+RESOLVE_BATCH_SIZE);
    checked+=chunk.length;
    try{
      const data=await requestResolveChunk(chunk);
      rawMatched+=Number(data.matched||(data.items||[]).length);
      const accepted=(data.items||[]).filter(book=>!genreId||matchesGenreId(book,genreId));
      visible=dedupe([...visible,...accepted]).slice(0,target);
    }catch(error){failedBatches+=1;lastError=error}
    if(onProgress)await onProgress({items:visible,checked,total:candidates.length,rawMatched,failedBatches,done:visible.length>=target||checked>=candidates.length});
  }
  if(!visible.length&&lastError)throw lastError;
  return {items:visible,checked,total:candidates.length,rawMatched,failedBatches};
}

async function resolveMetadata(entries){
  if(!entries.length)return {items:[],requested:0,matched:0};
  const out=[];let requested=0,matched=0,lastError=null;
  for(let i=0;i<entries.length;i+=RESOLVE_BATCH_SIZE){
    const chunk=entries.slice(i,i+RESOLVE_BATCH_SIZE).map(resolveCandidate);
    try{
      const data=await requestResolveChunk(chunk);
      out.push(...(data.items||[]));requested+=chunk.length;matched+=Number(data.matched||(data.items||[]).length);
    }catch(error){requested+=chunk.length;lastError=error}
  }
  const items=dedupe(out);
  if(!items.length&&lastError)throw lastError;
  return {items,requested,matched};
}

async function ensureRankingData(force=false){
  if(!force&&state.rankingPeriod===state.period&&Object.keys(state.rankingData||{}).length)return;
  const cached=readCache(rankingCache,state.period,RANKING_CACHE_TTL);
  if(!force&&cached?.snapshots&&Object.keys(cached.snapshots).length){
    state.rankingData=cached.snapshots;state.rankingPeriod=state.period;state.rankingUnavailable=cached.unavailable||[];
    const ids=['combined',...Object.keys(state.rankingData)];if(!ids.includes(state.source))state.source='combined';
    return;
  }
  const data=await api({action:'rankings',period:state.period,...genreParams()});
  state.rankingData=data.snapshots||{};state.rankingPeriod=state.period;state.rankingUnavailable=data.unavailable||[];
  writeCache(rankingCache,'kobo-ranking-cache-v2',state.period,{snapshots:state.rankingData,unavailable:state.rankingUnavailable});
  const ids=['combined',...Object.keys(state.rankingData)];if(!ids.includes(state.source))state.source='combined';
}

async function loadPopular({refreshRankings=false}={}){
  const token=++requestToken,key=popularCacheKey(),cached=readCache(feedCache,key,FEED_CACHE_TTL);
  state.error='';state.popularMeta=null;
  if(cached?.books?.length>=2){
    state.books=cached.books;state.popularMeta=cached.meta||null;state.loading=false;render();recordPrices(state.books);
    if(!refreshRankings&&cached.age<FEED_REFRESH_AFTER)return;
  }else{state.loading=true;state.books=[];render()}
  try{
    await ensureRankingData(refreshRankings);
    if(token!==requestToken)return;
    const seeds=rankingSeeds().slice(0,MAX_CANDIDATES),genreId=await activeGenreId();
    const result=await resolveUntilTarget(seeds,{genreId,onProgress:async progress=>{
      if(token!==requestToken)return;
      const books=progress.items.map((book,index)=>({...book,ranking:{...(book.matchMeta||{}),rank:index+1}}));
      state.books=books;state.loading=books.length?false:!progress.done;state.error='';
      state.popularMeta={candidates:seeds.length,checked:progress.checked,matched:books.length,rawMatched:progress.rawMatched,failedBatches:progress.failedBatches};
      if(books.length){recordPrices(books);writeCache(feedCache,'kobo-feed-cache-v4',key,{books,meta:state.popularMeta})}
      render();
    }});
    if(token===requestToken&&!result.items.length)state.books=[];
  }catch(error){if(token===requestToken&&!state.books.length)state.error=error.message}
  finally{if(token===requestToken){state.loading=false;render()}}
}

async function loadNew(){
  const token=++requestToken,key=newCacheKey(),cached=readCache(feedCache,key,3*60*60*1000);
  state.error='';
  if(cached?.books?.length){state.books=cached.books;state.loading=false;render();recordPrices(state.books);if(cached.age<FEED_REFRESH_AFTER)return}
  else{state.loading=true;state.books=[];render()}
  try{const data=await api({action:'search',...genreParams(),sort:'-releaseDate',hits:'30'});if(token===requestToken){state.books=data.items||[];state.genreResolved=data.resolvedGenre||null;recordPrices(state.books);writeCache(feedCache,'kobo-feed-cache-v4',key,{books:state.books})}}
  catch(error){if(token===requestToken&&!state.books.length)state.error=error.message}
  finally{if(token===requestToken){state.loading=false;render()}}
}

function sortSaleBooks(list){
  const books=[...list];
  if(state.saleSort==='discount')return books.sort((a,b)=>Number(b.discountPercent||0)-Number(a.discountPercent||0));
  if(state.saleSort==='price')return books.sort((a,b)=>Number(a.salePrice||a.price||Infinity)-Number(b.salePrice||b.price||Infinity));
  if(state.saleSort==='ending')return books.sort((a,b)=>{const at=a.saleEndAt?new Date(a.saleEndAt).getTime():Infinity,bt=b.saleEndAt?new Date(b.saleEndAt).getTime():Infinity;return at-bt});
  return books;
}
function saleBook(book){
  const meta=book.matchMeta||{};
  return {...book,price:Number(meta.salePrice||book.price||0),regularPrice:Number(meta.regularPrice||0),salePrice:Number(meta.salePrice||book.price||0),discountPercent:Number(meta.discountPercent||0),saleEndAt:meta.saleEndAt||'',saleCampaign:meta.saleCampaign||'',sourceGenre:meta.sourceGenre||''};
}

async function loadSale(){
  const token=++requestToken,key=saleCacheKey(),cached=readCache(feedCache,key,FEED_CACHE_TTL);
  state.error='';state.saleMeta=null;
  if(cached?.books?.length>=2){state.saleBooks=cached.books;state.books=sortSaleBooks(state.saleBooks);state.saleMeta=cached.meta||null;state.loading=false;render();recordPrices(state.saleBooks);if(cached.age<60*60*1000)return}
  else{state.loading=true;state.books=[];state.saleBooks=[];render()}
  try{
    const data=await api({action:'sales',...genreParams(),page:'1'});
    if(token!==requestToken)return;
    const candidates=Array.isArray(data.candidates)?data.candidates.slice(0,MAX_CANDIDATES):[];
    if(candidates.length){
      const genreId=await activeGenreId();
      await resolveUntilTarget(candidates,{genreId,onProgress:async progress=>{
        if(token!==requestToken)return;
        const books=progress.items.map(saleBook);
        state.saleBooks=books;state.books=sortSaleBooks(books);state.loading=books.length?false:!progress.done;state.error='';
        state.saleMeta={fetchedAt:data.fetchedAt,sourceUrl:data.sourceUrl,parsed:Number(data.parsed||candidates.length),checked:progress.checked,matched:books.length,rawMatched:progress.rawMatched,failedBatches:progress.failedBatches};
        if(books.length){recordPrices(books);writeCache(feedCache,'kobo-feed-cache-v4',key,{books,meta:state.saleMeta})}
        render();
      }});
    }else{
      const books=dedupe(data.items||[]).slice(0,TARGET_BOOKS);
      state.saleBooks=books;state.books=sortSaleBooks(books);state.saleMeta={fetchedAt:data.fetchedAt,sourceUrl:data.sourceUrl,parsed:data.parsed,matched:books.length};state.genreResolved=data.resolvedGenre||null;recordPrices(books);
      if(books.length)writeCache(feedCache,'kobo-feed-cache-v4',key,{books,meta:state.saleMeta});
    }
  }catch(error){if(token===requestToken&&!state.books.length)state.error=error.message}
  finally{if(token===requestToken){state.loading=false;render()}}
}

async function loadAward(){
  ensureAwardYear();const token=++requestToken;state.loading=true;state.error='';state.books=[];render();
  const entries=AWARD_DATA.filter(item=>item.award===state.award&&item.year===Number(state.awardYear)).sort((a,b)=>statusPriority(a)-statusPriority(b));
  try{
    const resolvedData=await resolveMetadata(entries);let books=resolvedData.items.map(book=>({...book,awardMeta:book.matchMeta}));books=await filterByActiveGenre(books);
    if(token===requestToken){state.books=books;recordPrices(books)}
  }catch(error){if(token===requestToken)state.error=error.message}
  finally{if(token===requestToken){state.loading=false;render()}}
}

async function refreshWatchList(){
  if(!state.watchList.length)return;
  const token=++watchRequestToken;state.watchLoading=true;render();
  try{
    const entries=state.watchList.slice(0,12).map(item=>({title:item.title,author:item.author,itemNumber:item.isbn||(/^[0-9]+$/.test(String(item.id))?item.id:''),watchId:item.id}));
    const data=await resolveMetadata(entries);const matched=new Map((data.items||[]).map(book=>[String(book.matchMeta?.watchId||book.id),book]));
    state.watchList=state.watchList.map(item=>{
      const live=matched.get(String(item.id));if(!live)return item;
      const baseline=Number(item.baselinePrice||item.regularPrice||item.price||0),current=Number(live.price||0);
      return {...item,...live,baselinePrice:baseline,currentPrice:current,regularPrice:baseline&&current<baseline?baseline:0,salePrice:baseline&&current<baseline?current:0,discountPercent:baseline&&current<baseline?Math.max(1,Math.round((1-current/baseline)*100)):0,watchDrop:baseline&&current<baseline?baseline-current:0};
    });
    save('kobo-price-watch-v1',state.watchList);recordPrices(state.watchList);
  }catch{}finally{if(token===watchRequestToken){state.watchLoading=false;render()}}
}

function currentView(){
  if(state.tab==='popular')return popularView(state);
  if(state.tab==='new')return newView(state);
  if(state.tab==='sale')return saleView(state);
  return awardView(state,awardYears());
}

function captureChipScroll(){ $$('[data-scroll-key]').forEach(el=>{chipScroll[el.dataset.scrollKey]=el.scrollLeft});save('kobo-chip-scroll-v1',chipScroll) }
function restoreChipScroll(){ $$('[data-scroll-key]').forEach(el=>{const value=Number(chipScroll[el.dataset.scrollKey]||0);if(value)el.scrollLeft=value}) }
function render(){captureChipScroll();document.querySelector('#app').innerHTML=layout(state,currentView(),load('kobo-search-history-v1',[]));bind();requestAnimationFrame(restoreChipScroll)}
function overlayBooks(){return state.favoritesOpen?(state.listMode==='watch'?state.watchList:state.favorites):state.books}
function reloadCurrent(){if(state.tab==='popular')loadPopular();else if(state.tab==='new')loadNew();else if(state.tab==='sale')loadSale();else loadAward()}

function bind(){
  $$('[data-tab]').forEach(button=>button.onclick=()=>{state.tab=button.dataset.tab;state.genre=state.genreByTab[state.tab]||null;state.genreResolved=null;state.genreSheetOpen=false;state.books=[];state.error='';if(state.tab==='awards')ensureAwardYear();render();if(state.tab==='popular')loadPopular();if(state.tab==='new')loadNew();if(state.tab==='sale')loadSale();if(state.tab==='awards')loadAward()});
  $('[data-action="search"]')?.addEventListener('click',()=>{state.searchOpen=true;state.books=[];state.error='';render();setTimeout(()=>$('#search-input')?.focus(),30)});
  $('[data-action="favorites"]')?.addEventListener('click',()=>{state.favoritesOpen=true;state.listMode='favorites';render()});
  $('[data-close-favorites]')?.addEventListener('click',()=>{state.favoritesOpen=false;render()});
  $$('[data-list-mode]').forEach(button=>button.onclick=()=>{state.listMode=button.dataset.listMode;render();if(state.listMode==='watch')refreshWatchList()});
  $('[data-action="genres"]')?.addEventListener('click',()=>{state.genreSheetOpen=true;render()});
  $$('[data-close-genres]').forEach(item=>item.onclick=()=>{state.genreSheetOpen=false;render()});
  $$('[data-genre-option]').forEach(button=>button.onclick=event=>{event.stopPropagation();const id=button.dataset.genreOption||null;state.genre=id;state.genreByTab[state.tab]=id;save('kobo-genre-by-tab-v1',state.genreByTab);state.genreResolved=null;state.genreSheetOpen=false;state.books=[];state.saleBooks=[];render();if(state.tab==='popular')loadPopular({refreshRankings:true});else reloadCurrent()});
  $$('[data-period]').forEach(button=>button.onclick=()=>{state.period=button.dataset.period;state.source='combined';loadPopular({refreshRankings:true})});
  $$('[data-source]').forEach(button=>button.onclick=()=>{state.source=button.dataset.source;loadPopular()});
  $$('[data-sale-sort]').forEach(button=>button.onclick=()=>{state.saleSort=button.dataset.saleSort;state.books=sortSaleBooks(state.saleBooks);render()});
  $$('[data-award]').forEach(button=>button.onclick=()=>{state.award=button.dataset.award;state.awardYear=null;chipScroll['award-year-tabs']=0;ensureAwardYear();loadAward()});
  $$('[data-award-year]').forEach(button=>button.onclick=()=>{state.awardYear=Number(button.dataset.awardYear);loadAward()});
  $$('[data-open]').forEach(button=>button.onclick=()=>{state.selected=overlayBooks()[Number(button.dataset.open)];render()});
  $$('[data-fav]').forEach(button=>button.onclick=event=>{event.stopPropagation();toggleFav(overlayBooks()[Number(button.dataset.fav)])});
  $('[data-detail-fav]')?.addEventListener('click',()=>toggleFav(state.selected));
  $('[data-detail-watch]')?.addEventListener('click',()=>toggleWatch(state.selected));
  $$('[data-close-detail]').forEach(item=>item.onclick=()=>{state.selected=null;render()}); $('[data-stop]')?.addEventListener('click',event=>event.stopPropagation());
  $('[data-close-search]')?.addEventListener('click',()=>{state.searchOpen=false;state.query='';state.books=[];state.error='';render();reloadCurrent()});
  $$('[data-search-mode]').forEach(button=>button.onclick=()=>{state.searchMode=button.dataset.searchMode;runSearch()});
  $('#sort-select')?.addEventListener('change',event=>{state.sort=event.target.value;runSearch()});
  $('#search-input')?.addEventListener('input',event=>{state.query=event.target.value;clearTimeout(searchTimer);searchTimer=setTimeout(runSearch,350)});
  $$('[data-history]').forEach(button=>button.onclick=()=>{state.query=button.dataset.history;render();runSearch()});
}

async function runSearch(){
  if(!state.searchOpen||!state.query.trim()){state.books=[];state.error='';render();return}
  const query=state.query.trim(), token=++requestToken;state.loading=true;state.error='';render();
  try{
    const data=await api({action:'search',q:query,mode:state.searchMode,sort:state.sort,hits:'24'});
    if(token===requestToken){state.books=data.items||[];recordPrices(state.books);const history=load('kobo-search-history-v1',[]);save('kobo-search-history-v1',[query,...history.filter(item=>item!==query)].slice(0,8))}
  }catch(error){if(token===requestToken)state.error=error.message}
  finally{if(token===requestToken){state.loading=false;render();setTimeout(()=>{const input=$('#search-input');if(input){input.focus();input.setSelectionRange(input.value.length,input.value.length)}},0)}}
}

if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
ensureAwardYear();render();loadPopular();
