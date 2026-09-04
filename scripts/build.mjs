import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';

const files = ['index.html', 'app.js', 'ui.js', 'catalog.js', 'styles.css', 'sw.js'];
const BUILD_VERSION = '0.3.7';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/public', { recursive: true });

for (const file of files) {
  await cp(file, `dist/${file}`);
}
await cp('public', 'dist/public', { recursive: true });

let app = await readFile('dist/app.js', 'utf8');
app = app
  .replace('const TARGET_BOOKS=30;', 'const TARGET_BOOKS=Number.POSITIVE_INFINITY;')
  .replace('const MAX_CANDIDATES=60;', 'const MAX_CANDIDATES=Number.POSITIVE_INFINITY;')
  .replaceAll('kobo-feed-cache-v4', 'kobo-feed-cache-v5');

const popularStart = app.indexOf('async function ensureRankingData');
const popularEnd = app.indexOf('async function loadNew');
if (popularStart < 0 || popularEnd <= popularStart) {
  throw new Error('POPULAR_LOADER_BLOCK_NOT_FOUND');
}

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
await writeFile('dist/app.js', app, 'utf8');

let ui = await readFile('dist/ui.js', 'utf8');
ui = ui.replace(/const VERSION='[^']+';/, `const VERSION='${BUILD_VERSION}';`);
await writeFile('dist/ui.js', ui, 'utf8');

let index = await readFile('dist/index.html', 'utf8');
index = index.replace(/\?v=0\.3\.\d+/g, `?v=${BUILD_VERSION}`);
await writeFile('dist/index.html', index, 'utf8');

let sw = await readFile('dist/sw.js', 'utf8');
sw = sw
  .replace(/kobo-finder-v0\.3\.\d+/g, `kobo-finder-v${BUILD_VERSION}`)
  .replace(/\?v=0\.3\.\d+/g, `?v=${BUILD_VERSION}`);
await writeFile('dist/sw.js', sw, 'utf8');

console.log(`Kobo Finder static bundle v${BUILD_VERSION} created with completed popular feeds and no client-side ranking re-resolution.`);
