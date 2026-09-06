import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { GENRES } from '../catalog.js';

const inputPath=resolve(process.argv[2]||'/tmp/kobo-sale-candidates.json');
const legacyOutputPath=resolve(process.argv[3]||'/tmp/completed-feeds/kobo-sale.json');
const pagesDir=resolve(process.argv[4]||'/tmp/completed-feeds/sale');
const PAGE_SIZE=100;
const LEGACY_FALLBACK_SIZE=600;
const ADULT_WORDS=['アダルト','成年コミック','成人向け','18禁','官能','成人漫画','エロティック','R18','R18+'];
const LIGHT_NOVEL_WORDS=['ライトノベル','ラノベ','電撃文庫','MF文庫J','GA文庫','富士見ファンタジア文庫','ガガガ文庫'];
const GENRE_HINTS={
  fiction:/小説|文芸|文学/u,
  mystery:/ミステリ|推理|サスペンス/u,
  sf:/\bSF\b|ＳＦ|ファンタジ/u,
  business:/ビジネス|経済|経営|投資|金融|マーケティング|マネー/u,
  humanities:/人文|思想|哲学|社会|歴史|心理|宗教/u,
  nonfiction:/ノンフィクション|ルポ|ドキュメント|実話|伝記/u,
  science:/科学|医学|技術|物理|化学|生物|工学|テクノロジ/u,
  it:/コンピュータ|プログラミング|IT|ＩＴ|PC|ＰＣ|システム|AI|ＡＩ/u,
  life:/暮らし|料理|レシピ|家事|美容|住まい/u,
  health:/健康|医療|ダイエット|トレーニング|運動|病気/u,
  hobby:/ホビー|スポーツ|美術|音楽|写真|カメラ|囲碁|将棋|釣り/u,
  travel:/旅行|旅ガイド|地図|アウトドア|キャンプ|登山/u,
  language:/語学|英語|中国語|韓国語|資格|TOEIC|ＴＯＥＩＣ|学習参考書/u,
  children:/絵本|児童|こども|子ども|キッズ/u,
  essay:/エッセイ|随筆/u,
  comic:/漫画|コミック|COMIC|comic/u
};

function normalize(v=''){return String(v).normalize('NFKC').toLowerCase().replace(/[〜～]/g,'〜').replace(/[\s　・･:：!?！？()（）【】\[\]「」『』〈〉《》#＃―ー\-]/g,'')}
function searchableText(item){return [item?.title,item?.author,item?.publisher,item?.caption,item?.series,item?.sourceGenre,item?.saleCampaign].filter(Boolean).join(' ')}
function isAdult(item){const text=searchableText(item);return ADULT_WORDS.some(w=>text.includes(w))}
function isLightNovel(item){const text=searchableText(item);return LIGHT_NOVEL_WORDS.some(w=>text.includes(w))}
function validProductUrl(url=''){return /^https:\/\/books\.rakuten\.co\.jp\/rk\/[^/?#]+\/?(?:[?#].*)?$/i.test(String(url))}
function bookKey(book){const u=String(book?.url||'').trim(),n=String(book?.itemNumber||book?.isbn||'').trim();return u?`u:${u}`:n?`n:${n}`:`t:${normalize(book?.title)}|${normalize(book?.author)}`}
function dedupe(list){const seen=new Set(),out=[];for(const item of list||[]){const key=bookKey(item);if(!key||seen.has(key)||isAdult(item))continue;seen.add(key);out.push(item)}return out}
function genreMatches(book,genre){
  const text=searchableText(book),source=String(book.sourceGenre||'');
  if(genre.excludeLightNovel&&isLightNovel(book))return false;
  if((genre.names||[]).some(name=>name&&text.includes(name)))return true;
  if(source.split(/[・／/]/).some(part=>(genre.names||[]).some(name=>name&&part.includes(name))))return true;
  return Boolean(GENRE_HINTS[genre.id]?.test(text));
}
function qualityScore(book){
  const reviewCount=Math.max(0,Number(book.reviewCount||0)),reviewAverage=Math.max(0,Number(book.reviewAverage||0));
  const discount=Math.max(0,Number(book.discountPercent||0)),saving=Math.max(0,Number(book.regularPrice||0)-Number(book.salePrice||0));
  const sourceRank=Math.max(1,Number(book.sourceOrder||book.sourceRank||1));
  const reviewScore=Math.min(72,Math.log2(reviewCount+1)*14);
  const ratingScore=reviewCount>0&&reviewAverage>0?Math.max(-8,(reviewAverage-3.5)*14):0;
  const discountScore=Math.min(26,discount*.30),savingScore=Math.min(14,Math.log2(saving+1)*1.45),sourceScore=Math.max(0,24-Math.log10(sourceRank+1)*6);
  const metadataScore=(book.image?4:0)+(book.series?2:0)+(book.author?2:0)+(book.publisher?1:0)+(book.saleEndAt?2:0);
  return Math.round((reviewScore+ratingScore+discountScore+savingScore+sourceScore+metadataScore)*10)/10;
}
function toBook(candidate,index){
  const regular=Number(candidate.regularPrice||0),sale=Number(candidate.salePrice||0),url=String(candidate.url||'');
  if(!candidate.title||!validProductUrl(url)||!regular||!sale||sale>=regular||isAdult(candidate))return null;
  const slug=url.match(/\/rk\/([^/?#]+)/i)?.[1]||normalize(candidate.title).slice(0,48)||String(index);
  const base={
    id:`rk:${slug}`,itemNumber:candidate.itemNumber||'',isbn:/^\d+$/.test(String(candidate.itemNumber||''))?String(candidate.itemNumber):'',
    title:candidate.title,author:candidate.author||'',publisher:candidate.publisher||'',price:sale,url,image:candidate.image||'',caption:candidate.caption||'',
    salesDate:candidate.salesDate||'',series:candidate.series||'',reviewAverage:Number(candidate.reviewAverage||0),reviewCount:Number(candidate.reviewCount||0),genreId:'',
    regularPrice:regular,salePrice:sale,discountPercent:Math.max(1,Math.round((1-sale/regular)*100)),saleEndAt:candidate.saleEndAt||'',
    saleCampaign:candidate.saleCampaign||'',saleCampaigns:candidate.saleCampaigns||[],saleSources:candidate.saleSources||['rakuten-books-official-sale-listing'],
    sourceGenre:candidate.sourceGenre||'',campaignMerch:candidate.campaignMerch||'',campaignUrl:candidate.campaignUrl||'',saleVerified:true,
    verification:'current-rakuten-books-official-sale-listing',verifiedAt:new Date().toISOString(),sourceOrder:Number(candidate.sourceOrder||candidate.sourceRank||index+1)
  };
  const genreKeys=GENRES.filter(genre=>genreMatches(base,genre)).map(genre=>genre.id);
  const quality=qualityScore(base);
  return{...base,genreKeys,qualityScore:quality};
}

const raw=JSON.parse(await readFile(inputPath,'utf8'));
const candidates=(raw.items||[]).filter(item=>item?.title&&Number(item.regularPrice)>Number(item.salePrice)&&Number(item.salePrice)>0&&validProductUrl(item.url)&&!isAdult(item));
const books=dedupe(candidates.map(toBook).filter(Boolean)).sort((a,b)=>Number(b.qualityScore||0)-Number(a.qualityScore||0)||Number(b.reviewCount||0)-Number(a.reviewCount||0)||Number(a.sourceOrder||0)-Number(b.sourceOrder||0));
const updatedAt=new Date().toISOString(),pageCount=Math.ceil(books.length/PAGE_SIZE);

await rm(pagesDir,{recursive:true,force:true});
await mkdir(join(pagesDir,'pages'),{recursive:true});
const genreManifest={};
for(const genre of GENRES)genreManifest[genre.id]={label:genre.label,count:0,pages:[]};

for(let page=1;page<=pageCount;page++){
  const items=books.slice((page-1)*PAGE_SIZE,page*PAGE_SIZE);
  for(const genre of GENRES){const count=items.reduce((sum,book)=>sum+(book.genreKeys?.includes(genre.id)?1:0),0);if(count){genreManifest[genre.id].count+=count;genreManifest[genre.id].pages.push({page,count})}}
  const payload={kind:'sale-static-page',completed:true,exhaustive:true,page,pageSize:PAGE_SIZE,pageCount,total:books.length,officialTotal:Number(raw.officialTotal||0),updatedAt,items};
  await writeFile(join(pagesDir,'pages',`${String(page).padStart(4,'0')}.json`),JSON.stringify(payload),'utf8');
}

const manifest={
  kind:'sale-static-index',completed:true,exhaustive:true,scannedExhaustive:Boolean(raw.scannedExhaustive||raw.exhaustive),pageSize:PAGE_SIZE,total:books.length,pageCount,
  officialTotal:Number(raw.officialTotal||0),coverageRatio:Number(raw.officialTotal||0)?Math.round(books.length/Number(raw.officialTotal)*10000)/10000:0,
  sourceUrl:raw.sourceUrl||'',officialSaleIndex:raw.officialSaleIndex||'',updatedAt,priceBuckets:raw.priceBuckets||[],genres:genreManifest,
  strategy:'github-actions-exhaustive-price-bucket-scan-static-pages'
};
await writeFile(join(pagesDir,'index.json'),JSON.stringify(manifest),'utf8');

const legacyItems=books.slice(0,LEGACY_FALLBACK_SIZE);
await writeFile(legacyOutputPath,`${JSON.stringify({kind:'sale',completed:true,exhaustive:false,staticFallback:true,sourceUrl:raw.sourceUrl||'',officialSaleIndex:raw.officialSaleIndex||'',updatedAt,candidateCount:books.length,matched:legacyItems.length,items:legacyItems},null,2)}\n`,'utf8');

console.log(`Built static sale feed: ${books.length} books -> ${pageCount} pages of ${PAGE_SIZE}; official=${Number(raw.officialTotal||0)||'unknown'}`);
console.log(`Genre counts: ${GENRES.map(g=>`${g.id}:${genreManifest[g.id].count}`).join(' ')}`);
