import { readFile, writeFile } from 'node:fs/promises';

const VERSION='0.3.11';
let app=await readFile('dist/app.js','utf8');

const renderStart=app.indexOf('function render(){');
const renderEnd=app.indexOf('function overlayBooks(){',renderStart);
if(renderStart<0||renderEnd<=renderStart)throw new Error('POSTBUILD_RENDER_NOT_FOUND');
const safeRender=`function render(){try{captureChipScroll()}catch(error){console.warn('[KOBO capture]',error)}saleObserver?.disconnect();saleObserver=null;document.querySelector('#app').innerHTML=layout(state,currentView(),load('kobo-search-history-v1',[]));try{bind()}catch(error){window.__koboBindError=String(error?.stack||error);console.error('[KOBO bind]',error)}try{requestAnimationFrame(()=>{try{restoreChipScroll()}catch(error){console.warn('[KOBO restore]',error)}})}catch(error){console.warn('[KOBO raf]',error)}}\n`;
app=app.slice(0,renderStart)+safeRender+app.slice(renderEnd);

const oldSave="const save=(k,v)=>localStorage.setItem(k,JSON.stringify(v));";
const safeSave="const save=(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v));return true}catch(error){console.warn('[KOBO storage]',error?.name||error);return false}};";
if(!app.includes(oldSave))throw new Error('POSTBUILD_SAVE_NOT_FOUND');
app=app.replace(oldSave,safeSave);

const saleStart=app.indexOf("async function fetchSalePage(cursor=''){");
const saleEnd=app.indexOf('async function loadAward(){',saleStart);
if(saleStart<0||saleEnd<=saleStart)throw new Error('POSTBUILD_SALE_BLOCK_NOT_FOUND');
const staticSale=`const SALE_STATIC_ROOT='/data/sale',SALE_STATIC_BATCH_SIZE=100,SALE_STATIC_RETRIES=2;
const saleStaticSleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fetchSaleStaticJson(url,{fresh=false}={}){let lastError;for(let attempt=0;attempt<=SALE_STATIC_RETRIES;attempt++){try{const response=await fetch(url,{cache:fresh?'no-store':'default'});const data=await response.json().catch(()=>({}));if(!response.ok||!data)throw new Error(data?.error||('SALE_STATIC_HTTP_'+response.status));return data}catch(error){lastError=error;if(attempt<SALE_STATIC_RETRIES)await saleStaticSleep(250*(attempt+1))}}throw lastError}
async function fetchSaleStaticIndex(){try{const sep=SALE_STATIC_ROOT+'/index.json?t='+Date.now(),data=await fetchSaleStaticJson(sep,{fresh:true});if(!data?.completed||!Number(data.pageCount))throw new Error('SALE_STATIC_INDEX_INVALID');return data}catch(error){console.warn('[KOBO sale static index fallback]',error);const legacy=await fetchSaleStaticJson('/data/kobo-sale.json?t='+Date.now(),{fresh:true});return{kind:'sale-static-fallback',completed:true,fallback:true,pageSize:100,pageCount:1,total:Number(legacy.items?.length||0),officialTotal:Number(legacy.candidateCount||legacy.items?.length||0),updatedAt:legacy.updatedAt||'',sourceUrl:legacy.sourceUrl||'',officialSaleIndex:legacy.officialSaleIndex||'',legacyItems:Array.isArray(legacy.items)?legacy.items:[],genres:{}}}}
function saleStaticPageUrl(page,index){return SALE_STATIC_ROOT+'/pages/'+String(page).padStart(4,'0')+'.json?u='+encodeURIComponent(index?.updatedAt||'')}
async function fetchSaleStaticPage(page,index){const data=await fetchSaleStaticJson(saleStaticPageUrl(page,index));if(!data?.completed||!Array.isArray(data.items))throw new Error('SALE_STATIC_PAGE_INVALID');return data}
function mergeStaticSaleItems(items,index,totalOverride){const incoming=(items||[]).filter(book=>book?.saleVerified!==false),before=state.saleBooks.length,books=dedupe([...state.saleBooks,...incoming]);state.saleBooks=books;state.books=sortSaleBooks(books);state.saleMeta={...(state.saleMeta||{}),fetchedAt:index.updatedAt||state.saleMeta?.fetchedAt,sourceUrl:index.sourceUrl||state.saleMeta?.sourceUrl,officialSaleIndex:index.officialSaleIndex||state.saleMeta?.officialSaleIndex,parsed:books.length,matched:books.length,loaded:books.length,officialTotal:Number(totalOverride||index.total||index.officialTotal||0),pageSize:Number(index.pageSize||100),exhaustive:Boolean(index.exhaustive!==false),staticFeed:true};recordPrices(incoming);return Math.max(0,books.length-before)}
async function fetchStaticSaleBatch(targetCount,token){const index=state.saleStaticIndex||(state.saleStaticIndex=await fetchSaleStaticIndex());if(token!==requestToken)return 0;if(index.fallback){const added=mergeStaticSaleItems(index.legacyItems||[],index,index.total);state.saleHasMore=false;state.saleCursor='';state.loading=false;render();return added}let added=0;if(state.genre){const plan=index.genres?.[state.genre]||{count:0,pages:[]},pages=Array.isArray(plan.pages)?plan.pages:[];let pos=Number(state.saleStaticGenrePos||0);while(token===requestToken&&pos<pages.length&&added<targetCount){const pageNo=Number(pages[pos]?.page||pages[pos]);pos+=1;if(!pageNo)continue;const data=await fetchSaleStaticPage(pageNo,index);if(token!==requestToken)return added;const matching=(data.items||[]).filter(book=>Array.isArray(book.genreKeys)&&book.genreKeys.includes(state.genre));added+=mergeStaticSaleItems(matching,index,Number(plan.count||0));state.saleStaticGenrePos=pos;state.loading=false;state.saleLoadingMore=pos<pages.length&&added<targetCount;state.saleHasMore=pos<pages.length;state.saleCursor=state.saleHasMore?'static':'';render()}state.saleStaticGenrePos=pos;state.saleHasMore=pos<pages.length;state.saleCursor=state.saleHasMore?'static':''}else{let page=Math.max(1,Number(state.saleStaticPage||1));while(token===requestToken&&page<=Number(index.pageCount||0)&&added<targetCount){const data=await fetchSaleStaticPage(page,index);if(token!==requestToken)return added;page+=1;added+=mergeStaticSaleItems(data.items||[],index,Number(index.total||0));state.saleStaticPage=page;state.loading=false;state.saleLoadingMore=page<=Number(index.pageCount||0)&&added<targetCount;state.saleHasMore=page<=Number(index.pageCount||0);state.saleCursor=state.saleHasMore?'static':'';render()}state.saleStaticPage=page;state.saleHasMore=page<=Number(index.pageCount||0);state.saleCursor=state.saleHasMore?'static':''}return added}
async function loadSale(){const token=++requestToken;state.error='';state.saleMeta=null;state.loading=true;state.saleLoadingMore=true;state.saleCursor='';state.saleHasMore=false;state.books=[];state.saleBooks=[];state.saleStaticIndex=null;state.saleStaticPage=1;state.saleStaticGenrePos=0;render();try{await fetchStaticSaleBatch(SALE_STATIC_BATCH_SIZE,token);if(token===requestToken)state.error=''}catch(error){if(token===requestToken){if(!state.saleBooks.length)state.error='セールデータを取得できませんでした: '+String(error?.message||error);else console.warn('[KOBO sale static partial]',error)}}finally{if(token===requestToken){state.loading=false;state.saleLoadingMore=false;render()}}}
async function loadMoreSale(){if(state.tab!=='sale'||state.loading||state.saleLoadingMore||!state.saleHasMore)return;const token=requestToken;state.saleLoadingMore=true;render();try{await fetchStaticSaleBatch(SALE_STATIC_BATCH_SIZE,token)}catch(error){if(token===requestToken){if(!state.saleBooks.length)state.error='セールデータを取得できませんでした: '+String(error?.message||error);else console.warn('[KOBO sale static partial]',error)}}finally{if(token===requestToken){state.saleLoadingMore=false;render()}}}

`;
app=app.slice(0,saleStart)+staticSale+app.slice(saleEnd);
app=app.replaceAll('0.3.8',VERSION).replaceAll('0.3.10',VERSION);
await writeFile('dist/app.js',app,'utf8');

for(const file of ['dist/ui.js','dist/index.html','dist/sw.js']){
  let text=await readFile(file,'utf8');
  text=text.replaceAll('0.3.8',VERSION).replaceAll('0.3.10',VERSION);
  await writeFile(file,text,'utf8');
}
console.log('postbuild v'+VERSION+' applied: static GitHub Actions sale pages, no runtime Rakuten fetch');
