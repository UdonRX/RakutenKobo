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
const FETCH_TIMEOUT_MS=30000;
const FETCH_RETRIES=3;
const RECOVERY_FETCH_TIMEOUT_MS=45000;
const RECOVERY_FETCH_RETRIES=4;
const RETRY_BACKOFF_MS=800;
const SCRIPT_WATCHDOG_MS=50*60*1000;
const ADULT_WORDS=['アダルト','成年コミック','成人向け','18禁','官能','成人漫画','エロティック','R18','R18+'];
const BLOCK_TEXT_TAGS=new Set(['p','div','li','dd','dt','h1','h2','h3','h4','h5','h6','tr','section','article','ul','ol']);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const yieldToEventLoop=()=>new Promise(resolve=>setImmediate(resolve));

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
function appendStructuredText(node,chunks){
  if(!node)return;
  if(node.type==='text'){
    chunks.push(node.data||'');
    return;
  }
  const name=String(node.name||'').toLowerCase();
  if(name==='br'){
    chunks.push('\n');
    return;
  }
  for(const child of node.children||[])appendStructuredText(child,chunks);
  if(BLOCK_TEXT_TAGS.has(name))chunks.push('\n');
}
function structuredText(node){
  const root=node?.get?.(0);if(!root)return'';
  const chunks=[];
  appendStructuredText(root,chunks);
  return cleanText(chunks.join(''));
}
function findProductBlock($,element,textCache){
  let node=$(element),fallback=null;
  for(let i=0;i<12;i++){
    node=node.parent();if(!node.length)break;
    const rawText=node.text();
    const hasPrice=/通常価格[：:]/.test(rawText)&&/セール価格[：:]/.test(rawText);
    if(!hasPrice)continue;
    const domNode=node.get(0);
    let text=textCache.get(domNode);
    if(text===undefined){text=structuredText(node);textCache.set(domNode,text)}
    if(!fallback&&text.length<14000)fallback={node,text};
    if(/商品番号[：:]/.test(text)&&text.length<14000)return{node,text};
  }
  return fallback;
}

function logDiagnostic(event,data={}){
  console.log(`${event} ${JSON.stringify({at:new Date().toISOString(),...data})}`);
}
function errorDetails(error){
  if(!error)return{name:'Error',message:'unknown error'};
  return{
    name:error.name||'Error',
    code:error.code||'',
    status:error.status||'',
    message:error.message||String(error),
    stack:String(error.stack||'').split('\n').slice(0,10).join('\n')
  };
}
function fetchContext(context={}){
  return{
    phase:context.phase||'page',
    range:context.range||'all',
    offset:Number(context.offset||0),
    ...(context.page?{page:context.page}:{}),
    ...(context.pages?{pages:context.pages}:{})
  };
}

async function fetchText(url,{timeoutMs=FETCH_TIMEOUT_MS,retries=FETCH_RETRIES,context={}}={}){
  let lastError;
  const baseContext=fetchContext(context);
  for(let attempt=0;attempt<=retries;attempt++){
    const controller=new AbortController();
    const startedAt=Date.now();
    let hardTimer;
    const attemptContext={...baseContext,attempt:attempt+1,maxAttempts:retries+1,timeoutMs,url};
    logDiagnostic('[SALE_FETCH_START]',attemptContext);

    const networkPromise=(async()=>{
      const response=await fetch(url,{signal:controller.signal,headers:{Accept:'text/html,application/xhtml+xml','Accept-Language':'ja-JP,ja;q=0.9,en;q=0.5','User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'}});
      if(!response.ok){
        const error=new Error(`HTTP_${response.status}`);
        error.code='HTTP_STATUS';
        error.status=response.status;
        throw error;
      }
      const text=await response.text();
      return{text,status:response.status};
    })();

    const hardTimeoutPromise=new Promise((_,reject)=>{
      hardTimer=setTimeout(()=>{
        const error=new Error(`HARD_TIMEOUT_${timeoutMs}MS`);
        error.name='HardTimeoutError';
        error.code='HARD_TIMEOUT';
        try{controller.abort(error)}catch{}
        reject(error);
      },timeoutMs);
    });

    try{
      const result=await Promise.race([networkPromise,hardTimeoutPromise]);
      clearTimeout(hardTimer);
      logDiagnostic('[SALE_FETCH_OK]',{
        ...attemptContext,
        elapsedMs:Date.now()-startedAt,
        status:result.status,
        bytes:Buffer.byteLength(result.text,'utf8')
      });
      return result.text;
    }catch(error){
      clearTimeout(hardTimer);
      try{controller.abort(error)}catch{}
      lastError=error instanceof Error?error:new Error(String(error));
      const detail=errorDetails(lastError);
      logDiagnostic(attempt<retries?'[SALE_FETCH_RETRY]':'[SALE_FETCH_FAIL]',{
        ...attemptContext,
        elapsedMs:Date.now()-startedAt,
        errorName:detail.name,
        errorCode:detail.code,
        status:detail.status,
        message:detail.message
      });
      if(attempt<retries){
        const retryDelayMs=RETRY_BACKOFF_MS*(attempt+1)+Math.floor(Math.random()*500);
        await sleep(retryDelayMs);
      }
    }
  }
  const finalError=new Error(`FETCH_EXHAUSTED range=${baseContext.range} offset=${baseContext.offset}: ${lastError?.message||'unknown error'}`);
  finalError.code='FETCH_EXHAUSTED';
  finalError.cause=lastError;
  throw finalError;
}

async function mapLimit(items,limit,fn,{label='work'}={}){
  const out=new Array(items.length);
  let cursor=0,firstFailure=null;
  async function worker(workerId){
    while(true){
      if(firstFailure)return;
      const i=cursor++;
      if(i>=items.length)return;
      try{
        out[i]=await fn(items[i],i);
      }catch(error){
        if(!firstFailure)firstFailure={index:i,item:items[i],workerId,error};
        logDiagnostic('[SALE_PAGE_WORKER_FAIL]',{label,workerId,index:i,item:items[i],...errorDetails(error)});
        return;
      }
    }
  }
  await Promise.all(Array.from({length:Math.min(limit,items.length)},(_,workerId)=>worker(workerId+1)));
  if(firstFailure){
    const error=new Error(`SALE_PAGE_COLLECTION_FAILED label=${label} item=${firstFailure.item}`);
    error.code='SALE_PAGE_COLLECTION_FAILED';
    error.cause=firstFailure.error;
    throw error;
  }
  return out;
}

function buildSearchUrl({min=null,max=null,offset=0}={}){
  const params=new URLSearchParams({g:ROOT_GENRE_ID,merch:SALE_MERCH_ID,h:String(PAGE_SIZE),v:'1',s:'8'});
  if(min!=null&&min>0)params.set('minp',String(min));
  if(max!=null)params.set('maxp',String(max));
  if(offset>0)params.set('o',String(offset));
  return`${SALE_SEARCH_URL}?${params}`;
}
function parseSalePage(html,{label='楽天Kobo公式セール',rangeOrder=0,offset=0}={}){
  const $=cheerio.load(html),found=new Map(),textCache=new WeakMap();
  $('a[href*="/rk/"]').each((_,element)=>{
    const title=cleanTitle($(element).text());if(!title||title.length<2||title.length>180||invalidTitle(title))return;
    const block=findProductBlock($,element,textCache);if(!block)return;const text=block.text;if(ADULT_WORDS.some(w=>text.includes(w)))return;
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
  const firstHtml=await fetchText(firstUrl,{context:{phase:'range-first',range:range.label,offset:0}});
  const total=parseTotalCount(firstHtml);
  if(total>PAGE_SIZE*MAX_PAGES_PER_QUERY&&range.max!=null&&range.max>range.min){
    const mid=Math.floor((range.min+range.max)/2);
    logDiagnostic('[SALE_RANGE_SPLIT]',{range:range.label,min:range.min,max:range.max,total,splitAt:mid});
    const left=await collectRange({min:range.min,max:mid,label:`${range.label} lower`},rangeOrder*2+1);
    const right=await collectRange({min:mid+1,max:range.max,label:`${range.label} upper`},rangeOrder*2+2);
    return{total:left.total+right.total,items:[...left.items,...right.items],parts:[...left.parts,...right.parts]};
  }
  const pages=Math.min(MAX_PAGES_PER_QUERY,Math.max(1,Math.ceil((total||PAGE_SIZE)/PAGE_SIZE)));
  const firstParseStartedAt=Date.now();
  const all=parseSalePage(firstHtml,{label:range.label,rangeOrder,offset:0});
  if(total===0&&all.length>0){
    const error=new Error(`SALE_TOTAL_PARSE_FAILED range=${range.label} parsedItems=${all.length}`);
    error.code='SALE_TOTAL_PARSE_FAILED';
    throw error;
  }
  logDiagnostic('[SALE_PAGE_OK]',{range:range.label,page:1,pages,offset:0,items:all.length,total:total||0,parseMs:Date.now()-firstParseStartedAt});
  if(pages>1){
    const offsets=Array.from({length:pages-1},(_,i)=>(i+1)*PAGE_SIZE);
    const fetchedPages=await mapLimit(offsets,PAGE_CONCURRENCY,async offset=>{
      const page=Math.floor(offset/PAGE_SIZE)+1;
      try{
        const html=await fetchText(buildSearchUrl({...range,offset}),{context:{phase:'range-page',range:range.label,offset,page,pages}});
        return{offset,page,html,error:null};
      }catch(error){
        logDiagnostic('[SALE_PAGE_FETCH_DEFERRED]',{range:range.label,page,pages,offset,...errorDetails(error)});
        return{offset,page,html:'',error};
      }
    },{label:`range-fetch:${range.label}`});

    const failedPages=fetchedPages.filter(entry=>!entry?.html);
    if(failedPages.length){
      logDiagnostic('[SALE_RECOVERY_START]',{range:range.label,pages,failedPages:failedPages.map(entry=>entry.page)});
      for(const entry of failedPages){
        entry.html=await fetchText(buildSearchUrl({...range,offset:entry.offset}),{
          timeoutMs:RECOVERY_FETCH_TIMEOUT_MS,
          retries:RECOVERY_FETCH_RETRIES,
          context:{phase:'range-page-recovery',range:range.label,offset:entry.offset,page:entry.page,pages}
        });
        entry.error=null;
        logDiagnostic('[SALE_RECOVERY_OK]',{range:range.label,page:entry.page,pages,offset:entry.offset});
      }
    }

    if(fetchedPages.length!==offsets.length||fetchedPages.some(entry=>!entry?.html)){
      const actual=fetchedPages.filter(entry=>entry?.html).length;
      const error=new Error(`SALE_PAGE_RESULT_INCOMPLETE range=${range.label} expected=${offsets.length} actual=${actual}`);
      error.code='SALE_PAGE_RESULT_INCOMPLETE';
      throw error;
    }

    for(const entry of fetchedPages){
      const parseStartedAt=Date.now();
      const items=parseSalePage(entry.html,{label:range.label,rangeOrder,offset:entry.offset});
      logDiagnostic('[SALE_PAGE_OK]',{range:range.label,page:entry.page,pages,offset:entry.offset,items:items.length,total,parseMs:Date.now()-parseStartedAt});
      all.push(...items);
      await yieldToEventLoop();
    }
  }
  logDiagnostic('[SALE_RANGE_COMPLETE]',{range:range.label,pages,total:total||0,parsedSaleBooks:all.length});
  return{total:total||all.length,items:all,parts:[{...range,total,pages}]};
}

async function main(){
  const globalHtml=await fetchText(buildSearchUrl({}),{context:{phase:'official-total',range:'all',offset:0}});
  const officialTotal=parseTotalCount(globalHtml);
  if(officialTotal<=0){
    const error=new Error('OFFICIAL_SALE_TOTAL_PARSE_FAILED');
    error.code='OFFICIAL_SALE_TOTAL_PARSE_FAILED';
    throw error;
  }
  console.log(`Official Rakuten Kobo sale count: ${officialTotal}`);

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

  const bucketTotal=parts.reduce((sum,part)=>sum+Number(part.total||0),0);
  const countDrift=Math.abs(bucketTotal-officialTotal);
  const allowedCountDrift=Math.max(20,Math.ceil(officialTotal*0.02));
  logDiagnostic('[SALE_COMPLETENESS_CHECK]',{officialTotal,bucketTotal,countDrift,allowedCountDrift,buckets:parts.length});
  if(countDrift>allowedCountDrift){
    const error=new Error(`SALE_BUCKET_TOTAL_DRIFT_TOO_LARGE official=${officialTotal} buckets=${bucketTotal} drift=${countDrift} allowed=${allowedCountDrift}`);
    error.code='SALE_BUCKET_TOTAL_DRIFT_TOO_LARGE';
    throw error;
  }

  const items=[...merged.values()].filter(item=>item?.title&&Number(item.regularPrice)>Number(item.salePrice)&&Number(item.salePrice)>0);
  items.forEach((item,index)=>{item.sourceOrder=index+1});
  const authorCount=items.filter(item=>item.author).length,endCount=items.filter(item=>item.saleEndAt).length,itemNumberCount=items.filter(item=>item.itemNumber).length;
  console.log(`Sale metadata: authors=${authorCount}/${items.length}, endDates=${endCount}/${items.length}, itemNumbers=${itemNumberCount}/${items.length}`);
  if(items.length>=100&&authorCount/items.length<0.70)throw new Error(`SALE_AUTHOR_PARSE_REGRESSION_${authorCount}_OF_${items.length}`);
  await mkdir(dirname(outputPath),{recursive:true});
  await writeFile(outputPath,`${JSON.stringify({kind:'sale-candidates',completed:true,exhaustive:true,scannedExhaustive:true,sourceUrl:buildSearchUrl({}),officialSaleIndex:OFFICIAL_INDEX_URL,officialTotal,updatedAt:new Date().toISOString(),priceBuckets:parts,scanned:items.length,metadata:{authors:authorCount,saleEndDates:endCount,itemNumbers:itemNumberCount},items},null,2)}\n`,'utf8');
  console.log(`Saved ${items.length} unique sale books across ${parts.length} non-overlapping price ranges (official=${officialTotal})`);
}

const scriptWatchdog=setTimeout(()=>{
  logDiagnostic('[SALE_FATAL]',{code:'SCRIPT_HARD_TIMEOUT',message:`Script exceeded ${SCRIPT_WATCHDOG_MS}ms`});
  process.exit(1);
},SCRIPT_WATCHDOG_MS);

main().then(()=>{
  clearTimeout(scriptWatchdog);
}).catch(error=>{
  clearTimeout(scriptWatchdog);
  logDiagnostic('[SALE_FATAL]',errorDetails(error));
  if(error?.cause)logDiagnostic('[SALE_FATAL_CAUSE]',errorDetails(error.cause));
  process.exitCode=1;
});
