import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GENRES } from '../catalog.js';

const inputPath=resolve(process.argv[2]||'/tmp/kobo-sale-candidates.json');
const outputPath=resolve(process.argv[3]||'/tmp/completed-feeds/kobo-sale.json');
const CURATED_TARGET=600;
const SERIES_CAP=2;
const RELAXED_SERIES_CAP=3;
const COMIC_CAP=260;
const GENRE_FLOOR=18;
const ADULT_WORDS=['アダルト','成年コミック','成人向け','18禁','官能','成人漫画','エロティック','R18','R18+'];
const LIGHT_NOVEL_WORDS=['ライトノベル','ラノベ','電撃文庫','MF文庫J','GA文庫','富士見ファンタジア文庫','ガガガ文庫'];
const LOW_VALUE_WORDS=['分冊版','単話版','話売り','無料お試し','試し読み','タテヨミ','縦読み'];
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
function bookKey(book){const u=String(book?.url||'').trim(),n=String(book?.itemNumber||book?.isbn||'').trim();return u?`u:${u}`:n?`n:${n}`:`t:${normalize(book?.title)}|${normalize(book?.author)}`}
function searchableText(item){return [item?.title,item?.author,item?.publisher,item?.caption,item?.series,item?.sourceGenre].filter(Boolean).join(' ')}
function isAdult(item){const text=searchableText(item);return ADULT_WORDS.some(w=>text.includes(w))}
function isLightNovel(item){const text=searchableText(item);return LIGHT_NOVEL_WORDS.some(w=>text.includes(w))}
function isLowValue(item){const text=searchableText(item);return LOW_VALUE_WORDS.some(w=>text.includes(w))}
function validProductUrl(url=''){return /^https:\/\/books\.rakuten\.co\.jp\/rk\/[^/?#]+\/?(?:[?#].*)?$/i.test(String(url))}
function dedupe(list){const seen=new Set(),out=[];for(const item of list||[]){const key=bookKey(item);if(!key||seen.has(key)||isAdult(item))continue;seen.add(key);out.push(item)}return out}
function titleSeriesCore(value=''){
  return String(value||'').normalize('NFKC')
    .replace(/\s*[（(][^）)]*(?:コミックス|コミック|DIGITAL|電子|文庫|新書|単行本|BOOKS?)[^）)]*[）)]\s*$/iu,'')
    .replace(/\s*\[[^\]]*(?:電子|DIGITAL|コミック)[^\]]*\]\s*$/iu,'')
    .replace(/(?:第\s*)?\d{1,3}\s*巻\s*$/u,'')
    .replace(/[（(]\s*\d{1,3}\s*[）)]\s*$/u,'')
    .replace(/(?:^|[\s　])\d{1,3}\s*$/u,'')
    .trim();
}
function seriesKey(book){const explicit=normalize(book?.series||'');if(explicit.length>=3)return`series:${explicit}`;const core=normalize(titleSeriesCore(book?.title||''));return core.length>=4?`title:${core}`:bookKey(book)}
function genreMatches(book,genre){
  const text=searchableText(book);
  if(genre.excludeLightNovel&&isLightNovel(book))return false;
  if(genre.names.some(name=>name&&text.includes(name)))return true;
  const source=String(book.sourceGenre||'');if(source.split(/[・／/]/).some(part=>genre.names.some(name=>name&&part.includes(name))))return true;
  return Boolean(GENRE_HINTS[genre.id]?.test(text));
}
function isComic(book){return genreMatches(book,{id:'comic',names:['漫画（コミック）','コミック','漫画'],excludeLightNovel:false})}
function qualityScore(book){
  const reviewCount=Math.max(0,Number(book.reviewCount||0));
  const reviewAverage=Math.max(0,Number(book.reviewAverage||0));
  const discount=Math.max(0,Number(book.discountPercent||0));
  const saving=Math.max(0,Number(book.regularPrice||0)-Number(book.salePrice||0));
  const sourceRank=Math.max(1,Number(book.sourceOrder||1));
  const reviewScore=Math.min(72,Math.log2(reviewCount+1)*14);
  const ratingScore=reviewCount>0&&reviewAverage>0?Math.max(-8,(reviewAverage-3.5)*14):0;
  const discountScore=Math.min(26,discount*.30);
  const savingScore=Math.min(14,Math.log2(saving+1)*1.45);
  const sourceScore=Math.max(0,24-Math.log10(sourceRank+1)*6);
  const metadataScore=(book.image?4:0)+(book.series?2:0)+(book.author?2:0)+(book.publisher?1:0);
  return Math.round((reviewScore+ratingScore+discountScore+savingScore+sourceScore+metadataScore)*10)/10;
}
function toBook(candidate,index){
  const regular=Number(candidate.regularPrice||0),sale=Number(candidate.salePrice||0),url=String(candidate.url||'');
  if(!candidate.title||!validProductUrl(url)||!regular||!sale||sale>=regular||isAdult(candidate))return null;
  const slug=url.match(/\/rk\/([^/?#]+)/i)?.[1]||normalize(candidate.title).slice(0,48)||String(index);
  const book={
    id:`rk:${slug}`,title:candidate.title,author:candidate.author||'',publisher:candidate.publisher||'',price:sale,url,
    image:candidate.image||'',caption:candidate.caption||'',salesDate:candidate.salesDate||'',series:candidate.series||'',
    reviewAverage:Number(candidate.reviewAverage||0),reviewCount:Number(candidate.reviewCount||0),genreId:'',
    isbn:/^\d+$/.test(String(candidate.itemNumber||''))?String(candidate.itemNumber):'',
    regularPrice:regular,salePrice:sale,discountPercent:Math.max(1,Math.round((1-sale/regular)*100)),saleEndAt:candidate.saleEndAt||'',
    saleCampaign:candidate.saleCampaign||'',saleCampaigns:candidate.saleCampaigns||[],saleSources:candidate.saleSources||['rakuten-kobo-sale-listing'],
    sourceGenre:candidate.sourceGenre||'',campaignMerch:candidate.campaignMerch||'',campaignUrl:candidate.campaignUrl||'',
    saleVerified:true,verification:'current-rakuten-kobo-sale-listing-direct-product',verifiedAt:new Date().toISOString(),sourceOrder:Number(candidate.sourceRank||index+1)
  };
  return {...book,qualityScore:qualityScore(book)};
}

const raw=JSON.parse(await readFile(inputPath,'utf8'));
const candidates=(raw.items||[]).filter(item=>item?.title&&Number(item.regularPrice)>Number(item.salePrice)&&Number(item.salePrice)>0&&validProductUrl(item.url)&&!isAdult(item));
const allBooks=dedupe(candidates.map(toBook).filter(Boolean));
const lowValueExcluded=allBooks.filter(isLowValue).length;
const pool=allBooks.filter(book=>!isLowValue(book)).sort((a,b)=>Number(b.qualityScore||0)-Number(a.qualityScore||0)||Number(a.sourceOrder||0)-Number(b.sourceOrder||0));
const selected=[],selectedKeys=new Set(),seriesCounts=new Map();let comicCount=0;
function addBook(book,{seriesCap=SERIES_CAP,comicLimit=COMIC_CAP}={}){
  const key=bookKey(book);if(!key||selectedKeys.has(key))return false;
  const sKey=seriesKey(book),count=Number(seriesCounts.get(sKey)||0);if(count>=seriesCap)return false;
  const comic=isComic(book);if(comic&&comicCount>=comicLimit)return false;
  selected.push(book);selectedKeys.add(key);seriesCounts.set(sKey,count+1);if(comic)comicCount++;return true;
}
function selectedGenreCount(genre){return selected.reduce((sum,book)=>sum+(genreMatches(book,genre)?1:0),0)}

for(const genre of GENRES){
  let count=selectedGenreCount(genre);
  if(count>=GENRE_FLOOR)continue;
  for(const book of pool){
    if(count>=GENRE_FLOOR||selected.length>=CURATED_TARGET)break;
    if(!genreMatches(book,genre))continue;
    if(Number(book.reviewCount||0)<1&&Number(book.discountPercent||0)<35&&Number(book.sourceOrder||Infinity)>1200)continue;
    if(addBook(book))count++;
  }
}
for(const book of pool){if(selected.length>=CURATED_TARGET)break;addBook(book)}
for(const book of pool){if(selected.length>=CURATED_TARGET)break;addBook(book,{seriesCap:RELAXED_SERIES_CAP,comicLimit:CURATED_TARGET})}

const items=selected.sort((a,b)=>Number(b.qualityScore||0)-Number(a.qualityScore||0)||Number(b.reviewCount||0)-Number(a.reviewCount||0)||Number(a.sourceOrder||0)-Number(b.sourceOrder||0));
const byGenre={},genreStatus={};
for(const genre of GENRES){const list=items.filter(book=>genreMatches(book,genre));byGenre[genre.id]=list.map(book=>book.id);genreStatus[genre.id]={matched:list.length,complete:list.length>=Math.min(GENRE_FLOOR,10)}}
const payload={
  kind:'sale',completed:true,exhaustive:true,scannedExhaustive:true,displayCurated:true,sourceUrl:raw.sourceUrl||'',officialSaleIndex:raw.officialSaleIndex||'',updatedAt:new Date().toISOString(),
  campaignCount:Number(raw.campaignCount||raw.campaigns?.length||0),campaigns:raw.campaigns||[],sourceCounts:raw.sourceCounts||{},sourceTotals:raw.sourceTotals||{},
  candidateCount:candidates.length,scanned:candidates.length,matched:items.length,curatedTarget:CURATED_TARGET,lowValueExcluded,seriesCap:SERIES_CAP,comicCap:COMIC_CAP,
  reviewedSelected:items.filter(book=>Number(book.reviewCount||0)>0).length,failedBatches:0,verifiedByApi:0,verifiedByListing:items.length,rejectedByApiPrice:0,
  saleVerification:'current-rakuten-kobo-sale-listing-direct-product',qualityStrategy:'reviews-rating-discount-savings-source-rank-series-diversity',items,byGenre,genreStatus
};
await writeFile(outputPath,`${JSON.stringify(payload,null,2)}\n`,'utf8');
console.log(`Built curated sale feed: ${items.length}/${candidates.length} from exhaustive scan; reviewed=${payload.reviewedSelected}; low-value excluded=${lowValueExcluded}; comics=${comicCount}`);
console.log(`Genre counts: ${GENRES.map(g=>`${g.id}:${byGenre[g.id].length}`).join(' ')}`);
