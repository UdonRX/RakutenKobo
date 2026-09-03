import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { GENRES } from '../catalog.js';

const API_BASE=String(process.env.KOBO_API_BASE||'https://rakuten-kobo.vercel.app').replace(/\/+$/,'');
const outputDir=resolve(process.argv[2]||'/tmp/completed-feeds');
const TARGET=10;
const MAX_PAGES=4;
const ADULT_WORDS=['アダルト','成年コミック','成人向け','18禁','官能','成人漫画','エロティック','R18','R18+'];
const LIGHT_NOVEL_WORDS=['ライトノベル','ラノベ','電撃文庫','MF文庫J','GA文庫','富士見ファンタジア文庫','ガガガ文庫'];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function normalize(v=''){return String(v).normalize('NFKC').toLowerCase().replace(/[\s　・･:：!?！？()（）【】\[\]「」『』〈〉《》#＃―ー\-]/g,'')}
function key(book){const id=String(book?.id||book?.isbn||'').trim();return id?`id:${id}`:`t:${normalize(book?.title)}|${normalize(book?.author)}`}
function text(book){return [book?.title,book?.author,book?.publisher,book?.caption,book?.series].filter(Boolean).join(' ')}
function adult(book){const t=text(book);return ADULT_WORDS.some(w=>t.includes(w))}
function lightNovel(book){const t=text(book);return LIGHT_NOVEL_WORDS.some(w=>t.includes(w))}
function dedupe(list){const seen=new Set(),out=[];for(const b of list||[]){const k=key(b);if(!k||seen.has(k)||adult(b))continue;seen.add(k);out.push(b)}return out}
function genreIds(v=''){return String(v||'').split('/').map(x=>x.trim()).filter(Boolean)}
function matches(book,genre,resolved){if(genre.excludeLightNovel&&lightNovel(book))return false;if(resolved?.id&&genreIds(book.genreId).some(id=>id===String(resolved.id)||id.startsWith(String(resolved.id))))return true;if(genre.id==='essay')return /エッセイ|随筆/u.test(text(book));return false}
async function fetchJson(url,options={},timeout=26000,retries=3){let last;for(let n=0;n<=retries;n++){const c=new AbortController(),timer=setTimeout(()=>c.abort(),timeout);try{const r=await fetch(url,{...options,signal:c.signal});const body=await r.text();let d={};try{d=body?JSON.parse(body):{}}catch{}if(!r.ok)throw new Error(d?.detail||d?.error||`HTTP_${r.status}`);return d}catch(e){last=e;if(n<retries)await sleep(1200*(n+1))}finally{clearTimeout(timer)}}throw last}
async function resolveGenre(genre){try{const p=new URLSearchParams({action:'genre-resolve',genreKey:genre.id,genreNames:genre.names.join('|'),parentNames:genre.parentNames.join('|')});const d=await fetchJson(`${API_BASE}/api/kobo?${p}`,{headers:{Accept:'application/json'}},22000,2);return d.resolvedGenre||null}catch{return null}}
async function fill(genre,resolved,seed){let out=dedupe((seed||[]).filter(b=>matches(b,genre,resolved))).slice(0,TARGET);for(let page=1;page<=MAX_PAGES&&out.length<TARGET;page++){const p=new URLSearchParams({action:'search',genreKey:genre.id,genreNames:genre.names.join('|'),parentNames:genre.parentNames.join('|'),fallbackQuery:genre.fallbackQuery,excludeLightNovel:genre.excludeLightNovel?'1':'0',sort:'reviewCount',hits:'30',page:String(page)});try{const d=await fetchJson(`${API_BASE}/api/kobo?${p}`,{headers:{Accept:'application/json'}},28000,3);out=dedupe([...out,...(d.items||[]).filter(b=>matches(b,genre,resolved))]).slice(0,TARGET)}catch(e){console.warn(`Popular ${genre.id} page ${page}: ${e.message}`)}if(out.length<TARGET)await sleep(1100)}return out}
async function mapLimit(items,limit,fn){const out=new Array(items.length);let cursor=0;async function worker(){while(true){const i=cursor++;if(i>=items.length)return;out[i]=await fn(items[i],i)}}await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));return out}
const genreResolved=Object.fromEntries(await mapLimit(GENRES,2,async g=>[g.id,await resolveGenre(g)]));
for(const period of ['week','month','year']){
  const file=join(outputDir,`popular-${period}.json`),feed=JSON.parse(await readFile(file,'utf8'));
  const results=await mapLimit(GENRES,2,async genre=>({genre:genre.id,items:await fill(genre,genreResolved[genre.id],feed.items||[])}));
  feed.byGenre={};feed.genreStatus={};feed.genreTarget=TARGET;
  for(const result of results){feed.byGenre[result.genre]=result.items;feed.genreStatus[result.genre]={target:TARGET,matched:result.items.length,complete:result.items.length>=TARGET}}
  feed.updatedAt=new Date().toISOString();await writeFile(file,`${JSON.stringify(feed,null,2)}\n`,'utf8');
  console.log(`Popular ${period} genres: ${results.map(r=>`${r.genre}:${r.items.length}`).join(' ')}`);
}
