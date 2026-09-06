import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';

const files = ['index.html', 'app.js', 'ui.js', 'catalog.js', 'styles.css', 'sw.js'];
const BUILD_VERSION = '0.3.8';

function replaceRequired(text, before, after, label) {
  if (!text.includes(before)) throw new Error(`${label}_NOT_FOUND`);
  return text.replace(before, after);
}
function replaceBlock(text, startMarker, endMarker, replacement, label) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end <= start) throw new Error(`${label}_BLOCK_NOT_FOUND`);
  return text.slice(0, start) + replacement + text.slice(end);
}

await rm('dist', { recursive: true, force: true });
await mkdir('dist/public', { recursive: true });

for (const file of files) await cp(file, `dist/${file}`);
await cp('public', 'dist/public', { recursive: true });

let app = await readFile('dist/app.js', 'utf8');
app = app
  .replace("from './ui.js';", `from './ui.js?v=${BUILD_VERSION}';`)
  .replace('const TARGET_BOOKS=30;', 'const TARGET_BOOKS=Number.POSITIVE_INFINITY;')
  .replace('const MAX_CANDIDATES=60;', 'const MAX_CANDIDATES=Number.POSITIVE_INFINITY;')
  .replaceAll('kobo-feed-cache-v4', 'kobo-feed-cache-v5');

const popularStart = app.indexOf('async function ensureRankingData');
const popularEnd = app.indexOf('async function loadNew');
if (popularStart < 0 || popularEnd <= popularStart) throw new Error('POPULAR_LOADER_BLOCK_NOT_FOUND');

const completedPopularLoader = `async function fetchCompletedPopular(period){
  const response=await fetch('/data/popular-'+period+'.json?t='+Date.now(),{cache:'no-store'});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||!data?.completed||!Array.isArray(data.items))throw new Error(data?.error||'人気ランキングデータを取得できませんでした');
  return data;
}
function completedBookKey(book){return String(book?.id||book?.isbn||'').trim()||\`${'${normalize(book?.title)}|${normalize(book?.author)}'}\`}
function completedSources(book){return book?.ranking?.sources||book?.matchMeta?.sources||[]}
function sourceRank(book,source){const row=completedSources(book).find(item=>item.source===source);return Number(row?.rank||9999)}
async function ensureRankingData(force=false){
  const data=await fetchCompletedPopular(state.period);
  state.rankingData=data.snapshots||{};state.rankingPeriod=state.period;state.rankingUnavailable=data.unavailable||[];
  const ids=['combined',...Object.keys(state.rankingData)];if(!ids.includes(state.source))state.source='combined';
  return data;
}
async function loadPopular({refreshRankings=false}={}){
  const token=++requestToken,key=popularCacheKey(),cached=readCache(feedCache,key,FEED_CACHE_TTL);
  state.error='';state.popularMeta=null;
  if(cached?.books?.length){
    state.books=cached.books;state.popularMeta=cached.meta||null;state.loading=false;render();recordPrices(state.books);
    if(!refreshRankings&&cached.age<FEED_REFRESH_AFTER)return;
  }else{state.loading=true;state.books=[];render()}
  try{
    const data=await fetchCompletedPopular(state.period);
    if(token!==requestToken)return;
    state.rankingData=data.snapshots||{};state.rankingPeriod=state.period;state.rankingUnavailable=data.unavailable||[];
    const ids=['combined',...Object.keys(state.rankingData)];if(!ids.includes(state.source))state.source='combined';
    let books=[...(data.items||[])];
    if(state.source!=='combined'){
      books=books.filter(book=>completedSources(book).some(item=>item.source===state.source)).sort((a,b)=>sourceRank(a,state.source)-sourceRank(b,state.source));
    }
    if(state.genre){
      const hasGenreMap=data.byGenre&&Object.prototype.hasOwnProperty.call(data.byGenre,state.genre);
      if(hasGenreMap){
        const refs=Array.isArray(data.byGenre[state.genre])?data.byGenre[state.genre]:[];
        const keys=new Set(refs.map(item=>typeof item==='string'?item:completedBookKey(item)));
        books=books.filter(book=>keys.has(completedBookKey(book)));
      }else{
        books=await filterByActiveGenre(books);
      }
    }
    books=dedupe(books);
    state.books=books;state.loading=false;state.error='';
    state.popularMeta={candidates:Number(data.candidateCount||0),checked:Number(data.candidateCount||0),matched:books.length,totalMatched:Number(data.matched||data.items?.length||0),baseMatched:Number(data.baseMatched||0),addedMatches:Number(data.addedMatches||0),failedBatches:0};
    recordPrices(books);writeCache(feedCache,'kobo-feed-cache-v5',key,{books,meta:state.popularMeta});render();
  }catch(error){if(token===requestToken&&!state.books.length)state.error=error.message}
  finally{if(token===requestToken){state.loading=false;render()}}
}

`;
app = app.slice(0, popularStart) + completedPopularLoader + app.slice(popularEnd);

app = replaceRequired(
  app,
  "searchMode:'title',sort:'standard',query:'',books:[],saleBooks:[],saleSort:'recommended',saleMeta:null,",
  "searchMode:'title',sort:'standard',query:'',searchExecuted:false,books:[],saleBooks:[],saleSort:'recommended',saleMeta:null,saleCursor:'',saleHasMore:false,saleLoadingMore:false,",
  'SALE_STATE'
);
app = replaceRequired(app, 'let requestToken=0, watchRequestToken=0, searchTimer=null;', 'let requestToken=0, watchRequestToken=0, searchTimer=null, saleObserver=null;', 'SALE_OBSERVER_STATE');
app = replaceRequired(
  app,
  "}else response=await fetch('/api/kobo?'+new URLSearchParams(params));",
  "}else response=await fetch((params.action==='sales'?'/api/sales?':'/api/kobo?')+new URLSearchParams(params));",
  'SALE_API_ROUTE'
);

const liveSaleLoader = `async function fetchSalePage(cursor=''){
  const genreId=await activeGenreId();
  const params={action:'sales',...genreParams()};
  if(genreId)params.genreId=genreId;
  if(cursor)params.cursor=cursor;
  return api(params);
}
async function loadSale(){
  const token=++requestToken;
  state.error='';state.saleMeta=null;state.loading=true;state.saleLoadingMore=false;state.saleCursor='';state.saleHasMore=false;state.books=[];state.saleBooks=[];render();
  try{
    const data=await fetchSalePage('');
    if(token!==requestToken)return;
    const books=dedupe((data.items||[]).filter(book=>book?.saleVerified!==false));
    state.saleBooks=books;state.books=sortSaleBooks(books);state.saleCursor=data.nextCursor||'';state.saleHasMore=Boolean(data.hasMore&&data.nextCursor);
    state.saleMeta={fetchedAt:data.fetchedAt,sourceUrl:data.sourceUrl,officialSaleIndex:data.officialSaleIndex,parsed:Number(data.parsed||books.length),matched:books.length,loaded:books.length,officialTotal:Number(data.officialTotal||0),pageSize:Number(data.pageSize||100),exhaustive:Boolean(data.exhaustive)};
    state.genreResolved=data.resolvedGenre||state.genreResolved;recordPrices(books);
  }catch(error){if(token===requestToken&&!state.books.length)state.error=error.message}
  finally{if(token===requestToken){state.loading=false;render()}}
}
async function loadMoreSale(){
  if(state.tab!=='sale'||state.loading||state.saleLoadingMore||!state.saleHasMore||!state.saleCursor)return;
  const token=requestToken,cursor=state.saleCursor;state.saleLoadingMore=true;render();
  try{
    const data=await fetchSalePage(cursor);if(token!==requestToken)return;
    const books=dedupe([...state.saleBooks,...(data.items||[]).filter(book=>book?.saleVerified!==false)]);
    state.saleBooks=books;state.books=sortSaleBooks(books);state.saleCursor=data.nextCursor||'';state.saleHasMore=Boolean(data.hasMore&&data.nextCursor);
    state.saleMeta={...(state.saleMeta||{}),fetchedAt:data.fetchedAt||state.saleMeta?.fetchedAt,sourceUrl:data.sourceUrl||state.saleMeta?.sourceUrl,officialSaleIndex:data.officialSaleIndex||state.saleMeta?.officialSaleIndex,parsed:Number(state.saleMeta?.parsed||0)+Number(data.parsed||0),matched:books.length,loaded:books.length,officialTotal:Number(state.saleMeta?.officialTotal||data.officialTotal||0),pageSize:Number(data.pageSize||state.saleMeta?.pageSize||100),exhaustive:Boolean(data.exhaustive)};
    recordPrices(data.items||[]);
  }catch(error){if(token===requestToken&&!state.saleBooks.length)state.error=error.message}
  finally{if(token===requestToken){state.saleLoadingMore=false;render()}}
}

`;
app = replaceBlock(app, 'async function loadSale(){', 'async function loadAward(){', liveSaleLoader, 'SALE_LOADER');

app = replaceRequired(
  app,
  "function render(){captureChipScroll();document.querySelector('#app').innerHTML=layout(state,currentView(),load('kobo-search-history-v1',[]));bind();requestAnimationFrame(restoreChipScroll)}",
  "function render(){captureChipScroll();saleObserver?.disconnect();saleObserver=null;document.querySelector('#app').innerHTML=layout(state,currentView(),load('kobo-search-history-v1',[]));bind();requestAnimationFrame(restoreChipScroll)}",
  'RENDER_OBSERVER_CLEANUP'
);
app = replaceRequired(app, " $('[data-action=\"search\"]')?.addEventListener('click',()=>{state.searchOpen=true;state.books=[];state.error='';render();setTimeout(()=>$('#search-input')?.focus(),30)});".trimStart(), " $('[data-action=\"search\"]')?.addEventListener('click',()=>{state.searchOpen=true;state.searchExecuted=false;state.books=[];state.error='';render();setTimeout(()=>$('#search-input')?.focus(),30)});".trimStart(), 'SEARCH_OPEN_STATE');
app = replaceRequired(app, " $('[data-close-search]')?.addEventListener('click',()=>{state.searchOpen=false;state.query='';state.books=[];state.error='';render();reloadCurrent()});".trimStart(), " $('[data-close-search]')?.addEventListener('click',()=>{state.searchOpen=false;state.query='';state.searchExecuted=false;state.books=[];state.error='';render();reloadCurrent()});".trimStart(), 'SEARCH_CLOSE_STATE');
app = replaceRequired(app, " $$('[data-search-mode]').forEach(button=>button.onclick=()=>{state.searchMode=button.dataset.searchMode;runSearch()});".trimStart(), " $('[data-search-form]')?.addEventListener('submit',event=>{event.preventDefault();const input=$('#search-input');if(input)state.query=input.value;state.searchExecuted=true;runSearch()});\n  $$('[data-search-mode]').forEach(button=>button.onclick=()=>{state.searchMode=button.dataset.searchMode;$$('[data-search-mode]').forEach(item=>item.classList.toggle('active',item===button))});".trimStart(), 'SEARCH_MODE_MANUAL');
app = replaceRequired(app, " $('#sort-select')?.addEventListener('change',event=>{state.sort=event.target.value;runSearch()});".trimStart(), " $('#sort-select')?.addEventListener('change',event=>{state.sort=event.target.value});".trimStart(), 'SEARCH_SORT_MANUAL');
app = replaceRequired(app, " $('#search-input')?.addEventListener('input',event=>{state.query=event.target.value;clearTimeout(searchTimer);searchTimer=setTimeout(runSearch,350)});".trimStart(), " $('#search-input')?.addEventListener('input',event=>{state.query=event.target.value;state.searchExecuted=false});".trimStart(), 'SEARCH_INPUT_MANUAL');
app = replaceRequired(app, " $$('[data-history]').forEach(button=>button.onclick=()=>{state.query=button.dataset.history;render();runSearch()});".trimStart(), " $$('[data-history]').forEach(button=>button.onclick=()=>{state.query=button.dataset.history;const input=$('#search-input');if(input){input.value=state.query;input.focus();input.setSelectionRange(input.value.length,input.value.length)}});\n  $('[data-sale-load-more]')?.addEventListener('click',loadMoreSale);\n  const saleSentinel=$('[data-sale-more]');\n  if(saleSentinel&&state.tab==='sale'&&state.saleHasMore&&!state.saleLoadingMore&&'IntersectionObserver'in window){saleObserver=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){saleObserver?.disconnect();saleObserver=null;loadMoreSale()}},{rootMargin:'900px 0px'});saleObserver.observe(saleSentinel)}".trimStart(), 'SEARCH_HISTORY_AND_SALE_BINDING');
app = replaceRequired(app, "if(!state.searchOpen||!state.query.trim()){state.books=[];state.error='';render();return}", "if(!state.searchOpen||!state.query.trim()){state.searchExecuted=false;state.books=[];state.error='';render();return}", 'SEARCH_EMPTY_STATE');

const viewportFix = `let stableViewportHeight=0,stableViewportWidth=0;
function syncKeyboardViewport(){
  const viewport=window.visualViewport;if(!viewport)return;
  const width=Math.round(viewport.width),visibleBottom=viewport.height+viewport.offsetTop;
  if(!stableViewportHeight||Math.abs(width-stableViewportWidth)>40||visibleBottom>stableViewportHeight-80){stableViewportHeight=Math.max(visibleBottom,window.innerHeight||0);stableViewportWidth=width}
  const hidden=Math.max(0,stableViewportHeight-visibleBottom),keyboardOffset=hidden>120?hidden:0;
  document.documentElement.style.setProperty('--keyboard-occlusion',keyboardOffset+'px');
  document.documentElement.classList.toggle('keyboard-open',keyboardOffset>0);
}
if(window.visualViewport){window.visualViewport.addEventListener('resize',syncKeyboardViewport,{passive:true});window.visualViewport.addEventListener('scroll',syncKeyboardViewport,{passive:true});window.addEventListener('orientationchange',()=>{stableViewportHeight=0;stableViewportWidth=0;setTimeout(syncKeyboardViewport,0)},{passive:true});syncKeyboardViewport()}

`;
app = replaceRequired(app, "if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});", viewportFix + "if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});", 'IOS_KEYBOARD_FIX');
await writeFile('dist/app.js', app, 'utf8');

let ui = await readFile('dist/ui.js', 'utf8');
ui = ui.replace(/const VERSION='[^']+';/, `const VERSION='${BUILD_VERSION}';`);
const bookFlags = `function formatSalesDate(value=''){
  const text=String(value||'').trim(),match=text.match(/(20\\d{2})[年\\/.\\-](\\d{1,2})[月\\/.\\-](\\d{1,2})/);
  return match?\`${'${match[1]}/${String(match[2]).padStart(2,\'0\')}/${String(match[3]).padStart(2,\'0\')}'}\`:text;
}
function bookFlags(state,book){
  const end=saleEndInfo(book.saleEndAt),history=priceHistory(state,book),current=Number(book.salePrice||book.currentPrice||book.price||0),drop=Number(book.watchDrop||0);
  const flags=[];
  if(state.tab==='new'&&book.salesDate)flags.push(\`<span class="release-date">発売日 ${'${esc(formatSalesDate(book.salesDate))}'}</span>\`);
  if(end&&!end.ended)flags.push(\`<span class="sale-end ${'${end.urgent?\'urgent\':\'\'}'}">${'${esc(end.label)}'}</span>\`);
  if(history?.min&&current&&Number(history.min)===current)flags.push('<span class="history-low">過去最安</span>');
  if(drop>0)flags.push(\`<span class="watch-drop">${'${yen(drop)}'}値下がり</span>\`);
  return flags.length?\`<div class="book-flags">${'${flags.join(\'\')}'}</div>\`:'';
}

`;
ui = replaceBlock(ui, 'function bookFlags(state,book){', 'export function cards', bookFlags, 'UI_BOOK_FLAGS');
const saleView = `export function saleView(state){
  const sorts=[{id:'recommended',label:'おすすめ'},{id:'discount',label:'割引率'},{id:'price',label:'安い順'},{id:'ending',label:'終了間近'}];
  const loaded=Number(state.saleBooks?.length||state.books?.length||0),total=Number(state.saleMeta?.officialTotal||0);
  const progress=total?\`${'${loaded.toLocaleString()}'}冊表示 / 公式一覧 ${'${total.toLocaleString()}'}件\`:\`${'${loaded.toLocaleString()}'}冊表示\`;
  const more=state.saleHasMore?\`<div class="sale-more" data-sale-more>${'${state.saleLoadingMore?\'<span>セール本を追加取得中…</span>\':\'<button data-sale-load-more>さらに100冊読み込む</button>\'}'}</div>\`:(loaded?'<div class="sale-more done"><span>取得できるセール本をすべて読み込みました</span></div>':'');
  return \`${'${chips(sorts,state.saleSort,\'sale-sort\',\'sale-sort-tabs\')}'}${'${intro(\'いまセール中\',\'楽天Koboの公式セール一覧を100冊ずつ追加表示。アプリ側の冊数上限はありません。\')}'}<p class="sale-progress">${'${esc(progress)}'}</p>${'${cards(state,state.books)}'}${'${more}'}<p class="source-note">楽天ブックス公式「セール中の作品」を対象に、著者・価格・セール終了日時を商品一覧から直接取得します。単一検索の300ページ上限を価格帯に分割して継続取得し、成人向け作品は除外します。価格・終了日時は変更される場合があるため、購入前にKoboの商品ページでも確認してください。</p>\`;
}
`;
ui = replaceBlock(ui, 'export function saleView(state){', 'export function awardView', saleView, 'UI_SALE_VIEW');
const searchSheet = `export function searchSheet(state,history){return \`<div class="sheet full"><div class="sheet-head"><form class="search-field" data-search-form><input id="search-input" value="${'${esc(state.query)}'}" placeholder="本のタイトル・著者を検索" autocomplete="off" enterkeyhint="search"><button type="submit" class="search-submit" aria-label="検索">🔍</button></form><button class="icon-button" data-close-search>×</button></div>${'${chips(SEARCH_MODES.map(([id,label])=>({id,label})),state.searchMode,\'search-mode\',\'search-mode-tabs\')}'}<div class="sort-row"><span>並び替え</span><select id="sort-select">${'${SORTS.map(([id,label])=>`<option value="${id}" ${state.sort===id?\'selected\':\'\'}>${label}</option>`).join(\'\')}'}</select></div><div class="sheet-content">${'${state.searchExecuted?cards(state,state.books):`<div class="history"><h3>最近の検索</h3>${history.length?history.map(item=>`<button data-history="${esc(item)}">${esc(item)}<b>›</b></button>`).join(\'\'):\'<p>検索履歴はこのiPhone内だけに保存されます。</p>\'}</div>`}'}</div></div>\`}

`;
ui = replaceBlock(ui, 'export function searchSheet(state,history){', 'export function detailSheet', searchSheet, 'UI_SEARCH_SHEET');
await writeFile('dist/ui.js', ui, 'utf8');

let css = await readFile('dist/styles.css', 'utf8');
css += `\n/* v${BUILD_VERSION}: explicit search, iOS keyboard-safe fixed nav, sale pagination metadata */\n.search-field{padding-right:6px}.search-field input{min-width:0}.search-submit{width:38px;height:38px;flex:0 0 38px;border:0;border-radius:11px;background:#fff;display:grid;place-items:center;font-size:18px;box-shadow:0 1px 5px rgba(30,25,20,.08)}.book-flags .release-date{background:#e8f1ff;color:#315b96}.sale-progress{font-size:11px;color:#77746d;margin:-6px 2px 12px}.sale-more{min-height:96px;display:flex;align-items:center;justify-content:center;padding:18px 0;color:#817d75;font-size:12px}.sale-more button{min-height:44px;border:1px solid #dedbd4;background:#fff;border-radius:999px;padding:0 20px;font-weight:800}.sale-more.done{min-height:64px}.bottom-nav{position:fixed!important;transform:translate(-50%,var(--keyboard-occlusion,0px))!important;transition:none!important;will-change:transform}.genre-fab{transform:translateY(var(--keyboard-occlusion,0px))!important;transition:none!important;will-change:transform}@media(prefers-color-scheme:dark){.search-submit,.sale-more button{background:#1e1d19;border-color:#302f29}.book-flags .release-date{background:#18283e;color:#9ec5ff}.sale-progress{color:#aaa59b}}\n`;
await writeFile('dist/styles.css', css, 'utf8');

let index = await readFile('dist/index.html', 'utf8');
index = index
  .replace('href="/styles.css"', `href="/styles.css?v=${BUILD_VERSION}"`)
  .replace(/^\s*<script src="\/public\/sale-snapshot-client\.js[^\n]*\n/m, '')
  .replace(/\?v=0\.3\.\d+/g, `?v=${BUILD_VERSION}`);
await writeFile('dist/index.html', index, 'utf8');

let sw = await readFile('dist/sw.js', 'utf8');
sw = sw
  .replace(/kobo-finder-v0\.3\.\d+/g, `kobo-finder-v${BUILD_VERSION}`)
  .replace("'/styles.css'", `'/styles.css?v=${BUILD_VERSION}'`)
  .replace("'/ui.js'", `'/ui.js?v=${BUILD_VERSION}'`)
  .replace(/, '\/public\/sale-snapshot-client\.js\?v=0\.3\.\d+'/g, '')
  .replace(/\?v=0\.3\.\d+/g, `?v=${BUILD_VERSION}`);
await writeFile('dist/sw.js', sw, 'utf8');

console.log(`Kobo Finder static bundle v${BUILD_VERSION} created with manual search, iOS keyboard-safe navigation, live unbounded sale pagination, and release/sale dates on cards.`);
