import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GENRES } from '../catalog.js';

const inputPath=resolve(process.argv[2]||'/tmp/kobo-sale-candidates.json');
const outputPath=resolve(process.argv[3]||'/tmp/completed-feeds/kobo-sale.json');
const ADULT_WORDS=['アダルト','成年コミック','成人向け','18禁','官能','成人漫画','エロティック','R18','R18+'];
const LIGHT_NOVEL_WORDS=['ライトノベル','ラノベ','電撃文庫','MF文庫J','GA文庫','富士見ファンタジア文庫','ガガガ文庫'];
function normalize(v=''){return String(v).normalize('NFKC').toLowerCase().replace(/[〜～]/g,'〜').replace(/[\s　・･:：!?！？()（）【】\[\]「」『』〈〉《》#＃―ー\-]/g,'')}
function bookKey(book){const u=String(book?.url||'').trim(),n=String(book?.itemNumber||book?.isbn||'').trim();return u?`u:${u}`:n?`n:${n}`:`t:${normalize(book?.title)}|${normalize(book?.author)}`}
function searchableText(item){return [item?.title,item?.author,item?.publisher,item?.caption,item?.series,item?.sourceGenre].filter(Boolean).join(' ')}
function isAdult(item){const text=searchableText(item);return ADULT_WORDS.some(w=>text.includes(w))}
function isLightNovel(item){const text=searchableText(item);return LIGHT_NOVEL_WORDS.some(w=>text.includes(w))}
function validProductUrl(url=''){return /^https:\/\/books\.rakuten\.co\.jp\/rk\/[^/?#]+\/?(?:[?#].*)?$/i.test(String(url))}
function dedupe(list){const seen=new Set(),out=[];for(const item of list||[]){const key=bookKey(item);if(!key||seen.has(key)||isAdult(item))continue;seen.add(key);out.push(item)}return out}
function toBook(candidate,index){
  const regular=Number(candidate.regularPrice||0),sale=Number(candidate.salePrice||0),url=String(candidate.url||'');
  if(!candidate.title||!validProductUrl(url)||!regular||!sale||sale>=regular||isAdult(candidate))return null;
  const slug=url.match(/\/rk\/([^/?#]+)/i)?.[1]||normalize(candidate.title).slice(0,48)||String(index);
  return {
    id:`rk:${slug}`,title:candidate.title,author:candidate.author||'',publisher:candidate.publisher||'',price:sale,url,
    image:candidate.image||'',caption:candidate.caption||'',salesDate:candidate.salesDate||'',series:candidate.series||'',reviewAverage:0,reviewCount:0,
    genreId:'',isbn:/^\d+$/.test(String(candidate.itemNumber||''))?String(candidate.itemNumber):'',
    regularPrice:regular,salePrice:sale,discountPercent:Math.max(1,Math.round((1-sale/regular)*100)),saleEndAt:candidate.saleEndAt||'',
    saleCampaign:candidate.saleCampaign||'',saleCampaigns:candidate.saleCampaigns||[],saleSources:candidate.saleSources||['rakuten-kobo-sale-listing'],
    sourceGenre:candidate.sourceGenre||'',campaignMerch:candidate.campaignMerch||'',campaignUrl:candidate.campaignUrl||'',
    saleVerified:true,verification:'current-rakuten-kobo-sale-listing-direct-product',verifiedAt:new Date().toISOString(),sourceOrder:index
  };
}
function genreMatches(book,genre){
  const text=searchableText(book);
  if(genre.excludeLightNovel&&isLightNovel(book))return false;
  if(genre.id==='essay')return /エッセイ|随筆/u.test(text);
  if(genre.id==='comic')return /漫画|コミック|comic/i.test(text);
  return genre.names.some(name=>name&&text.includes(name))||String(book.sourceGenre||'').split(/[・／/]/).some(part=>genre.names.some(name=>part.includes(name)));
}

const raw=JSON.parse(await readFile(inputPath,'utf8'));
const candidates=(raw.items||[]).filter(item=>item?.title&&Number(item.regularPrice)>Number(item.salePrice)&&Number(item.salePrice)>0&&validProductUrl(item.url)&&!isAdult(item));
const items=dedupe(candidates.map(toBook).filter(Boolean)).sort((a,b)=>Number(a.sourceOrder||0)-Number(b.sourceOrder||0));
const byGenre={},genreStatus={};
for(const genre of GENRES){const list=items.filter(book=>genreMatches(book,genre));byGenre[genre.id]=list;genreStatus[genre.id]={matched:list.length,complete:true}}
const payload={
  kind:'sale',completed:true,exhaustive:true,sourceUrl:raw.sourceUrl||'',officialSaleIndex:raw.officialSaleIndex||'',updatedAt:new Date().toISOString(),
  campaignCount:Number(raw.campaignCount||raw.campaigns?.length||0),campaigns:raw.campaigns||[],sourceCounts:raw.sourceCounts||{},sourceTotals:raw.sourceTotals||{},
  candidateCount:candidates.length,checked:candidates.length,matched:items.length,failedBatches:0,verifiedByApi:0,verifiedByListing:items.length,rejectedByApiPrice:0,
  saleVerification:'current-rakuten-kobo-sale-listing-direct-product',items,byGenre,genreStatus
};
await writeFile(outputPath,`${JSON.stringify(payload,null,2)}\n`,'utf8');
console.log(`Built exhaustive sale feed: ${items.length}/${candidates.length} current Kobo sale books with direct /rk/ product URLs`);
console.log(`Genre counts: ${GENRES.map(g=>`${g.id}:${byGenre[g.id].length}`).join(' ')}`);
