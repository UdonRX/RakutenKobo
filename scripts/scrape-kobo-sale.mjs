import * as cheerio from 'cheerio';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const SALE_SEARCH_URL='https://books.rakuten.co.jp/search';
const OFFICIAL_INDEX_URL='https://books.rakuten.co.jp/event/e-book/index-sp.html';
const SALE_MERCH_ID='53626';
const ROOT_GENRE_ID='101';
const outputPath=resolve(process.argv[2]||'kobo-sale.json');
const PAGE_SIZE=100;
const MAX_PAGES_PER_QUERY=300;
const PAGE_CONCURRENCY=4;
const FETCH_TIMEOUT_MS=24000;
const FETCH_RETRIES=2;
const ADULT_WORDS=['アダルト','成年コミック','成人向け','18禁','官能','成人漫画','エロティック','R18','R18+'];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function cleanText(v=''){return String(v).replace(/\u00a0/g,' ').replace(/[ \t\r\f\v]+/g,' ').replace(/\n+/g,'\n').trim()}
function cleanTitle(v=''){return cleanText(v).replace(/^電子\s*/,'').replace(/\s*\[電子書籍版\]\s*$/i,'').replace(/^〖予約〗\s*/,'').trim()}
function normalizeText(v=''){return String(v).normalize('NFKC').toLowerCase().replace(/[\s　・･:：!?！？()（）【】\[\]「」『』〈〉《》#＃―ー\-]/g,'')}
function invalidTitle(title){return /^\d+\s*件$/.test(title)||/^(レビュー|商品レビュー|もっと見る|一覧)$/u.test(title)}
function saleEndAtFromText(text=''){
  const v=cleanText(text);
  let m=v.match(/(?:_|\b)(20\d{2})-(\d{1,2})-(\d{1,2})\s*(\d{1,2}):(\d{2})まで/u);
  if(!m)m=v.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日(?:[（(][^）)]{0,4}[）)])?\s*(\d{1,2}):(\d{2})まで/u);
  if(!m)m=v.match(/(20\d{2})[\/.](\d{1,2})[\/.](\d{1,2})\s*(\d{1,2}):(\d{2})まで/u);
  if(!m)return'';
  const[,y,mo,d,h,mi]=m;
  return`${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}T${String(h).padStart(2,'0')}:${mi}:00+09:00`;
}
function authorFromText(text,title=''){
  const direct=String(text).match(/(?:著者|作者)[：:]\s*([^\n／]{1,120})/u);if(direct)return cleanText(direct[1]);
  const lines=String(text).split(/\n+/).map(cleanText).filter(Boolean),titleKey=normalizeText(title);
  const titleIndex=lines.findIndex(line=>{const key=normalizeText(cleanTitle(line));return key===titleKey||key.includes(titleKey)||titleKey.includes(key)});
  const numberIndex=lines.findIndex((line,index)=>index>titleIndex&&/^商品番号[：:]/u.test(line));
  if(titleIndex<0||numberIndex<=titleIndex)return'';
  for(const line of lines.slice(titleIndex+1,numberIndex)){
    if(line.length>160||/^(電子|通常価格|セール価格|シリーズ名|レビュー|商品番号|対応端末|紙書籍版)/u.test(line))continue;
    if(/[円%]|OFF|セール|発売/u.test(line))continue;
    return line.replace(/\s*,\s*/g,', ').trim();
  }
  return'';
}
function absoluteBookUrl(href=''){try{const u=new URL(href,'https://books.rakuten.co.jp/');return u.hostname==='books.rakuten.co.jp'&&u.pathname.startsWith('/rk/')?u.href:''}catch{return''}}
function absoluteImageUrl(src=''){try{return src?new URL(src,'https://books.rakuten.co.jp/').href:''}catch{return String(src||'')}}
function parseTotalCount(html){const text=cleanText(cheerio.load(html).root().text());const m=text.match(/全\s*([\d,]+)\s*件/u);return m?Number(m[1].replace(/,/g,'')):0}
function structuredText(node){
  const html=String(node?.html?.()||'')
    .replace(/<br\s*\/?>/gi,'\n')
    .replace(/<\/(?:p|div|li|dd|dt|h[1-6]|tr|section|article|ul|ol)>/gi,'\n');
  return cleanText(cheerio.load(`<div>${html}</div>`).root().text());
}
function findProductBlock($,element){
  let node=$(element),fallback=null;
  for(let i=0;i<12;i++){
    node=node.parent();if(!node.length)break;
    const text=structuredText(node),hasPrice=/通常価格[：:]/.test(text)&&/セール価格[：:]/.test(text);
    if(hasPrice&&!fallback&&text.length<14000)fallback={node,text};
    if(hasPrice&&/商品番号[：:]/.test(text)&&text.length<14000)return{node,text};
  }
  return fallback;
}

async function fetchText(url,timeoutMs=FETCH_TIMEOUT_MS,retries=FETCH_RETRIES){
  let lastError;
  for(let attempt=0;attempt<=retries;attempt++){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      const response=await fetch(url,{signal:controller.signal,headers:{Accept:'text/html,application/xhtml+xml','Accept-Language':'ja-JP,ja;q=0.9,en;q=0.5','User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'}});
      if(!response.ok)throw new Error(`HTTP_${response.status}`);
      return await response.text();
    }catch(error){
      lastError=error;
      if(attempt<retries)await sleep(800*(attempt+1));
    }finally{clearTimeout(timer)}
  }
  throw lastError;
}
async function mapLimit(items,limit,fn){const out=new Array(items.length);let cursor=0;async function worker(){while(true){const i=cursor++;if(i>=items.length)return;try{out[i]=await fn(items[i],i)}catch(error){out[i]={error:error?.message||String(error),item:items[i]}}}}await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));return out}

function buildSearchUrl({min=null,max=null,offset=0}={}){
  const params=new URLSearchParams({g:ROOT_GENRE_ID,merch:SALE_MERCH_ID,h:String(PAGE_SIZE),v:'1',s:'8'});
  if(min!=null&&min>0)params.set('minp',String(min));
  if(max!=null)params.set('maxp',String(max));
  if(offset>0)params.set('o',String(offset));
  return`${SALE_SEARCH_URL}?${params}`;
}
function parseSalePage(html,{label='楽天Kobo公式セール',rangeOrder=0,offset=0}={}){
  const $=cheerio.load(html),found=new Map();
  $('a[href*="/rk/"]').each((_,element)=>{
    const title=cleanTitle($(element).text());if(!title||title.length<2||title.length>180||invalidTitle(title))return;
    const block=findProductBlock($,element);if(!block)return;const text=block.text;if(ADULT_WORDS.some(w=>text.includes(w)))return;
    const regular=text.match(/通常価格[：:]\s*([\d,]+)円/u),sale=text.match(/セール価格[：:]\s*([\d,]+)円/u);if(!regular||!sale)return;
    const regularPrice=Number(regular[1].replace(/,/g,'')),salePrice=Number(sale[1].replace(/,/g,''));if(!regularPrice||!salePrice||salePrice>=regularPrice)return;
    const url=absoluteBookUrl(String($(element).attr('href')||''));if(!url)return;
    const number=text.match(/商品番号[：:]\s*([0-9A-Za-z-]+)/u);
    const detail=text.match(/(\d{4}年\d{2}月\d{2}日)発売\s*／\s*([^／]+)\s*／\s*([^／]+)\s*／/u);
    const campaignFromCard=text.match(/(〖[^〗]{2,120}〗[^\n]{0,220}?(?:20\d{2}[-\/.年]\d{1,2}[-\/.月]\d{1,2}(?:日)?\s*\d{1,2}:\d{2}まで))/u)?.[1]
      ||text.match(/(〖[^〗]{2,120}〗[^\n]{0,220})/u)?.[1]||'';
    const reviewCount=Number((text.match(/[（(]\s*(?:レビュー)?\s*([\d,]+)\s*件[）)]/u)?.[1]||'0').replace(/,/g,''))||0;
    const reviewAverage=Number(text.match(/([0-5](?:\.\d{1,2})?)\s*[（(]\s*(?:レビュー)?\s*[\d,]+\s*件[）)]/u)?.[1]||0)||0;
    const series=cleanText(text.match(/シリーズ名[：:]\s*([^\n]{1,160})/u)?.[1]||'');
    const img=block.node.find('img').first();
    const image=absoluteImageUrl(String(img.attr('src')||img.attr('data-src')||img.attr('data-original')||''));
    const itemNumber=number?.[1]||'',key=itemNumber||url||normalizeText(title);if(!key||found.has(key))return;
    const campaignLabel=cleanText(campaignFromCard)||label;
    const saleEndAt=saleEndAtFromText(campaignFromCard)||saleEndAtFromText(text);
    found.set(key,{
      title,author:authorFromText(text,title),publisher:cleanText(detail?.[3]||''),series,itemNumber,url,image,
      salesDate:cleanText(detail?.[1]||''),reviewAverage,reviewCount,sourceRank:rangeOrder*1000000+offset+found.size+1,
      regularPrice,salePrice,discountPercent:Math.max(1,Math.round((1-salePrice/regularPrice)*100)),saleEndAt,
      saleCampaign:campaignLabel,saleCampaigns:campaignLabel?[campaignLabel]:[],sourceGenre:cleanText(detail?.[2]||''),campaignMerch:SALE_MERCH_ID,
      campaignUrl:OFFICIAL_INDEX_URL,saleSources:['rakuten-books-official-sale-listing']
    });
  });
  return[...found.values()];
}
function richer(a,b){
  const score=x=>(x.author?3:0)+(x.saleEndAt?3:0)+(x.image?2:0)+(x.publisher?1:0)+(x.series?1:0)+Math.min(3,Math.log10(Number(x.reviewCount||0)+1));
  const preferred=score(b)>score(a)?b:a,other=preferred===a?b:a;
  return{...other,...preferred,sourceRank:Math.min(Number(a.sourceRank||Infinity),Number(b.sourceRank||Infinity))};
}

async function collectRange(range,rangeOrder){
  const firstUrl=buildSearchUrl({...range,offset:0});
  const firstHtml=await fetchText(firstUrl),total=parseTotalCount(firstHtml);
  if(total>PAGE_SIZE*MAX_PAGES_PER_QUERY&&range.max!=null&&range.max>range.min){
    const mid=Math.floor((range.min+range.max)/2);
    console.log(`Price range ${range.min}-${range.max}: ${total} results exceeds 300 pages; splitting at ${mid}`);
    const left=await collectRange({min:range.min,max:mid,label:`${range.label} lower`},rangeOrder*2+1);
    const right=await collectRange({min:mid+1,max:range.max,label:`${range.label} upper`},rangeOrder*2+2);
    return{total:left.total+right.total,items:[...left.items,...right.items],parts:[...left.parts,...right.parts]};
  }
  const pages=Math.min(MAX_PAGES_PER_QUERY,Math.max(1,Math.ceil((total||PAGE_SIZE)/PAGE_SIZE)));
  const all=parseSalePage(firstHtml,{label:range.label,rangeOrder,offset:0});
  console.log(`Price ${range.label}: page 1/${pages}, ${all.length} sale books, total=${total||'unknown'}`);
  if(pages>1){
    const offsets=Array.from({length:pages-1},(_,i)=>(i+1)*PAGE_SIZE);
    const results=await mapLimit(offsets,PAGE_CONCURRENCY,async offset=>{
      const html=await fetchText(buildSearchUrl({...range,offset}));
      const items=parseSalePage(html,{label:range.label,rangeOrder,offset});
      if(offset%1000===0||offset===offsets.at(-1))console.log(`Price ${range.label}: offset ${offset}, ${items.length} sale books`);
      return items;
    });
    for(const result of results)if(Array.isArray(result))all.push(...result);
  }
  return{total:total||all.length,items:all,parts:[{...range,total,pages}]};
}

const globalHtml=await fetchText(buildSearchUrl({}));
const officialTotal=parseTotalCount(globalHtml);
console.log(`Official Rakuten Kobo sale count: ${officialTotal||'unknown'}`);

const baseRanges=[
  {min:0,max:199,label:'199円以下'},
  {min:200,max:299,label:'200〜299円'},
  {min:300,max:399,label:'300〜399円'},
  {min:400,max:599,label:'400〜599円'},
  {min:600,max:999,label:'600〜999円'},
  {min:1000,max:1499,label:'1,000〜1,499円'},
  {min:1500,max:1999,label:'1,500〜1,999円'},
  {min:2000,max:2999,label:'2,000〜2,999円'},
  {min:3000,max:4999,label:'3,000〜4,999円'},
  {min:5000,max:9999,label:'5,000〜9,999円'},
  {min:10000,max:null,label:'10,000円以上'}
];
const merged=new Map(),parts=[];
for(let i=0;i<baseRanges.length;i++){
  const result=await collectRange(baseRanges[i],i+1);parts.push(...result.parts);
  for(const item of result.items){const key=item.itemNumber||item.url||`${normalizeText(item.title)}|${normalizeText(item.author)}`;if(!key)continue;merged.set(key,merged.has(key)?richer(merged.get(key),item):item)}
}
const items=[...merged.values()].filter(item=>item?.title&&Number(item.regularPrice)>Number(item.salePrice)&&Number(item.salePrice)>0);
items.forEach((item,index)=>{item.sourceOrder=index+1});
const authorCount=items.filter(item=>item.author).length,endCount=items.filter(item=>item.saleEndAt).length,itemNumberCount=items.filter(item=>item.itemNumber).length;
console.log(`Sale metadata: authors=${authorCount}/${items.length}, endDates=${endCount}/${items.length}, itemNumbers=${itemNumberCount}/${items.length}`);
if(items.length>=100&&authorCount/items.length<0.70)throw new Error(`SALE_AUTHOR_PARSE_REGRESSION_${authorCount}_OF_${items.length}`);
await mkdir(dirname(outputPath),{recursive:true});
await writeFile(outputPath,`${JSON.stringify({kind:'sale-candidates',completed:true,exhaustive:true,scannedExhaustive:true,sourceUrl:buildSearchUrl({}),officialSaleIndex:OFFICIAL_INDEX_URL,officialTotal,updatedAt:new Date().toISOString(),priceBuckets:parts,scanned:items.length,metadata:{authors:authorCount,saleEndDates:endCount,itemNumbers:itemNumberCount},items},null,2)}\n`,'utf8');
console.log(`Saved ${items.length} unique sale books across ${parts.length} non-overlapping price ranges (official=${officialTotal||'unknown'})`);
