import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const BASE_SALE_URL = 'https://books.rakuten.co.jp/search?g=101&merch=53626&h=100&v=1&s=8&maxp=500';
const OFFICIAL_INDEX_URL = 'https://books.rakuten.co.jp/event/e-book/camp-bestprice/index-sp.html';
const outputPath = resolve(process.argv[2] || 'kobo-sale.json');
const MAX_DETAIL_PAGES = 50;
const MAX_CAMPAIGN_SOURCES = 100;
const DETAIL_CONCURRENCY = 4;
const FETCH_CONCURRENCY = 5;
const ADULT_WORDS = ['アダルト','成年コミック','成人向け','18禁','官能','成人漫画','エロティック','R18','R18+'];
const NON_PRICE_CAMPAIGN_WORDS = ['クーポン','ポイント','SPU','エントリー'];

function cleanText(value = '') { return String(value).replace(/\u00a0/g, ' ').replace(/[ \t\r\f\v]+/g, ' ').replace(/\n+/g, '\n').trim(); }
function cleanTitle(value = '') { return cleanText(value).replace(/^電子\s*/, '').replace(/\s*\[電子書籍版\]\s*$/i, '').replace(/^〖予約〗\s*/, '').trim(); }
function normalizeText(value = '') { return String(value).normalize('NFKC').toLowerCase().replace(/[\s　・･:：!?！？()（）【】\[\]「」『』〈〉《》#＃―ー\-]/g, ''); }
function invalidTitle(title) { return /^\d+\s*件$/.test(title) || /^(レビュー|商品レビュー|もっと見る|一覧)$/.test(title); }
function saleEndAtFromText(text) {
  const value = cleanText(text);
  let match = value.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日(?:[（(][^）)]{0,4}[）)])?\s*(\d{1,2}):(\d{2})まで/);
  if (!match) match = value.match(/(20\d{2})[\/.](\d{1,2})[\/.](\d{1,2})\s*(\d{1,2}):(\d{2})まで/);
  if (!match) return '';
  const [,year,month,day,hour,minute] = match;
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}T${String(hour).padStart(2,'0')}:${minute}:00+09:00`;
}
function isExcludedContext(text='') { return ADULT_WORDS.some(word => text.includes(word)) || NON_PRICE_CAMPAIGN_WORDS.some(word => text.includes(word)); }

async function fetchText(url, timeoutMs = 18000, retries = 1) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { Accept:'text/html,application/xhtml+xml','Accept-Language':'ja-JP,ja;q=0.9,en;q=0.5','User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36' } });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      return await response.text();
    } catch (error) {
      last = error;
      if (attempt < retries) await new Promise(r => setTimeout(r, 450 * (attempt + 1)));
    } finally { clearTimeout(timer); }
  }
  throw last;
}

async function renderHtml(browser,url,{waitMs=1200,timeoutMs=30000}={}){
  const page=await browser.newPage({userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'});
  try{
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:timeoutMs});
    await page.waitForTimeout(waitMs);
    return await page.content();
  }finally{await page.close().catch(()=>{})}
}

function findBlock($, element) {
  let node = $(element);
  for (let i = 0; i < 9; i += 1) {
    node = node.parent(); if (!node.length) break;
    const text = cleanText(node.text());
    if (/通常価格[：:]/.test(text) && /セール価格[：:]/.test(text)) return { node, text };
  }
  return null;
}
function parseSalePage(html, source = {}) {
  const $ = cheerio.load(html), found = new Map();
  $('a[href*="/rk/"]').each((_, element) => {
    const title = cleanTitle($(element).text()); if (!title || title.length < 2 || title.length > 180 || invalidTitle(title)) return;
    const block = findBlock($, element); if (!block) return;
    const text = block.text; if (ADULT_WORDS.some(word => text.includes(word))) return;
    const regular = text.match(/通常価格[：:]\s*([\d,]+)円/), sale = text.match(/セール価格[：:]\s*([\d,]+)円/); if (!regular || !sale) return;
    const regularPrice = Number(regular[1].replace(/,/g,'')), salePrice = Number(sale[1].replace(/,/g,'')); if (!regularPrice || !salePrice || salePrice >= regularPrice) return;
    const number = text.match(/商品番号[：:]\s*([0-9A-Za-z-]+)/), genre = text.match(/\d{4}年\d{2}月\d{2}日発売\s*／\s*([^／]+)\s*／/), campaignFromCard = text.match(/(〖[^〗]{2,100}〗[^\n]{0,160})/);
    const itemNumber = number?.[1] || '', key = itemNumber || normalizeText(title); if (!key || found.has(key)) return;
    const campaignLabel = source.label || campaignFromCard?.[1] || '';
    found.set(key,{title,author:'',itemNumber,regularPrice,salePrice,discountPercent:Math.max(1,Math.round((1-salePrice/regularPrice)*100)),saleEndAt:source.endAt||saleEndAtFromText(text),saleCampaign:campaignLabel,saleCampaigns:campaignLabel?[campaignLabel]:[],sourceGenre:genre?.[1]?.trim()||'',campaignMerch:source.merch||'',campaignUrl:source.detailUrl||source.url||'',saleSources:[source.type||'rakuten-sale-search']});
  });
  return [...found.values()];
}

function linkContext($, element) {
  let node = $(element), best = cleanText($(element).text());
  for (let depth = 0; depth < 8; depth += 1) {
    node = node.parent(); if (!node.length) break;
    const text = cleanText(node.text());
    if (text && text.length <= 1800) best = text;
    if ((/OFF|半額|割引|セール|無料|\d+円/.test(text) || /まで/.test(text)) && text.length <= 900) { best = text; break; }
  }
  return best;
}
function labelFromContext(context = '') { const bracket=context.match(/〖[^〗]{2,180}〗[^\n]{0,180}/)?.[0]; if(bracket)return cleanText(bracket).slice(0,220); return cleanText(context).split('\n').find(line=>line.length>=3&&line.length<=220)||'楽天Kobo公式セール'; }
function merchFromHref(href='') { try { const u=new URL(href,'https://books.rakuten.co.jp/'),merch=u.searchParams.get('merch'); return /^\d+$/.test(String(merch||''))?merch:''; } catch { return ''; } }
function campaignSearch(merch, source = {}) { const id=String(merch||'').trim();if(!/^\d+$/.test(id))return null;const params=new URLSearchParams({g:'101',merch:id,h:'100',v:'1',s:'8',maxp:'500'});return{id,merch:id,label:source.label||'楽天Kobo公式セール',url:`https://books.rakuten.co.jp/search?${params}`,detailUrl:source.detailUrl||'',type:'kobo-official-campaign',endAt:source.endAt||''}; }
function canonicalDetailUrl(href='') { try { const u=new URL(href,'https://books.rakuten.co.jp/');if(u.hostname!=='books.rakuten.co.jp'||!u.pathname.startsWith('/event/e-book/')||!u.searchParams.get('mid'))return'';for(const key of [...u.searchParams.keys()])if(/^l-id$|^scid$|^msockid$/i.test(key))u.searchParams.delete(key);return u.href; } catch { return ''; } }

function discoverIndexLinks(html) {
  const $=cheerio.load(html),direct=new Map(),details=new Map();
  $('a[href]').each((_,element)=>{
    const href=String($(element).attr('href')||'').trim();if(!href)return;
    const context=linkContext($,element),label=labelFromContext(context);if(isExcludedContext(`${label} ${context}`))return;
    const meta={label,endAt:saleEndAtFromText(context)},merch=merchFromHref(href);
    if(merch){const source=campaignSearch(merch,meta);if(source)direct.set(source.merch,source);return;}
    const detailUrl=canonicalDetailUrl(href);if(detailUrl&&!details.has(detailUrl))details.set(detailUrl,{detailUrl,...meta});
  });
  return{direct:[...direct.values()],details:[...details.values()]};
}
function extractMerchIds(html) {
  const ids=new Set(),$=cheerio.load(html);$('a[href*="merch="]').each((_,element)=>{const id=merchFromHref(String($(element).attr('href')||''));if(id)ids.add(id)});
  const decoded=String(html).replace(/&amp;/g,'&');for(const pattern of [/merch=(\d{3,})/g,/merch%3D(\d{3,})/gi,/merch\\u003d(\d{3,})/gi])for(const match of decoded.matchAll(pattern))ids.add(match[1]);return[...ids];
}
async function mapLimit(items,limit,fn){const out=new Array(items.length);let cursor=0;async function worker(){while(true){const index=cursor++;if(index>=items.length)return;try{out[index]=await fn(items[index],index)}catch(error){out[index]={error:error.message,item:items[index]}}}}await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));return out}

const browser=await chromium.launch({headless:true});
let indexData={direct:[],details:[]};
try{
  const indexHtml=await renderHtml(browser,OFFICIAL_INDEX_URL,{waitMs:2500,timeoutMs:35000});
  indexData=discoverIndexLinks(indexHtml);
  console.log(`Rendered official sale index: ${indexData.direct.length} direct merch + ${indexData.details.length} detail links`);
  const campaignMap=new Map(indexData.direct.map(item=>[item.merch,item]));
  const detailResults=await mapLimit(indexData.details.slice(0,MAX_DETAIL_PAGES),DETAIL_CONCURRENCY,async detail=>{
    let html;
    try{html=await renderHtml(browser,detail.detailUrl,{waitMs:900,timeoutMs:25000})}catch{html=await fetchText(detail.detailUrl,16000,0)}
    const ids=extractMerchIds(html);console.log(`Official campaign detail: ${ids.length} merch ids - ${detail.label}`);
    return ids.map(id=>campaignSearch(id,detail)).filter(Boolean);
  });
  for(const result of detailResults)if(Array.isArray(result))for(const source of result)if(!campaignMap.has(source.merch))campaignMap.set(source.merch,source);

  const campaigns=[{id:'53626',merch:'53626',label:'楽天ブックス セール一覧',url:BASE_SALE_URL,detailUrl:OFFICIAL_INDEX_URL,type:'rakuten-sale-search',endAt:''},...[...campaignMap.values()].filter(item=>item.merch!=='53626').slice(0,MAX_CAMPAIGN_SOURCES)];
  console.log(`Discovered ${campaigns.length} sale sources total`);
  const fetched=await mapLimit(campaigns,FETCH_CONCURRENCY,async campaign=>{const html=await fetchText(campaign.url,18000,1);const items=parseSalePage(html,campaign);console.log(`Sale source ${campaign.merch}: ${items.length} candidates - ${campaign.label}`);return{campaign,items}});
  const merged=new Map(),sourceCounts={};
  function mergeCandidate(item){const key=item.itemNumber||normalizeText(item.title);if(!key)return;const prev=merged.get(key);if(!prev){merged.set(key,item);return}const saleCampaigns=[...new Set([...(prev.saleCampaigns||[]),...(item.saleCampaigns||[])].filter(Boolean))],saleSources=[...new Set([...(prev.saleSources||[]),...(item.saleSources||[])].filter(Boolean))],useNew=Number(item.salePrice||Infinity)<Number(prev.salePrice||Infinity),base=useNew?item:prev;merged.set(key,{...base,saleCampaigns,saleCampaign:saleCampaigns[0]||base.saleCampaign||'',saleSources,saleEndAt:[prev.saleEndAt,item.saleEndAt].filter(Boolean).sort()[0]||''})}
  for(const result of fetched){if(!result||result.error){if(result?.item)console.warn(`Sale source ${result.item.merch} failed: ${result.error}`);continue}sourceCounts[result.campaign.merch]=result.items.length;for(const item of result.items)mergeCandidate(item)}
  const items=[...merged.values()].sort((a,b)=>Number(b.discountPercent||0)-Number(a.discountPercent||0));if(items.length<5)throw new Error(`SALE_PARSE_TOO_FEW_${items.length}`);
  const payload={sourceUrl:BASE_SALE_URL,officialSaleIndex:OFFICIAL_INDEX_URL,updatedAt:new Date().toISOString(),campaignCount:campaigns.length,detailCampaignCount:indexData.details.length,campaigns,sourceCounts,items};
  await mkdir(dirname(outputPath),{recursive:true});await writeFile(outputPath,`${JSON.stringify(payload,null,2)}\n`,'utf8');console.log(`Saved ${items.length} merged sale candidates from ${campaigns.length} sale sources to ${outputPath}`);
}finally{await browser.close().catch(()=>{})}
