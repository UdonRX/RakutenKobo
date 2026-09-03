import * as cheerio from 'cheerio';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { GENRES } from '../catalog.js';

const API_BASE=String(process.env.KOBO_API_BASE||'https://rakuten-kobo.vercel.app').replace(/\/+$/,'');
const outputDir=resolve(process.argv[2]||'/tmp/completed-feeds');
const saleInputPath=resolve(process.argv[3]||'/tmp/kobo-sale-candidates.json');
const TARGET_PER_GENRE=10;
const SALE_CAMPAIGN_MAX_PAGES=3;
const SALE_PAGE_CONCURRENCY=4;
const POPULAR_MAX_PAGES=4;
const ADULT_WORDS=['アダルト','成年コミック','成人向け','18禁','官能','成人漫画','エロティック','R18','R18+'];
const LIGHT_NOVEL_WORDS=['ライトノベル','ラノベ','電撃文庫','MF文庫J','GA文庫','富士見ファンタジア文庫','ガガガ文庫'];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function normalize(value=''){return String(value).normalize('NFKC').toLowerCase().replace(/[〜～]/g,'〜').replace(/[\s　・･:：!?！？()（）【】\[\]「」『』〈〉《》#＃―ー\-]/g,'')}
function cleanText(value=''){return String(value).replace(/\u00a0/g,' ').replace(/[ \t\r\f\v]+/g,' ').replace(/\n+/g,'\n').trim()}
function cleanTitle(value=''){return cleanText(value).replace(/^電子\s*/,'').replace(/\s*\[電子書籍版\]\s*$/i,'').replace(/^〖予約〗\s*/,'').trim()}
function bookKey(book){const id=String(book?.id||book?.isbn||'').trim();return id?`id:${id}`:`t:${normalize(book?.title)}|${normalize(book?.author)}`}
function candidateKey(item){const number=String(item?.itemNumber||item?.isbn||'').trim();return number?`n:${number}`:`t:${normalize(item?.originalTitle||item?.title||'')}`}
function searchableText(item){return [item?.title,item?.author,item?.publisher,item?.caption,item?.series,item?.sourceGenre].filter(Boolean).join(' ')}
function isAdult(item){const text=searchableText(item);return ADULT_WORDS.some(w=>text.includes(w))}
function isLightNovel(item){const text=searchableText(item);return LIGHT_NOVEL_WORDS.some(w=>text.includes(w))}
function isEssay(item){return /エッセイ|随筆/u.test(searchableText(item))}
function dedupe(list){const seen=new Set(),out=[];for(const item of list||[]){const key=bookKey(item);if(!key||seen.has(key)||isAdult(item))continue;seen.add(key);out.push(item)}return out}
function genreIds(value=''){return String(value||'').split('/').map(v=>v.trim()).filter(Boolean)}
function matchesGenre(book,id){return !id||genreIds(book?.genreId).some(v=>v===id||v.startsWith(id))}
function matchesTarget(book,genre,info){if(info?.keywordOnly)return genre.id==='essay'?isEssay(book):true;return matchesGenre(book,info?.id)}
function genreParams(genre){return {genreKey:genre.id,genreNames:genre.names.join('|'),parentNames:genre.parentNames.join('|'),fallbackQuery:genre.fallbackQuery,excludeLightNovel:genre.excludeLightNovel?'1':'0'}}

async function fetchJson(url,options={},timeoutMs=25000,retries=1){let last;for(let attempt=0;attempt<=retries;attempt++){const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeoutMs);try{const response=await fetch(url,{...options,signal:controller.signal});const text=await response.text();let data={};try{data=text?JSON.parse(text):{}}catch{data={raw:text.slice(0,300)}}if(!response.ok)throw new Error(data?.detail||data?.error||`HTTP_${response.status}`);return data}catch(error){last=error;if(attempt<retries)await sleep(500*(attempt+1))}finally{clearTimeout(timer)}}throw last}
async function fetchText(url,timeoutMs=22000,retries=1){let last;for(let attempt=0;attempt<=retries;attempt++){const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeoutMs);try{const response=await fetch(url,{signal:controller.signal,headers:{Accept:'text/html,application/xhtml+xml','Accept-Language':'ja-JP,ja;q=0.9,en;q=0.5','User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'}});if(!response.ok)throw new Error(`HTTP_${response.status}`);return await response.text()}catch(error){last=error;if(attempt<retries)await sleep(400*(attempt+1))}finally{clearTimeout(timer)}}throw last}

async function resolveGenre(genre){const p=new URLSearchParams({action:'genre-resolve',genreKey:genre.id,genreNames:genre.names.join('|'),parentNames:genre.parentNames.join('|')});const data=await fetchJson(`${API_BASE}/api/kobo?${p}`,{headers:{Accept:'application/json'}},18000,1);return data.resolvedGenre||null}
async function resolveGenreInfo(genre){const resolved=await resolveGenre(genre).catch(()=>null);if(resolved?.id)return{id:String(resolved.id),name:resolved.name||genre.label,keywordOnly:false};if(genre.id==='essay')return{id:'',name:'エッセイ',keywordOnly:true};return null}
async function resolveChunk(items){if(!items.length)return[];const data=await fetchJson(`${API_BASE}/api/kobo?action=resolve`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({items:items.slice(0,12)})},30000,1);return data.items||[]}
async function resolveList(items){const out=[];for(let i=0;i<items.length;i+=8){try{out.push(...await resolveChunk(items.slice(i,i+8)))}catch(error){console.warn(`Sale resolve chunk failed: ${error.message}`);await sleep(1000)}if(i+8<items.length)await sleep(140)}return dedupe(out)}

function saleEndAtFromText(text){const value=cleanText(text);let m=value.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日(?:[（(][^）)]{0,4}[）)])?\s*(\d{1,2}):(\d{2})まで/);if(!m)m=value.match(/(20\d{2})[\/.](\d{1,2})[\/.](\d{1,2})\s*(\d{1,2}):(\d{2})まで/);if(!m)return'';const[,y,mo,d,h,mi]=m;return`${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}T${String(h).padStart(2,'0')}:${mi}:00+09:00`}
function findSaleBlock($,element){let node=$(element);for(let i=0;i<9;i++){node=node.parent();if(!node.length)break;const text=cleanText(node.text());if(/通常価格[：:]/.test(text)&&/セール価格[：:]/.test(text))return{node,text}}return null}
function parseSaleHtml(html,source={}){const $=cheerio.load(html),found=new Map();$('a[href*="/rk/"]').each((_,element)=>{const title=cleanTitle($(element).text());if(!title||title.length<2||title.length>180||/^\d+\s*件$/.test(title))return;const block=findSaleBlock($,element);if(!block)return;const text=block.text;if(ADULT_WORDS.some(w=>text.includes(w)))return;const regular=text.match(/通常価格[：:]\s*([\d,]+)円/),sale=text.match(/セール価格[：:]\s*([\d,]+)円/);if(!regular||!sale)return;const regularPrice=Number(regular[1].replace(/,/g,'')),salePrice=Number(sale[1].replace(/,/g,''));if(!regularPrice||!salePrice||salePrice>=regularPrice)return;const number=text.match(/商品番号[：:]\s*([0-9A-Za-z-]+)/);const sourceGenre=text.match(/\d{4}年\d{2}月\d{2}日発売\s*／\s*([^／]+)\s*／/);const cardCampaign=text.match(/(〖[^〗]{2,100}〗[^\n]{0,160})/);const itemNumber=number?.[1]||'';const key=itemNumber||normalize(title);if(!key||found.has(key))return;const label=source.label||cardCampaign?.[1]||'';found.set(key,{title,author:'',itemNumber,regularPrice,salePrice,discountPercent:Math.max(1,Math.round((1-salePrice/regularPrice)*100)),saleEndAt:source.endAt||saleEndAtFromText(text),saleCampaign:label,saleCampaigns:label?[label]:[],sourceGenre:sourceGenre?.[1]?.trim()||'',campaignMerch:source.merch||source.id||'',campaignUrl:source.url||'',saleSources:[source.type||'kobo-official-campaign']})});return[...found.values()]}

function verifiedSaleBook(book){
  const meta=book?.matchMeta||{};
  const regularPrice=Number(meta.regularPrice||book?.regularPrice||0);
  const livePrice=Number(book?.price||0);
  const url=String(book?.url||'');
  if(!book?.id||!regularPrice||!livePrice||livePrice>=regularPrice||!/^https:\/\/books\.rakuten\.co\.jp\/rk\//.test(url))return null;
  const saleCampaigns=[...new Set([...(meta.saleCampaigns||[]),meta.saleCampaign,book.saleCampaign].filter(Boolean))];
  return {
    ...book,
    price:livePrice,
    regularPrice,
    salePrice:livePrice,
    discountPercent:Math.max(1,Math.round((1-livePrice/regularPrice)*100)),
    saleEndAt:meta.saleEndAt||book.saleEndAt||'',
    saleCampaign:saleCampaigns[0]||'',
    saleCampaigns,
    sourceGenre:meta.sourceGenre||book.sourceGenre||'',
    saleSources:[...new Set([...(meta.saleSources||[]),...(book.saleSources||[])].filter(Boolean))],
    campaignMerch:meta.campaignMerch||book.campaignMerch||'',
    campaignUrl:meta.campaignUrl||book.campaignUrl||'',
    saleVerified:true,
    verifiedAt:new Date().toISOString()
  };
}

function pagedCampaignUrl(campaign,page){
  try{
    const url=new URL(campaign.url);
    url.searchParams.set('h','100');url.searchParams.set('v','1');url.searchParams.set('maxp','500');
    if(page>1)url.searchParams.set('o',String((page-1)*30));else url.searchParams.delete('o');
    return url.href;
  }catch{return campaign.url||''}
}

function allGenresComplete(buckets){return GENRES.every(genre=>(buckets[genre.id]||[]).length>=TARGET_PER_GENRE)}
function bucketStatus(buckets){return GENRES.map(genre=>`${genre.id}:${(buckets[genre.id]||[]).length}`).join(' ')}

async function fillSaleGenres(sale,rawSale,genreInfo){
  const buckets={};
  for(const genre of GENRES){
    const info=genreInfo[genre.id];
    const seed=(sale.items||[]).map(book=>book.saleVerified?book:verifiedSaleBook(book)).filter(Boolean).filter(book=>info&&matchesTarget(book,genre,info)&&(!genre.excludeLightNovel||!isLightNovel(book)));
    buckets[genre.id]=dedupe(seed).slice(0,TARGET_PER_GENRE);
  }

  const seenCandidates=new Set();
  const verifiedPool=dedupe((sale.items||[]).map(book=>book.saleVerified?book:verifiedSaleBook(book)).filter(Boolean));
  const verifiedByKey=new Map(verifiedPool.map(book=>[bookKey(book),book]));
  let checked=0,failed=0;

  async function applyCandidates(entries){
    const fresh=[];
    for(const entry of entries||[]){
      if(!entry?.title||Number(entry.regularPrice)<=Number(entry.salePrice)||Number(entry.salePrice)<=0)continue;
      const key=candidateKey(entry);if(!key||seenCandidates.has(key))continue;seenCandidates.add(key);fresh.push(entry);
    }
    for(let i=0;i<fresh.length&&!allGenresComplete(buckets);i+=8){
      const chunk=fresh.slice(i,i+8);checked+=chunk.length;
      let resolved=[];
      try{resolved=await resolveList(chunk)}catch(error){failed+=chunk.length;console.warn(`Sale candidate batch failed: ${error.message}`)}
      for(const rawBook of resolved){
        const book=verifiedSaleBook(rawBook);if(!book)continue;
        verifiedByKey.set(bookKey(book),book);
        for(const genre of GENRES){
          const info=genreInfo[genre.id];if(!info||(buckets[genre.id]||[]).length>=TARGET_PER_GENRE)continue;
          if(!matchesTarget(book,genre,info)||(genre.excludeLightNovel&&isLightNovel(book)))continue;
          buckets[genre.id]=dedupe([...(buckets[genre.id]||[]),book]).slice(0,TARGET_PER_GENRE);
        }
      }
      if(i+8<fresh.length&&!allGenresComplete(buckets))await sleep(150);
    }
  }

  await applyCandidates(rawSale.items||[]);
  console.log(`Sale genre fill after first-page campaign pool: ${bucketStatus(buckets)}`);

  const campaigns=Array.isArray(rawSale.campaigns)?rawSale.campaigns:[];
  for(let page=2;page<=SALE_CAMPAIGN_MAX_PAGES&&!allGenresComplete(buckets);page++){
    const pages=await mapLimit(campaigns,SALE_PAGE_CONCURRENCY,async campaign=>{
      const url=pagedCampaignUrl(campaign,page);if(!url)return[];
      try{return parseSaleHtml(await fetchText(url,20000,1),campaign)}
      catch(error){console.warn(`Sale campaign ${campaign.merch||campaign.id} page ${page} failed: ${error.message}`);return[]}
    });
    const candidates=pages.flatMap(result=>Array.isArray(result)?result:[]);
    if(!candidates.length)break;
    await applyCandidates(candidates);
    console.log(`Sale genre fill after campaign page ${page}: ${bucketStatus(buckets)}`);
  }

  const allVerified=dedupe([...verifiedByKey.values()]);
  return {buckets,allVerified,checked,failed,campaignsUsed:campaigns.length};
}

function rankingSource(book,index){const sources=book?.ranking?.sources||book?.matchMeta?.sources||[];if(sources.length)return book;return{...book,ranking:{...(book.ranking||{}),title:book.title,author:book.author,source:'kobo',sources:[{source:'kobo',label:'楽天Kobo人気',rank:index+1}],rank:index+1}}}
async function fillPopularGenre(genre,info,seed=[]){let out=dedupe(seed.filter(b=>matchesTarget(b,genre,info)&&(!genre.excludeLightNovel||!isLightNovel(b)))).slice(0,TARGET_PER_GENRE);for(let page=1;page<=POPULAR_MAX_PAGES&&out.length<TARGET_PER_GENRE;page++){const p=new URLSearchParams({action:'search',...genreParams(genre),sort:'reviewCount',hits:'30',page:String(page)});let data;try{data=await fetchJson(`${API_BASE}/api/kobo?${p}`,{headers:{Accept:'application/json'}},25000,1)}catch(error){console.warn(`Popular ${genre.id} page ${page} failed: ${error.message}`);await sleep(1100);continue}const supplement=(data.items||[]).filter(b=>matchesTarget(b,genre,info)&&(!genre.excludeLightNovel||!isLightNovel(b))).map((b,i)=>rankingSource(b,(page-1)*30+i));out=dedupe([...out,...supplement]).slice(0,TARGET_PER_GENRE);console.log(`Popular ${genre.id}: ${out.length}/${TARGET_PER_GENRE} after Kobo page ${page}`);if(out.length<TARGET_PER_GENRE)await sleep(250)}return{items:out,target:TARGET_PER_GENRE,complete:out.length>=TARGET_PER_GENRE}}

async function mapLimit(items,limit,fn){const out=new Array(items.length);let cursor=0;async function worker(){while(true){const index=cursor++;if(index>=items.length)return;try{out[index]=await fn(items[index],index)}catch(error){out[index]={genre:items[index]?.id,error:error.message,items:[],complete:false}}}}await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));return out}
async function readFeed(name){return JSON.parse(await readFile(join(outputDir,name),'utf8'))}
async function writeFeed(name,data){await writeFile(join(outputDir,name),`${JSON.stringify(data,null,2)}\n`,'utf8')}

const genreInfoEntries=await mapLimit(GENRES,3,async genre=>[genre.id,await resolveGenreInfo(genre)]);
const genreInfo=Object.fromEntries(genreInfoEntries.filter(entry=>Array.isArray(entry)&&entry[1]));
console.log(`Resolved ${Object.keys(genreInfo).length}/${GENRES.length} genre strategies`);

const sale=await readFeed('kobo-sale.json');
const rawSale=JSON.parse(await readFile(saleInputPath,'utf8'));
const saleFill=await fillSaleGenres(sale,rawSale,genreInfo);
sale.byGenre={};sale.genreStatus={};
for(const genre of GENRES){
  const items=saleFill.buckets[genre.id]||[];
  sale.byGenre[genre.id]=items;
  sale.genreStatus[genre.id]={target:TARGET_PER_GENRE,matched:items.length,complete:items.length>=TARGET_PER_GENRE,error:genreInfo[genre.id]?'':'GENRE_UNRESOLVED'};
}
sale.items=dedupe([...saleFill.allVerified,...(sale.items||[]).filter(book=>book.saleVerified)]).slice(0,60);
sale.candidateCount=Number(rawSale.items?.length||sale.candidateCount||sale.items.length);
sale.campaignCount=Number(rawSale.campaignCount||rawSale.campaigns?.length||0);
sale.campaigns=rawSale.campaigns||[];
sale.officialSaleIndex=rawSale.officialSaleIndex||'';
sale.saleVerification='live-kobo-api';
sale.genreTarget=TARGET_PER_GENRE;
sale.genreChecked=saleFill.checked;
sale.genreFailed=saleFill.failed;
sale.updatedAt=new Date().toISOString();
await writeFeed('kobo-sale.json',sale);
console.log(`Enriched kobo-sale.json from ${saleFill.campaignsUsed} official sale sources; ${bucketStatus(saleFill.buckets)}`);

for(const period of ['week','month','year']){const name=`popular-${period}.json`;const feed=await readFeed(name);const results=await mapLimit(GENRES,3,async genre=>{const info=genreInfo[genre.id];if(!info)return{genre:genre.id,items:[],target:TARGET_PER_GENRE,complete:false,error:'GENRE_UNRESOLVED'};return{genre:genre.id,...await fillPopularGenre(genre,info,feed.items||[])}});feed.byGenre={};feed.genreStatus={};for(const result of results){if(!result?.genre)continue;feed.byGenre[result.genre]=result.items||[];feed.genreStatus[result.genre]={target:TARGET_PER_GENRE,matched:(result.items||[]).length,complete:Boolean(result.complete),error:result.error||''}}feed.genreTarget=TARGET_PER_GENRE;feed.updatedAt=new Date().toISOString();await writeFeed(name,feed);console.log(`Enriched ${name} by genre`)}
