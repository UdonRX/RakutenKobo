import * as cheerio from 'cheerio';

const UPSTREAM_PAGE_SIZE = 20;
const LOGICAL_BATCH_SIZE = 100;
const ROOT_GENRE_ID = '101';
const SALE_MERCH_ID = '53626';
const SALE_INDEX_URL = 'https://books.rakuten.co.jp/event/e-book/index-sp.html';
const SALE_SEARCH_URL = 'https://books.rakuten.co.jp/search';
const ADULT_WORDS = ['アダルト','成年コミック','成人向け','18禁','官能','成人漫画','エロティック','R18','R18+'];
const LIGHT_NOVEL_WORDS = ['ライトノベル','ラノベ','電撃文庫','MF文庫J','GA文庫','富士見ファンタジア文庫','ガガガ文庫'];
const PRICE_BUCKETS = [
  { min:null, max:199, label:'199円以下' },
  { min:200, max:299, label:'200〜299円' },
  { min:300, max:399, label:'300〜399円' },
  { min:400, max:599, label:'400〜599円' },
  { min:600, max:999, label:'600〜999円' },
  { min:1000, max:1499, label:'1,000〜1,499円' },
  { min:1500, max:1999, label:'1,500〜1,999円' },
  { min:2000, max:2999, label:'2,000〜2,999円' },
  { min:3000, max:4999, label:'3,000〜4,999円' },
  { min:5000, max:null, label:'5,000円以上' }
];

function json(res,status,body,maxAge=0){
  res.statusCode=status;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control',maxAge?`s-maxage=${maxAge}, stale-while-revalidate=${maxAge*2}`:'no-store');
  res.end(JSON.stringify(body));
}
function cleanText(value=''){return String(value).replace(/\u00a0/g,' ').replace(/[ \t\r\f\v]+/g,' ').replace(/\n+/g,'\n').trim()}
function cleanTitle(value=''){return cleanText(value).replace(/^電子\s*/,'').replace(/\s*\[電子書籍版\]\s*$/i,'').replace(/^〖予約〗\s*/,'').trim()}
function normalizeText(value=''){return String(value).normalize('NFKC').toLowerCase().replace(/[\s　・･:：!?！？()（）【】\[\]「」『』〈〉《》#＃―ー\-]/g,'')}
function isBlocked(text='',excludeLightNovel=false){
  if(ADULT_WORDS.some(word=>text.includes(word)))return true;
  return Boolean(excludeLightNovel&&LIGHT_NOVEL_WORDS.some(word=>text.includes(word)));
}
function saleEndAtFromText(text=''){
  const value=cleanText(text);
  let match=value.match(/_(20\d{2})-(\d{1,2})-(\d{1,2})\s*(\d{1,2}):(\d{2})まで/);
  if(!match)match=value.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日(?:[（(][^）)]{0,4}[）)])?\s*(\d{1,2}):(\d{2})まで/);
  if(!match)match=value.match(/(20\d{2})[\/.](\d{1,2})[\/.](\d{1,2})\s*(\d{1,2}):(\d{2})まで/);
  if(!match)return'';
  const[,year,month,day,hour,minute]=match;
  return`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}T${String(hour).padStart(2,'0')}:${minute}:00+09:00`;
}
function absoluteBookUrl(href=''){
  try{const url=new URL(href,'https://books.rakuten.co.jp/');return url.hostname==='books.rakuten.co.jp'&&url.pathname.startsWith('/rk/')?url.href:''}catch{return''}
}
function absoluteImageUrl(src=''){
  if(!src)return'';
  try{return new URL(src,'https://books.rakuten.co.jp/').href}catch{return String(src)}
}
function findBlock($,element){
  let node=$(element);
  for(let depth=0;depth<9;depth+=1){
    node=node.parent();if(!node.length)break;
    const text=cleanText(node.text());
    if(/通常価格[：:]/.test(text)&&/セール価格[：:]/.test(text)&&text.length<5000)return{node,text};
  }
  return null;
}
function authorFromText(text,title=''){
  const direct=String(text).match(/(?:著者|作者)[：:]\s*([^\n／]{1,120})/u);if(direct)return cleanText(direct[1]);
  const lines=String(text).split(/\n+/).map(cleanText).filter(Boolean),titleKey=normalizeText(title);
  const titleIndex=lines.findIndex(line=>{const key=normalizeText(cleanTitle(line));return key===titleKey||key.includes(titleKey)||titleKey.includes(key)});
  const numberIndex=lines.findIndex((line,index)=>index>titleIndex&&/^商品番号[：:]/u.test(line));
  if(titleIndex<0||numberIndex<=titleIndex)return'';
  for(const line of lines.slice(titleIndex+1,numberIndex)){
    if(line.length>120||/^(電子|通常価格|セール価格|シリーズ名|レビュー|商品番号)/u.test(line))continue;
    if(/[円%]|OFF|セール|発売/u.test(line))continue;
    return line;
  }
  return'';
}
function parseTotalCount(html){
  const text=cleanText(cheerio.load(html).root().text());
  const match=text.match(/全\s*([\d,]+)\s*件/u);
  return match?Number(match[1].replace(/,/g,'')):0;
}
function parseSalePage(html,{genreId=ROOT_GENRE_ID,excludeLightNovel=false}={}){
  const $=cheerio.load(html),found=new Map();
  $('a[href*="/rk/"]').each((_,element)=>{
    const rawTitle=cleanText($(element).text()),title=cleanTitle(rawTitle);
    if(!title||title.length<2||title.length>180||/^\d+\s*件$/.test(title))return;
    const block=findBlock($,element);if(!block)return;
    const text=block.text;if(isBlocked(text,excludeLightNovel))return;
    const regular=text.match(/通常価格[：:]\s*([\d,]+)円/),sale=text.match(/セール価格[：:]\s*([\d,]+)円/);
    if(!regular||!sale)return;
    const regularPrice=Number(regular[1].replace(/,/g,'')),salePrice=Number(sale[1].replace(/,/g,''));
    if(!regularPrice||!salePrice||salePrice>=regularPrice)return;
    const url=absoluteBookUrl(String($(element).attr('href')||''));if(!url)return;
    const number=text.match(/商品番号[：:]\s*([0-9A-Za-z-]+)/u);
    const detail=text.match(/(\d{4}年\d{2}月\d{2}日)発売\s*／\s*([^／]+)\s*／\s*([^／]+)\s*／/u);
    const campaignAnchor=block.node.find('a').filter((__,anchor)=>/セール|フェア|OFF|半額|割引|無料|円/u.test(cleanText($(anchor).text()))).last();
    const campaignText=cleanText(campaignAnchor.text())||cleanText(text.match(/(〖[^〗]{2,100}〗[^\n]{0,180})/u)?.[1]||'');
    const campaignHref=String(campaignAnchor.attr('href')||'').trim();
    const campaignUrl=campaignHref?new URL(campaignHref,'https://books.rakuten.co.jp/').href:'';
    const series=cleanText(text.match(/シリーズ名[：:]\s*([^\n]{1,160})/u)?.[1]||'');
    const reviewCount=Number((text.match(/[（(]\s*(?:レビュー)?\s*([\d,]+)\s*件[）)]/u)?.[1]||'0').replace(/,/g,''))||0;
    const reviewAverage=Number(text.match(/([0-5](?:\.\d{1,2})?)\s*[（(]\s*(?:レビュー)?\s*[\d,]+\s*件[）)]/u)?.[1]||0)||0;
    const imageNode=block.node.find('img').filter((__,img)=>/image|thumbnail|rakuten/i.test(String($(img).attr('src')||$(img).attr('data-src')||''))).first();
    const fallbackImage=block.node.find('img').first();
    const image=absoluteImageUrl(String((imageNode.length?imageNode:fallbackImage).attr('src')||(imageNode.length?imageNode:fallbackImage).attr('data-src')||(imageNode.length?imageNode:fallbackImage).attr('data-original')||''));
    const itemNumber=number?.[1]||'',author=authorFromText(block.node.text(),rawTitle||title);
    const id=itemNumber||url||normalizeText(title);if(!id||found.has(id))return;
    found.set(id,{
      id,itemNumber,isbn:/^\d+$/.test(itemNumber)?itemNumber:'',title,author,publisher:cleanText(detail?.[3]||''),
      price:salePrice,url,image,caption:'',salesDate:cleanText(detail?.[1]||''),series,reviewAverage,reviewCount,genreId:String(genreId||ROOT_GENRE_ID),salesType:0,
      regularPrice,salePrice,discountPercent:Math.max(1,Math.round((1-salePrice/regularPrice)*100)),saleEndAt:saleEndAtFromText(campaignText||text),
      saleCampaign:campaignText,campaignUrl,sourceGenre:cleanText(detail?.[2]||''),saleVerified:true,verification:'rakuten-books-official-sale-listing'
    });
  });
  return[...found.values()];
}
async function fetchHtml(url,timeoutMs=5000){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const response=await fetch(url,{signal:controller.signal,headers:{Accept:'text/html,application/xhtml+xml','Accept-Language':'ja-JP,ja;q=0.9,en;q=0.5','User-Agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'}});
    if(!response.ok)throw new Error(`RAKUTEN_SALE_HTTP_${response.status}`);
    return await response.text();
  }finally{clearTimeout(timer)}
}
function buildUrl({genreId=ROOT_GENRE_ID,bucketIndex=0,page=1}={}){
  const params=new URLSearchParams({g:String(genreId||ROOT_GENRE_ID),merch:SALE_MERCH_ID,merchName:'セール中の作品',h:String(UPSTREAM_PAGE_SIZE),v:'1',s:'8'});
  const bucket=PRICE_BUCKETS[bucketIndex]||PRICE_BUCKETS[0];
  if(bucket.min!=null)params.set('minp',String(bucket.min));
  if(bucket.max!=null)params.set('maxp',String(bucket.max));
  const offset=(Math.max(1,Number(page)||1)-1)*UPSTREAM_PAGE_SIZE;if(offset)params.set('o',String(offset));
  return`${SALE_SEARCH_URL}?${params}`;
}
function parseCursor(value=''){
  const match=String(value).match(/^(\d+)\.(\d+)$/);if(!match)return{bucketIndex:0,page:1};
  return{bucketIndex:Math.min(Math.max(Number(match[1]),0),PRICE_BUCKETS.length-1),page:Math.max(Number(match[2]),1)};
}
function nextCursor(bucketIndex,page,total,itemCount){
  const pages=total?Math.max(1,Math.ceil(total/UPSTREAM_PAGE_SIZE)):(itemCount>=UPSTREAM_PAGE_SIZE?page+1:page);
  if(page<pages)return`${bucketIndex}.${page+1}`;
  const nextBucket=bucketIndex+1;return nextBucket<PRICE_BUCKETS.length?`${nextBucket}.1`:'';
}

export default async function handler(req,res){
  try{
    const genreId=String(req.query.genreId||ROOT_GENRE_ID),excludeLightNovel=String(req.query.excludeLightNovel||'')==='1';
    const{bucketIndex,page}=parseCursor(req.query.cursor||'');
    const sourceUrl=buildUrl({genreId,bucketIndex,page});
    const html=await fetchHtml(sourceUrl);
    const bucketTotal=parseTotalCount(html),items=parseSalePage(html,{genreId,excludeLightNovel});
    const next=nextCursor(bucketIndex,page,bucketTotal,items.length);
    return json(res,200,{
      completed:true,exhaustive:true,items,pageSize:UPSTREAM_PAGE_SIZE,logicalBatchSize:LOGICAL_BATCH_SIZE,cursor:String(req.query.cursor||''),nextCursor:next,hasMore:Boolean(next),
      officialTotal:0,bucketTotal,bucketIndex,bucketLabel:PRICE_BUCKETS[bucketIndex]?.label||'',sourceUrl,officialSaleIndex:SALE_INDEX_URL,
      fetchedAt:new Date().toISOString(),parsed:items.length,matched:items.length,resolvedGenre:genreId!==ROOT_GENRE_ID?{id:genreId}:null
    },300);
  }catch(error){
    return json(res,502,{error:'楽天Koboのセール一覧を取得できませんでした。',detail:error?.name==='AbortError'?'SALE_UPSTREAM_TIMEOUT':String(error?.message||error),retryable:error?.name==='AbortError',officialSaleIndex:SALE_INDEX_URL});
  }
}
