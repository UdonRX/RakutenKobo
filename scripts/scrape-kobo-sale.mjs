import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const BASE_SALE_URL='https://books.rakuten.co.jp/search?g=101&merch=53626&h=100&v=1&s=8';
const OFFICIAL_INDEX_URL='https://books.rakuten.co.jp/event/e-book/camp-bestprice/index-sp.html';
const outputPath=resolve(process.argv[2]||'kobo-sale.json');
const PAGE_SIZE=100;
const MAX_PAGES_PER_SOURCE=300;
const MAX_DETAIL_PAGES=50;
const MAX_CAMPAIGN_SOURCES=100;
const DETAIL_CONCURRENCY=4;
const PAGE_CONCURRENCY=4;
const SOURCE_CONCURRENCY=3;
const ADULT_WORDS=['アダルト','成年コミック','成人向け','18禁','官能','成人漫画','エロティック','R18','R18+'];
const NON_PRICE_CAMPAIGN_WORDS=['クーポン','ポイント','SPU','エントリー'];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function cleanText(v=''){return String(v).replace(/\u00a0/g,' ').replace(/[ \t\r\f\v]+/g,' ').replace(/\n+/g,'\n').trim()}
function cleanTitle(v=''){return cleanText(v).replace(/^電子\s*/,'').replace(/\s*\[電子書籍版\]\s*$/i,'').replace(/^〖予約〗\s*/,'').trim()}
function normalizeText(v=''){return String(v).normalize('NFKC').toLowerCase().replace(/[\s　・･:：!?！？()（）【】\[\]「」『』〈〉《》#＃―ー\-]/g,'')}
function invalidTitle(title){return /^\d+\s*件$/.test(title)||/^(レビュー|商品レビュー|もっと見る|一覧)$/.test(title)}
function saleEndAtFromText(text){const v=cleanText(text);let m=v.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日(?:[（(][^）)]{0,4}[）)])?\s*(\d{1,2}):(\d{2})まで/);if(!m)m=v.match(/(20\d{2})[\/.](\d{1,2})[\/.](\d{1,2})\s*(\d{1,2}):(\d{2})まで/);if(!m)return'';const[,y,mo,d,h,mi]=m;return`${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}T${String(h).padStart(2,'0')}:${mi}:00+09:00`}
function isExcludedContext(text=''){return ADULT_WORDS.some(w=>text.includes(w))||NON_PRICE_CAMPAIGN_WORDS.some(w=>text.includes(w))}
function authorFromText(text,title=''){
  const direct=String(text).match(/(?:著者|作者)[：:]\s*([^\n／]{1,100})/u);if(direct)return cleanText(direct[1]);
  const lines=cleanText(text).split('\n').map(cleanText).filter(Boolean),titleKey=normalizeText(title);
  const titleIndex=lines.findIndex(line=>normalizeText(cleanTitle(line))===titleKey||normalizeText(line).includes(titleKey));
  const numberIndex=lines.findIndex((line,index)=>index>titleIndex&&/^商品番号[：:]/u.test(line));
  if(titleIndex<0||numberIndex<=titleIndex)return'';
  for(const line of lines.slice(titleIndex+1,numberIndex)){
    if(line.length>100||/^(電子|通常価格|セール価格|シリーズ名|レビュー|商品番号)/u.test(line))continue;
    if(/[円%]|OFF|セール|発売/u.test(line))continue;
    return line;
  }
  return'';
}

async function fetchText(url,timeoutMs=20000,retries=2){let last;for(let attempt=0;attempt<=retries;attempt++){const c=new AbortController(),timer=setTimeout(()=>c.abort(),timeoutMs);try{const r=await fetch(url,{signal:c.signal,headers:{Accept:'text/html,application/xhtml+xml','Accept-Language':'ja-JP,ja;q=0.9,en;q=0.5','User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'}});if(!r.ok)throw new Error(`HTTP_${r.status}`);return await r.text()}catch(error){last=error;if(attempt<retries)await sleep(600*(attempt+1))}finally{clearTimeout(timer)}}throw last}
async function renderHtml(browser,url,{waitMs=1200,timeoutMs=30000}={}){const page=await browser.newPage({userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'});try{await page.goto(url,{waitUntil:'domcontentloaded',timeout:timeoutMs});await page.waitForTimeout(waitMs);return await page.content()}finally{await page.close().catch(()=>{})}}
async function mapLimit(items,limit,fn){const out=new Array(items.length);let cursor=0;async function worker(){while(true){const i=cursor++;if(i>=items.length)return;try{out[i]=await fn(items[i],i)}catch(error){out[i]={error:error.message,item:items[i]}}}}await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));return out}

function findBlock($,element){let node=$(element);for(let i=0;i<9;i++){node=node.parent();if(!node.length)break;const text=cleanText(node.text());if(/通常価格[：:]/.test(text)&&/セール価格[：:]/.test(text))return{node,text}}return null}
function absoluteBookUrl(href=''){try{const u=new URL(href,'https://books.rakuten.co.jp/');return u.hostname==='books.rakuten.co.jp'&&u.pathname.startsWith('/rk/')?u.href:''}catch{return''}}
function parseTotalCount(html){const text=cleanText(cheerio.load(html).root().text());const m=text.match(/全\s*([\d,]+)\s*件/u);return m?Number(m[1].replace(/,/g,'')):0}
function parseSalePage(html,source={},offset=0){
  const $=cheerio.load(html),found=new Map();
  $('a[href*="/rk/"]').each((_,element)=>{
    const title=cleanTitle($(element).text());if(!title||title.length<2||title.length>180||invalidTitle(title))return;
    const block=findBlock($,element);if(!block)return;const text=block.text;if(ADULT_WORDS.some(w=>text.includes(w)))return;
    const regular=text.match(/通常価格[：:]\s*([\d,]+)円/),sale=text.match(/セール価格[：:]\s*([\d,]+)円/);if(!regular||!sale)return;
    const regularPrice=Number(regular[1].replace(/,/g,'')),salePrice=Number(sale[1].replace(/,/g,''));if(!regularPrice||!salePrice||salePrice>=regularPrice)return;
    const url=absoluteBookUrl(String($(element).attr('href')||''));if(!url)return;
    const number=text.match(/商品番号[：:]\s*([0-9A-Za-z-]+)/u);
    const detail=text.match(/(\d{4}年\d{2}月\d{2}日)発売\s*／\s*([^／]+)\s*／\s*([^／]+)\s*／/u);
    const campaignFromCard=text.match(/(〖[^〗]{2,100}〗[^\n]{0,160})/u);
    const reviewCountMatch=text.match(/[（(]\s*(?:レビュー)?\s*([\d,]+)\s*件[）)]/u);
    const reviewAverageMatch=text.match(/([0-5](?:\.\d{1,2})?)\s*[（(]\s*(?:レビュー)?\s*[\d,]+\s*件[）)]/u);
    const seriesMatch=text.match(/シリーズ名[：:]\s*([^\n]{1,140})/u);
    const img=block.node.find('img').first();const image=String(img.attr('src')||img.attr('data-src')||img.attr('data-original')||'').trim();
    const itemNumber=number?.[1]||'',key=itemNumber||url||normalizeText(title);if(!key||found.has(key))return;
    const campaignLabel=source.label||campaignFromCard?.[1]||'';
    const reviewCount=Number((reviewCountMatch?.[1]||'0').replace(/,/g,''))||0;
    const reviewAverage=Number(reviewAverageMatch?.[1]||0)||0;
    const sourceRank=offset+found.size+1;
    found.set(key,{
      title,author:authorFromText(text,title),publisher:cleanText(detail?.[3]||''),series:cleanText(seriesMatch?.[1]||''),itemNumber,url,image,
      salesDate:cleanText(detail?.[1]||''),reviewAverage,reviewCount,sourceRank,
      regularPrice,salePrice,discountPercent:Math.max(1,Math.round((1-salePrice/regularPrice)*100)),saleEndAt:source.endAt||saleEndAtFromText(text),
      saleCampaign:campaignLabel,saleCampaigns:campaignLabel?[campaignLabel]:[],sourceGenre:cleanText(detail?.[2]||''),campaignMerch:source.merch||'',campaignUrl:source.detailUrl||source.url||'',saleSources:[source.type||'rakuten-sale-search']
    });
  });
  return[...found.values()];
}
function pageUrl(source,offset=0){try{const u=new URL(source.url);u.searchParams.set('h',String(PAGE_SIZE));u.searchParams.set('v','1');u.searchParams.delete('maxp');u.searchParams.delete('minp');if(offset>0)u.searchParams.set('o',String(offset));else u.searchParams.delete('o');return u.href}catch{return source.url}}
async function collectAllPages(source){
  const firstUrl=pageUrl(source,0),firstHtml=await fetchText(firstUrl,22000,2),first=parseSalePage(firstHtml,source,0),total=parseTotalCount(firstHtml);
  const pages=total?Math.min(MAX_PAGES_PER_SOURCE,Math.max(1,Math.ceil(total/PAGE_SIZE))):1;
  const all=[...first];console.log(`Sale source ${source.merch}: page 1/${pages}, ${first.length} sale books, total=${total||'unknown'} - ${source.label}`);
  if(pages>1){const offsets=Array.from({length:pages-1},(_,i)=>(i+1)*PAGE_SIZE);const results=await mapLimit(offsets,PAGE_CONCURRENCY,async pageOffset=>{const html=await fetchText(pageUrl(source,pageOffset),22000,2);const items=parseSalePage(html,source,pageOffset);console.log(`Sale source ${source.merch}: offset ${pageOffset}, ${items.length} sale books`);return items});for(const result of results)if(Array.isArray(result))all.push(...result)}
  if(!total){let emptyStreak=0;for(let page=2;page<=MAX_PAGES_PER_SOURCE&&emptyStreak<2;page++){const pageOffset=(page-1)*PAGE_SIZE;const items=parseSalePage(await fetchText(pageUrl(source,pageOffset),22000,1),source,pageOffset);if(!items.length)emptyStreak++;else{emptyStreak=0;all.push(...items)}if(page%5===0)console.log(`Sale source ${source.merch}: probed ${page} pages`);}}
  const merged=new Map();for(const item of all){const key=item.itemNumber||item.url||normalizeText(item.title);const prev=merged.get(key);if(!prev){merged.set(key,item);continue}const prefer=Number(item.reviewCount||0)>Number(prev.reviewCount||0)?item:prev;merged.set(key,{...prefer,sourceRank:Math.min(Number(prev.sourceRank||Infinity),Number(item.sourceRank||Infinity))})}return{source,total,items:[...merged.values()]};
}

function linkContext($,element){let node=$(element),best=cleanText($(element).text());for(let depth=0;depth<8;depth++){node=node.parent();if(!node.length)break;const text=cleanText(node.text());if(text&&text.length<=1800)best=text;if((/OFF|半額|割引|セール|無料|\d+円/.test(text)||/まで/.test(text))&&text.length<=900){best=text;break}}return best}
function labelFromContext(context=''){const bracket=context.match(/〖[^〗]{2,180}〗[^\n]{0,180}/)?.[0];if(bracket)return cleanText(bracket).slice(0,220);return cleanText(context).split('\n').find(line=>line.length>=3&&line.length<=220)||'楽天Kobo公式セール'}
function merchFromHref(href=''){try{const u=new URL(href,'https://books.rakuten.co.jp/'),m=u.searchParams.get('merch');return /^\d+$/.test(String(m||''))?m:''}catch{return''}}
function campaignSearch(merch,source={}){const id=String(merch||'').trim();if(!/^\d+$/.test(id))return null;const p=new URLSearchParams({g:'101',merch:id,h:String(PAGE_SIZE),v:'1',s:'8'});return{id,merch:id,label:source.label||'楽天Kobo公式セール',url:`https://books.rakuten.co.jp/search?${p}`,detailUrl:source.detailUrl||'',type:'kobo-official-campaign',endAt:source.endAt||''}}
function canonicalDetailUrl(href=''){try{const u=new URL(href,'https://books.rakuten.co.jp/');if(u.hostname!=='books.rakuten.co.jp'||!u.pathname.startsWith('/event/e-book/')||!u.searchParams.get('mid'))return'';for(const key of [...u.searchParams.keys()])if(/^l-id$|^scid$|^msockid$/i.test(key))u.searchParams.delete(key);return u.href}catch{return''}}
function discoverIndexLinks(html){const $=cheerio.load(html),direct=new Map(),details=new Map();$('a[href]').each((_,element)=>{const href=String($(element).attr('href')||'').trim();if(!href)return;const context=linkContext($,element),label=labelFromContext(context);if(isExcludedContext(`${label} ${context}`))return;const meta={label,endAt:saleEndAtFromText(context)},merch=merchFromHref(href);if(merch){const source=campaignSearch(merch,meta);if(source)direct.set(source.merch,source);return}const detailUrl=canonicalDetailUrl(href);if(detailUrl&&!details.has(detailUrl))details.set(detailUrl,{detailUrl,...meta})});return{direct:[...direct.values()],details:[...details.values()]}}
function extractMerchIds(html){const ids=new Set(),$=cheerio.load(html);$('a[href*="merch="]').each((_,element)=>{const id=merchFromHref(String($(element).attr('href')||''));if(id)ids.add(id)});const decoded=String(html).replace(/&amp;/g,'&');for(const pattern of [/merch=(\d{3,})/g,/merch%3D(\d{3,})/gi,/merch\\u003d(\d{3,})/gi])for(const m of decoded.matchAll(pattern))ids.add(m[1]);return[...ids]}

const browser=await chromium.launch({headless:true});
try{
  let indexData={direct:[],details:[]};
  try{indexData=discoverIndexLinks(await renderHtml(browser,OFFICIAL_INDEX_URL,{waitMs:2500,timeoutMs:35000}))}catch(error){console.warn(`Official index render failed: ${error.message}`)}
  console.log(`Rendered official sale index: ${indexData.direct.length} direct merch + ${indexData.details.length} detail links`);
  const campaignMap=new Map(indexData.direct.map(item=>[item.merch,item]));
  const detailResults=await mapLimit(indexData.details.slice(0,MAX_DETAIL_PAGES),DETAIL_CONCURRENCY,async detail=>{let html;try{html=await renderHtml(browser,detail.detailUrl,{waitMs:900,timeoutMs:25000})}catch{html=await fetchText(detail.detailUrl,18000,0)}const ids=extractMerchIds(html);console.log(`Official campaign detail: ${ids.length} merch ids - ${detail.label}`);return ids.map(id=>campaignSearch(id,detail)).filter(Boolean)});
  for(const result of detailResults)if(Array.isArray(result))for(const source of result)if(!campaignMap.has(source.merch))campaignMap.set(source.merch,source);
  const base={id:'53626',merch:'53626',label:'楽天ブックス セール一覧',url:BASE_SALE_URL,detailUrl:OFFICIAL_INDEX_URL,type:'rakuten-sale-search',endAt:''};
  const campaigns=[base,...[...campaignMap.values()].filter(item=>item.merch!=='53626').slice(0,MAX_CAMPAIGN_SOURCES)];
  console.log(`Discovered ${campaigns.length} sale sources; crawling every result page`);
  const fetched=await mapLimit(campaigns,SOURCE_CONCURRENCY,collectAllPages);
  const merged=new Map(),sourceCounts={},sourceTotals={};
  function mergeCandidate(item){
    const key=item.itemNumber||item.url||normalizeText(item.title);if(!key)return;const prev=merged.get(key);if(!prev){merged.set(key,item);return}
    const campaignLabels=[...new Set([...(prev.saleCampaigns||[]),...(item.saleCampaigns||[])].filter(Boolean))],sources=[...new Set([...(prev.saleSources||[]),...(item.saleSources||[])].filter(Boolean))];
    const useNew=Number(item.salePrice||Infinity)<Number(prev.salePrice||Infinity),baseItem=useNew?item:prev,reviewBest=Number(item.reviewCount||0)>Number(prev.reviewCount||0)?item:prev;
    merged.set(key,{...baseItem,author:baseItem.author||reviewBest.author||'',publisher:baseItem.publisher||reviewBest.publisher||'',series:baseItem.series||reviewBest.series||'',reviewCount:Math.max(Number(prev.reviewCount||0),Number(item.reviewCount||0)),reviewAverage:Number(reviewBest.reviewAverage||0),sourceRank:Math.min(Number(prev.sourceRank||Infinity),Number(item.sourceRank||Infinity)),saleCampaigns:campaignLabels,saleCampaign:campaignLabels[0]||baseItem.saleCampaign||'',saleSources:sources,saleEndAt:[prev.saleEndAt,item.saleEndAt].filter(Boolean).sort()[0]||''});
  }
  for(const result of fetched){if(!result||result.error){if(result?.item)console.warn(`Sale source ${result.item.merch} failed: ${result.error}`);continue}sourceCounts[result.source.merch]=result.items.length;sourceTotals[result.source.merch]=result.total||result.items.length;for(const item of result.items)mergeCandidate(item)}
  const items=[...merged.values()];if(items.length<5)throw new Error(`SALE_PARSE_TOO_FEW_${items.length}`);
  const payload={sourceUrl:BASE_SALE_URL,officialSaleIndex:OFFICIAL_INDEX_URL,updatedAt:new Date().toISOString(),exhaustive:true,pageSize:PAGE_SIZE,campaignCount:campaigns.length,campaigns,sourceCounts,sourceTotals,items};
  await mkdir(dirname(outputPath),{recursive:true});await writeFile(outputPath,`${JSON.stringify(payload,null,2)}\n`,'utf8');console.log(`Saved ${items.length} unique sale candidates from all pages of ${campaigns.length} sale sources`);
}finally{await browser.close().catch(()=>{})}
