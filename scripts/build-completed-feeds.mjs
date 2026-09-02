import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { RANKING_SNAPSHOTS, RANKING_SOURCE_META } from '../catalog.js';

const API_BASE = String(process.env.KOBO_API_BASE || 'https://rakuten-kobo.vercel.app').replace(/\/+$/, '');
const DATA_BASE = 'https://raw.githubusercontent.com/UdonRX/RakutenKobo/ranking-data/data';
const saleInput = resolve(process.argv[2] || '/tmp/kobo-sale-candidates.json');
const outputDir = resolve(process.argv[3] || '/tmp/completed-feeds');

const BATCH_SIZE = 4;
const CONCURRENCY = 2;
const POPULAR_TARGET = 36;
const POPULAR_MAX_CANDIDATES = 120;
const SALE_TARGET = 30;
const SALE_MAX_CANDIDATES = 100;
const ADULT_WORDS = ['アダルト','成年コミック','成人向け','18禁','官能','成人漫画','エロティック','R18','R18+'];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function normalize(value='') {
  return String(value).normalize('NFKC').toLowerCase()
    .replace(/[〜～]/g,'〜')
    .replace(/[\s　・･:：!?！？()（）【】[\]「」『』〈〉《》#＃―ー\-]/g,'');
}
function simplifyTitle(value='') {
  const full=String(value||'').normalize('NFKC').replace(/[〜～]/g,'〜').replace(/\s+/g,' ').trim();
  return full
    .replace(/\s*[（(][^）)]*(?:コミックス|コミック|DIGITAL|電子|文庫|新書|単行本|BOOKS?)[^）)]*[）)]\s*$/iu,'')
    .replace(/\s*\[[^\]]*(?:電子|DIGITAL|コミック)[^\]]*\]\s*$/iu,'')
    .trim() || full;
}
function candidateForResolve(item) {
  const originalTitle=String(item?.title||'').trim();
  const title=simplifyTitle(originalTitle);
  return {...item,title,originalTitle:originalTitle!==title?originalTitle:(item?.originalTitle||'')};
}
function bookKey(book) {
  const id=String(book?.id||book?.isbn||'').trim();
  return id ? `id:${id}` : `t:${normalize(book?.title)}|${normalize(book?.author)}`;
}
function candidateTitleKey(item) {
  return normalize(item?.originalTitle || item?.title || '');
}
function isAdult(item) {
  const hay=[item?.title,item?.author,item?.publisher,item?.caption,item?.series].filter(Boolean).join(' ');
  return ADULT_WORDS.some(word=>hay.includes(word));
}
function dedupeBooks(list) {
  const seen=new Set(), out=[];
  for(const book of list||[]) {
    const key=bookKey(book);
    if(!key || seen.has(key) || isAdult(book)) continue;
    seen.add(key); out.push(book);
  }
  return out;
}

async function fetchJson(url, options={}, timeoutMs=25000, retries=2) {
  let last;
  for(let attempt=0; attempt<=retries; attempt++) {
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(), timeoutMs);
    try {
      const response=await fetch(url,{...options,signal:controller.signal});
      const text=await response.text();
      let data={};
      try { data=text?JSON.parse(text):{}; } catch { data={raw:text.slice(0,500)}; }
      if(!response.ok) throw new Error(data?.detail || data?.error || `HTTP_${response.status}`);
      return data;
    } catch(error) {
      last=error;
      if(attempt<retries) await sleep(500*(attempt+1));
    } finally { clearTimeout(timer); }
  }
  throw last;
}

async function resolveChunk(chunk) {
  return fetchJson(`${API_BASE}/api/kobo?action=resolve`,{
    method:'POST',
    headers:{'Content-Type':'application/json','Accept':'application/json'},
    body:JSON.stringify({items:chunk.map(candidateForResolve)})
  },30000,1);
}

async function resolveCandidates(entries,{target,maxCandidates}) {
  const candidates=(entries||[]).filter(item=>item?.title).slice(0,maxCandidates);
  let matched=[], checked=0, failedBatches=0;
  for(let offset=0; offset<candidates.length && matched.length<target; offset+=BATCH_SIZE*CONCURRENCY) {
    const chunks=[];
    for(let c=0;c<CONCURRENCY;c++) {
      const chunk=candidates.slice(offset+c*BATCH_SIZE, offset+(c+1)*BATCH_SIZE);
      if(chunk.length) chunks.push(chunk);
    }
    const settled=await Promise.allSettled(chunks.map(resolveChunk));
    for(let i=0;i<settled.length;i++) {
      checked += chunks[i].length;
      const result=settled[i];
      if(result.status==='fulfilled') matched.push(...(result.value.items||[]));
      else failedBatches++;
    }
    matched=dedupeBooks(matched);
    console.log(`Resolved ${checked}/${candidates.length}; Kobo matches ${matched.length}`);
    if(offset+BATCH_SIZE*CONCURRENCY<candidates.length && matched.length<target) await sleep(180);
  }
  return {items:matched.slice(0,target),checked,candidateCount:candidates.length,failedBatches};
}

function mergeRankingCandidates(snapshots) {
  const merged=new Map();
  for(const [source,snap] of Object.entries(snapshots||{})) {
    for(const item of snap?.items||[]) {
      if(!item?.title || isAdult(item)) continue;
      const titleKey=normalize(item.title);
      if(!titleKey) continue;
      const rank=Math.max(1,Number(item.rank||30));
      const existing=merged.get(titleKey);
      if(!existing) {
        merged.set(titleKey,{
          title:item.title,
          author:item.author||'',
          score:Math.max(5,110-rank*4),
          sources:[{source,label:snap.label||source,rank}],
          source:'combined'
        });
      } else {
        existing.score += Math.max(5,110-rank*4);
        if(!existing.author && item.author) existing.author=item.author;
        if(!existing.sources.some(s=>s.source===source)) existing.sources.push({source,label:snap.label||source,rank});
      }
    }
  }
  return [...merged.values()]
    .sort((a,b)=>b.sources.length-a.sources.length || b.score-a.score)
    .map((item,index)=>({...item,rank:index+1}));
}

function fallbackSnapshots(period) {
  const bucket=RANKING_SNAPSHOTS?.[period]||{};
  const out={};
  for(const [id,snapshot] of Object.entries(bucket)) {
    const meta=RANKING_SOURCE_META?.[id]||{id,label:id,attribution:id};
    out[id]={id,label:meta.label||id,attribution:meta.attribution||id,...snapshot,live:false};
  }
  return out;
}

async function maybeAmazonSnapshot() {
  try {
    const data=await fetchJson(`${DATA_BASE}/amazon-ranking.json?t=${Date.now()}`,{headers:{Accept:'application/json'}},12000,0);
    return Array.isArray(data?.items) && data.items.length ? data : null;
  } catch { return null; }
}

async function previousFeed(name) {
  try {
    return await fetchJson(`${DATA_BASE}/${name}?t=${Date.now()}`,{headers:{Accept:'application/json'}},10000,0);
  } catch { return null; }
}

function sourceSnapshotsWithResolvedOnly(snapshots,resolved) {
  const resolvedTitles=new Set();
  for(const book of resolved) {
    const meta=book.matchMeta||{};
    const key=candidateTitleKey(meta);
    if(key) resolvedTitles.add(key);
  }
  const out={};
  for(const [source,snap] of Object.entries(snapshots||{})) {
    const items=(snap.items||[])
      .filter(item=>resolvedTitles.has(normalize(item.title)))
      .slice(0,30)
      .map(item=>({title:item.title,author:item.author||'',rank:Number(item.rank||0)}));
    if(!items.length) continue;
    out[source]={...snap,items};
  }
  return out;
}

async function buildPopular(period) {
  const filename=`popular-${period}.json`;
  try {
    let rankData;
    try {
      rankData=await fetchJson(`${API_BASE}/api/kobo?action=rankings&period=${period}`,{headers:{Accept:'application/json'}},30000,1);
    } catch(error) {
      console.warn(`Ranking API ${period} failed; using repository fallback: ${error.message}`);
      rankData={period,snapshots:fallbackSnapshots(period),unavailable:['live-ranking-api'],fetchedAt:new Date().toISOString()};
    }
    const snapshots={...fallbackSnapshots(period),...(rankData.snapshots||{})};
    if(period==='week') {
      const amazon=await maybeAmazonSnapshot();
      if(amazon) snapshots.amazon=amazon;
    }
    const candidates=mergeRankingCandidates(snapshots).slice(0,POPULAR_MAX_CANDIDATES);
    if(!candidates.length) throw new Error(`POPULAR_${period}_NO_CANDIDATES`);
    const resolved=await resolveCandidates(candidates,{target:POPULAR_TARGET,maxCandidates:POPULAR_MAX_CANDIDATES});
    if(resolved.items.length<4) throw new Error(`POPULAR_${period}_TOO_FEW_${resolved.items.length}`);

    const items=resolved.items.map((book,index)=>({
      ...book,
      ranking:{...(book.matchMeta||{}),rank:index+1}
    }));
    const payload={
      kind:'popular',
      completed:true,
      period,
      updatedAt:new Date().toISOString(),
      candidateCount:candidates.length,
      checked:resolved.checked,
      matched:items.length,
      failedBatches:resolved.failedBatches,
      unavailable:rankData.unavailable||[],
      snapshots:sourceSnapshotsWithResolvedOnly(snapshots,resolved.items),
      items
    };
    await writeFile(join(outputDir,filename),`${JSON.stringify(payload,null,2)}\n`,'utf8');
    console.log(`Built ${filename}: ${items.length} Kobo books`);
  } catch(error) {
    const prev=await previousFeed(filename);
    if(prev?.completed && Array.isArray(prev.items) && prev.items.length) {
      await writeFile(join(outputDir,filename),`${JSON.stringify(prev,null,2)}\n`,'utf8');
      console.warn(`Kept previous ${filename}: ${error.message}`);
      return;
    }
    throw error;
  }
}

async function buildSale() {
  const filename='kobo-sale.json';
  try {
    const raw=JSON.parse(await readFile(saleInput,'utf8'));
    const candidates=(raw.items||[]).filter(item=>item?.title && Number(item.regularPrice)>Number(item.salePrice) && Number(item.salePrice)>0);
    const resolved=await resolveCandidates(candidates,{target:SALE_TARGET,maxCandidates:SALE_MAX_CANDIDATES});
    const items=resolved.items.map(book=>{
      const meta=book.matchMeta||{};
      return {
        ...book,
        price:Number(meta.salePrice||book.price||0),
        regularPrice:Number(meta.regularPrice||0),
        salePrice:Number(meta.salePrice||book.price||0),
        discountPercent:Number(meta.discountPercent||0),
        saleEndAt:meta.saleEndAt||'',
        saleCampaign:meta.saleCampaign||'',
        sourceGenre:meta.sourceGenre||''
      };
    }).filter(book=>book.salePrice>0 && book.regularPrice>book.salePrice);
    if(items.length<6) throw new Error(`SALE_TOO_FEW_${items.length}`);
    const payload={
      kind:'sale',
      completed:true,
      sourceUrl:raw.sourceUrl||'https://books.rakuten.co.jp/',
      updatedAt:new Date().toISOString(),
      candidateCount:candidates.length,
      checked:resolved.checked,
      matched:items.length,
      failedBatches:resolved.failedBatches,
      items
    };
    await writeFile(join(outputDir,filename),`${JSON.stringify(payload,null,2)}\n`,'utf8');
    console.log(`Built ${filename}: ${items.length} Kobo sale books`);
  } catch(error) {
    const prev=await previousFeed(filename);
    if(prev?.completed && Array.isArray(prev.items) && prev.items.length) {
      await writeFile(join(outputDir,filename),`${JSON.stringify(prev,null,2)}\n`,'utf8');
      console.warn(`Kept previous ${filename}: ${error.message}`);
      return;
    }
    throw error;
  }
}

await mkdir(outputDir,{recursive:true});
await buildSale();
for(const period of ['week','month','year']) await buildPopular(period);
