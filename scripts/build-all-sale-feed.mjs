import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GENRES } from '../catalog.js';

const API_BASE=String(process.env.KOBO_API_BASE||'https://rakuten-kobo.vercel.app').replace(/\/+$/,'');
const inputPath=resolve(process.argv[2]||'/tmp/kobo-sale-candidates.json');
const outputPath=resolve(process.argv[3]||'/tmp/completed-feeds/kobo-sale.json');
const BATCH_SIZE=8;
const ADULT_WORDS=['アダルト','成年コミック','成人向け','18禁','官能','成人漫画','エロティック','R18','R18+'];
const LIGHT_NOVEL_WORDS=['ライトノベル','ラノベ','電撃文庫','MF文庫J','GA文庫','富士見ファンタジア文庫','ガガガ文庫'];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function normalize(v=''){return String(v).normalize('NFKC').toLowerCase().replace(/[〜～]/g,'〜').replace(/[\s　・･:：!?！？()（）【】\[\]「」『』〈〉《》#＃―ー\-]/g,'')}
function candidateKey(item){const n=String(item?.itemNumber||item?.isbn||'').trim();const u=String(item?.url||'').trim();return n?`n:${n}`:u?`u:${u}`:`t:${normalize(item?.originalTitle||item?.title||'')}`}
function bookKey(book){const id=String(book?.id||book?.isbn||'').trim();const u=String(book?.url||'').trim();return id?`id:${id}`:u?`u:${u}`:`t:${normalize(book?.title)}|${normalize(book?.author)}`}
function textOf(item){return [item?.title,item?.author,item?.publisher,item?.caption,item?.series,item?.sourceGenre].filter(Boolean).join(' ')}
function isAdult(item){const t=textOf(item);return ADULT_WORDS.some(w=>t.includes(w))}
function isLightNovel(item){const t=textOf(item);return LIGHT_NOVEL_WORDS.some(w=>t.includes(w))}
function dedupe(list){const seen=new Set(),out=[];for(const item of list||[]){const k=bookKey(item);if(!k||seen.has(k)||isAdult(item))continue;seen.add(k);out.push(item)}return out}
function validProductUrl(url=''){return /^https:\/\/books\.rakuten\.co\.jp\/rk\/[^/]+\/?/i.test(String(url))}

async function fetchJson(url,options={},timeoutMs=30000,retries=4){let last;for(let attempt=0;attempt<=retries;attempt++){const c=new AbortController(),timer=setTimeout(()=>c.abort(),timeoutMs);try{const r=await fetch(url,{...options,signal:c.signal});const text=await r.text();let data={};try{data=text?JSON.parse(text):{}}catch{data={}}if(!r.ok)throw new Error(data?.detail||data?.error||`HTTP_${r.status}`);return data}catch(error){last=error;if(attempt<retries)await sleep(Math.max(1200,1200*(attempt+1)))}finally{clearTimeout(timer)}}throw last}
async function resolveGenre(genre){try{const p=new URLSearchParams({action:'genre-resolve',genreKey:genre.id,genreNames:genre.names.join('|'),parentNames:genre.parentNames.join('|')});const d=await fetchJson(`${API_BASE}/api/kobo?${p}`,{headers:{Accept:'application/json'}},22000,2);return d.resolvedGenre||null}catch{return null}}
async function resolveChunk(chunk){const d=await fetchJson(`${API_BASE}/api/kobo?action=resolve`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({items:chunk})},35000,4);return d.items||[]}

function candidateFallback(candidate,index){
  const regular=Number(candidate.regularPrice||0),sale=Number(candidate.salePrice||0),url=String(candidate.url||'');
  if(!candidate.title||!validProductUrl(url)||!regular||!sale||sale>=regular||isAdult(candidate))return null;
  const slug=url.match(/\/rk\/([^/?#]+)/i)?.[1]||normalize(candidate.title).slice(0,48)||String(index);
  return {
    id:`rk:${slug}`,title:candidate.title,author:candidate.author||'',publisher:candidate.publisher||'',price:sale,url,
    image:candidate.image||'',caption:candidate.caption||'',salesDate:candidate.salesDate||'',series:candidate.series||'',
    reviewAverage:0,reviewCount:0,genreId:'',isbn:/^\d+$/.test(String(candidate.itemNumber||''))?String(candidate.itemNumber):'',
    regularPrice:regular,salePrice:sale,discountPercent:Math.max(1,Math.round((1-sale/regular)*100)),saleEndAt:candidate.saleEndAt||'',
    saleCampaign:candidate.saleCampaign||'',saleCampaigns:candidate.saleCampaigns||[],saleSources:candidate.saleSources||['rakuten-kobo-sale-listing'],
    sourceGenre:candidate.sourceGenre||'',campaignMerch:candidate.campaignMerch||'',campaignUrl:candidate.campaignUrl||'',
    saleVerified:true,verification:'current-rakuten-kobo-sale-listing',verifiedAt:new Date().toISOString(),sourceOrder:index
  };
}
function verifiedApiBook(book,index){
  const meta=book?.matchMeta||{},regular=Number(meta.regularPrice||0),live=Number(book?.price||0),url=String(book?.url||'');
  if(!book?.id||!validProductUrl(url)||!regular||!live||live>=regular||isAdult(book))return null;
  const campaigns=[...new Set([...(meta.saleCampaigns||[]),meta.saleCampaign].filter(Boolean))];
  return {...book,price:live,regularPrice:regular,salePrice:live,discountPercent:Math.max(1,Math.round((1-live/regular)*100)),saleEndAt:meta.saleEndAt||'',saleCampaign:campaigns[0]||'',saleCampaigns:campaigns,saleSources:meta.saleSources||[],sourceGenre:meta.sourceGenre||'',campaignMerch:meta.campaignMerch||'',campaignUrl:meta.campaignUrl||'',saleVerified:true,verification:'live-kobo-api',verifiedAt:new Date().toISOString(),sourceOrder:index};
}
function genreIds(v=''){return String(v||'').split('/').map(x=>x.trim()).filter(Boolean)}
function genreMatches(book,genre,resolved){
  if(genre.excludeLightNovel&&isLightNovel(book))return false;
  if(resolved?.id&&genreIds(book.genreId).some(id=>id===String(resolved.id)||id.startsWith(String(resolved.id))))return true;
  const t=textOf(book);
  if(genre.id==='essay')return /エッセイ|随筆/u.test(t);
  return genre.names.some(name=>name&&t.includes(name))||String(book.sourceGenre||'').split(/[・／/]/).some(part=>genre.names.some(name=>part.includes(name)));
}

const raw=JSON.parse(await readFile(inputPath,'utf8'));
const candidates=(raw.items||[]).filter(item=>item?.title&&Number(item.regularPrice)>Number(item.salePrice)&&Number(item.salePrice)>0&&!isAdult(item));
const candidateIndex=new Map(candidates.map((item,index)=>[candidateKey(item),index]));
const apiMatches=new Map();let checked=0,failedBatches=0;
for(let i=0;i<candidates.length;i+=BATCH_SIZE){
  const chunk=candidates.slice(i,i+BATCH_SIZE);
  try{
    const resolved=await resolveChunk(chunk);
    for(const book of resolved){const key=candidateKey(book.matchMeta||{});if(key)apiMatches.set(key,book)}
  }catch(error){failedBatches++;console.warn(`Sale API batch ${i}-${i+chunk.length} failed: ${error.message}`)}
  checked+=chunk.length;
  if(checked%80===0||checked===candidates.length)console.log(`Verified sale candidates ${checked}/${candidates.length}; API matches ${apiMatches.size}`);
  if(i+BATCH_SIZE<candidates.length)await sleep(280);
}

let verifiedByApi=0,verifiedByListing=0,rejectedByApiPrice=0;
const books=[];
for(let index=0;index<candidates.length;index++){
  const candidate=candidates[index],key=candidateKey(candidate),apiBook=apiMatches.get(key);
  if(apiBook){
    const live=verifiedApiBook(apiBook,index);
    if(live){books.push(live);verifiedByApi++;continue}
    if(Number(apiBook.price||0)>=Number(candidate.regularPrice||0)&&Number(apiBook.price||0)>0){rejectedByApiPrice++;continue}
  }
  const fallback=candidateFallback(candidate,index);if(fallback){books.push(fallback);verifiedByListing++}
}
const items=dedupe(books).sort((a,b)=>Number(a.sourceOrder||0)-Number(b.sourceOrder||0));

const genrePairs=[];
for(const genre of GENRES){const resolved=await resolveGenre(genre);genrePairs.push([genre.id,resolved]);await sleep(120)}
const genreInfo=Object.fromEntries(genrePairs);
const byGenre={},genreStatus={};
for(const genre of GENRES){
  const list=items.filter(book=>genreMatches(book,genre,genreInfo[genre.id]));
  byGenre[genre.id]=list;
  genreStatus[genre.id]={matched:list.length,complete:true};
}

const payload={
  kind:'sale',completed:true,exhaustive:true,sourceUrl:raw.sourceUrl||'',officialSaleIndex:raw.officialSaleIndex||'',updatedAt:new Date().toISOString(),
  campaignCount:Number(raw.campaignCount||raw.campaigns?.length||0),campaigns:raw.campaigns||[],sourceCounts:raw.sourceCounts||{},
  candidateCount:candidates.length,checked,matched:items.length,failedBatches,verifiedByApi,verifiedByListing,rejectedByApiPrice,
  saleVerification:'live-kobo-api-or-current-rakuten-kobo-sale-listing',items,byGenre,genreStatus
};
await writeFile(outputPath,`${JSON.stringify(payload,null,2)}\n`,'utf8');
console.log(`Built exhaustive sale feed: ${items.length}/${candidates.length} current Kobo sale books (API ${verifiedByApi}, listing ${verifiedByListing}, ended/repriced ${rejectedByApiPrice})`);
console.log(`Genre counts: ${GENRES.map(g=>`${g.id}:${byGenre[g.id].length}`).join(' ')}`);
