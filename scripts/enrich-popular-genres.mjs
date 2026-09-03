import {readFile,writeFile} from'node:fs/promises';
import{resolve,join}from'node:path';
import*as cheerio from'cheerio';
import{chromium}from'playwright';
import{GENRES,RANKING_SNAPSHOTS,RANKING_SOURCE_META}from'../catalog.js';

const API=String(process.env.KOBO_API_BASE||'https://rakuten-kobo.vercel.app').replace(/\/+$/,'');
const DATA='https://raw.githubusercontent.com/UdonRX/RakutenKobo/ranking-data/data';
const dir=resolve(process.argv[2]||'/tmp/completed-feeds');
const ADULT=['アダルト','成年コミック','成人向け','18禁','官能','成人漫画','エロティック','R18','R18+'];
const LN=['ライトノベル','ラノベ','電撃文庫','MF文庫J','GA文庫','富士見ファンタジア文庫','ガガガ文庫'];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const clean=v=>String(v||'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
const norm=v=>String(v||'').normalize('NFKC').toLowerCase().replace(/[〜～]/g,'〜').replace(/[\s　・･:：!?！？()（）【】[\]「」『』〈〉《》#＃―ー\-]/g,'');
const text=b=>[b?.title,b?.author,b?.publisher,b?.caption,b?.series].filter(Boolean).join(' ');
const adult=b=>ADULT.some(w=>text(b).includes(w));
const ln=b=>LN.some(w=>text(b).includes(w));
function dedupe(list,keyFn){const s=new Set(),o=[];for(const x of list||[]){const k=keyFn(x);if(!k||s.has(k)||adult(x))continue;s.add(k);o.push(x)}return o}
const dedupeCandidates=l=>dedupe(l,x=>norm(x?.title));
const dedupeBooks=l=>dedupe(l,x=>String(x?.id||x?.isbn||'').trim()||`${norm(x?.title)}|${norm(x?.author)}`);

async function request(url,{json=false,options={},timeout=28000,retries=2}={}){
 let last;
 for(let n=0;n<=retries;n++){const c=new AbortController(),t=setTimeout(()=>c.abort(),timeout);try{
  const r=await fetch(url,{...options,signal:c.signal,headers:{Accept:json?'application/json':'text/html,application/xhtml+xml','Accept-Language':'ja-JP,ja;q=0.9',...(options.headers||{})}});
  const body=await r.text();if(!r.ok)throw new Error(`HTTP_${r.status}`);
  if(!json)return body;try{return body?JSON.parse(body):{}}catch{throw new Error('JSON_PARSE')}
 }catch(e){last=e;if(n<retries)await sleep(700*(n+1))}finally{clearTimeout(t)}}throw last
}
function snap(id,items,meta={}){const b=RANKING_SOURCE_META?.[id]||{};return{id,label:meta.label||b.label||id,attribution:meta.attribution||b.attribution||id,sourceUrl:meta.sourceUrl||b.sourceUrl||'',periodLabel:meta.periodLabel||'',updatedAt:meta.updatedAt||new Date().toISOString().slice(0,10),live:meta.live!==false,items:dedupeCandidates(items).map((x,i)=>({title:x.title,author:x.author||'',rank:Number(x.rank||i+1)}))}}
function fallback(period,id){const r=RANKING_SNAPSHOTS?.[period]?.[id];return r?snap(id,r.items||[],{...r,label:RANKING_SOURCE_META?.[id]?.label,attribution:RANKING_SOURCE_META?.[id]?.attribution,live:false}):null}

function headings(html,id,meta){const $=cheerio.load(html),a=[];$('h3').each((_,e)=>{const title=clean($(e).text());if(!title||title.length<2||title.length>220||/ランキング|ベストセラー|デイリー|ウィークリー|マンスリー/.test(title))return;a.push({title,author:'',rank:a.length+1})});return snap(id,a,meta)}
async function kinokuniya(period){if(!['week','month'].includes(period))return null;const v=period==='week'?'w':'m',url=`https://www.kinokuniya.co.jp/disp/CKnRankingPageCList.jsp?dispNo=107002001001&vTp=${v}`;try{return headings(await request(url),'kinokuniya',{label:'紀伊國屋書店',attribution:'紀伊國屋書店調べ',sourceUrl:url,periodLabel:period==='week'?'ウィークリー':'マンスリー'})}catch(e){console.warn('Kinokuniya',e.message);return null}}
async function tohan(period){try{const root='https://www.tohan.jp/bestsellers/',html=await request(root),$=cheerio.load(html);const links=$('a[href]').map((_,a)=>new URL($(a).attr('href'),root).href).get();const re=period==='week'?/20\d{2}_\d{4}_weekly\/?$/:period==='month'?/20\d{2}_\d{2}_monthly\/?$/:/20\d{2}_(?:firsthalf_total|yearly|total)\/?$/;const url=links.find(x=>re.test(x));if(!url)return fallback(period,'tohan');return headings(await request(url),'tohan',{label:'トーハン',attribution:'トーハン調べ',sourceUrl:url,periodLabel:period==='week'?'週間':period==='month'?'月間':'年次'})}catch(e){console.warn('Tohan',e.message);return fallback(period,'tohan')}}
async function amazon(){try{const d=await request(`${DATA}/amazon-ranking.json?t=${Date.now()}`,{json:true,timeout:12000,retries:0});return d?.items?.length?snap('amazon',d.items,{label:'Amazon',attribution:'Amazon.co.jp',sourceUrl:d.sourceUrl||'https://www.amazon.co.jp/gp/bestsellers/books',periodLabel:d.periodLabel||'現在のベストセラー',updatedAt:d.updatedAt,live:false}):null}catch{return null}}

async function rakuten(browser){const url='https://books.rakuten.co.jp/ranking/weekly/001/',p=await browser.newPage({locale:'ja-JP'}),m=new Map();
 const harvest=async()=>{for(const x of await p.evaluate(()=>{const c=s=>String(s||'').replace(/\s+/g,' ').trim(),o=[];for(const a of document.querySelectorAll('a[href*="/rb/"]')){const title=c(a.textContent)||c(a.querySelector('img')?.alt);if(!title)continue;let n=a,r=0,block='';for(let d=0;d<9;d++){n=n.parentElement;if(!n)break;block=c(n.textContent);const q=block.match(/(?:^|\s)(\d{1,3})位(?:\s|$)/);if(q){r=+q[1];break}}if(r)o.push({title,rank:r,block})}return o})){if(x.rank<=200&&!ADULT.some(w=>x.block.includes(w)))m.set(x.rank,{title:x.title,author:'',rank:x.rank})}};
 try{await p.goto(url,{waitUntil:'domcontentloaded',timeout:45000});await p.waitForTimeout(900);
  for(const s of await p.locator('select').all())try{const opts=await s.locator('option').allTextContents(),i=opts.findIndex(x=>/100/.test(x));if(i>=0){const v=await s.locator('option').nth(i).getAttribute('value');if(v){await s.selectOption(v);await p.waitForTimeout(700);break}}}catch{}
  const b=p.locator('a,button').filter({hasText:/^\s*100件\s*$/}).first();if(await b.count())try{await b.click({timeout:2500});await p.waitForTimeout(700)}catch{}
  await harvest();const urls=await p.locator('a[href*="/ranking/weekly/001/"]').evaluateAll(a=>[...new Set(a.map(x=>x.href).filter(Boolean))]);for(const u of urls)if(u!==p.url())try{await p.goto(u,{waitUntil:'domcontentloaded',timeout:30000});await p.waitForTimeout(350);await harvest()}catch{}
 }catch(e){console.warn('Rakuten Books',e.message)}finally{await p.close()}
 const items=[...m.values()].sort((a,b)=>a.rank-b.rank);return items.length?snap('rakuten',items,{label:'楽天ブックス',attribution:'楽天ブックス',sourceUrl:url,periodLabel:'週間'}):null}

function merge(sources){const m=new Map();for(const[source,s]of Object.entries(sources))for(const x of s.items||[]){const k=norm(x.title);if(!k)continue;const r=Math.max(1,+x.rank||999),v=m.get(k)||{title:x.title,author:x.author||'',score:0,sources:[],source:'combined'};v.score+=Math.max(1,160-Math.min(r,150));if(!v.author&&x.author)v.author=x.author;if(!v.sources.some(y=>y.source===source))v.sources.push({source,label:s.label||source,rank:r});m.set(k,v)}return[...m.values()].sort((a,b)=>b.sources.length-a.sources.length||b.score-a.score).map((x,i)=>({...x,rank:i+1}))}
const simplify=v=>String(v||'').normalize('NFKC').replace(/[〜～]/g,'〜').replace(/\s+/g,' ').trim().replace(/\s*[（(][^）)]*(?:コミックス|コミック|DIGITAL|電子|文庫|新書|単行本|BOOKS?)[^）)]*[）)]\s*$/iu,'').replace(/\s*\[[^\]]*(?:電子|DIGITAL|コミック)[^\]]*\]\s*$/iu,'').trim();
async function resolveAll(c){let out=[],checked=0,failed=0;for(let off=0;off<c.length;off+=8){const groups=[c.slice(off,off+4),c.slice(off+4,off+8)].filter(x=>x.length),settled=await Promise.allSettled(groups.map(g=>request(`${API}/api/kobo?action=resolve`,{json:true,timeout:30000,retries:1,options:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:g.map(x=>{const t=simplify(x.title)||x.title;return{...x,title:t,originalTitle:t!==x.title?x.title:''}})})}})));for(let i=0;i<settled.length;i++){checked+=groups[i].length;if(settled[i].status==='fulfilled')out.push(...(settled[i].value.items||[]));else failed++}out=dedupeBooks(out);console.log(`Popular full resolve ${checked}/${c.length}; Kobo ${out.length}`);if(off+8<c.length)await sleep(120)}return{items:out,checked,failed}}
function snapshots(sources,books){const o={};for(const[source,s]of Object.entries(sources)){const rows=[];for(const b of books){const m=b.matchMeta||b.ranking||{},q=(m.sources||[]).find(x=>x.source===source);if(q)rows.push({title:m.originalTitle||m.title||b.title,author:m.author||b.author||'',rank:+q.rank||0})}rows.sort((a,b)=>a.rank-b.rank);if(rows.length)o[source]={...s,items:rows}}return o}
async function genreMap(){const o={};for(const g of GENRES)try{const p=new URLSearchParams({action:'genre-resolve',genreKey:g.id,genreNames:g.names.join('|'),parentNames:g.parentNames.join('|')});o[g.id]=(await request(`${API}/api/kobo?${p}`,{json:true,timeout:22000})).resolvedGenre||null}catch{o[g.id]=null}return o}
function byGenre(items,resolved){const byGenre={},genreStatus={};for(const g of GENRES){const id=String(resolved[g.id]?.id||''),list=items.filter(b=>{if(g.excludeLightNovel&&ln(b))return false;if(g.id==='essay')return/エッセイ|随筆/u.test(text(b));return id&&String(b.genreId||'').split('/').some(x=>x===id||x.startsWith(id))});byGenre[g.id]=list;genreStatus[g.id]={matched:list.length,complete:true}}return{byGenre,genreStatus}}

const resolvedGenres=await genreMap(),browser=await chromium.launch({headless:true});
try{for(const period of['week','month','year']){const file=join(dir,`popular-${period}.json`);let base={};try{base=JSON.parse(await readFile(file,'utf8'))}catch{}const sources={};
 if(period==='week'){const r=await rakuten(browser);if(r)sources.rakuten=r;const a=await amazon();if(a)sources.amazon=a;const m=fallback('week','maruzen');if(m)sources.maruzen=m}
 const k=await kinokuniya(period);if(k?.items?.length)sources.kinokuniya=k;const t=await tohan(period);if(t?.items?.length)sources.tohan=t;
 for(const[id,s]of Object.entries(base.snapshots||{}))if(!sources[id])sources[id]=s;
 const candidates=merge(sources);if(!candidates.length){console.warn(`Popular ${period}: keep base`);continue}const r=await resolveAll(candidates);if(!r.items.length){console.warn(`Popular ${period}: keep base`);continue}
 const items=r.items.map((b,i)=>({...b,ranking:{...(b.matchMeta||{}),rank:i+1}})),snaps=snapshots(sources,items),g=byGenre(items,resolvedGenres);
 await writeFile(file,`${JSON.stringify({kind:'popular',completed:true,expandedAllPublishedRanks:true,period,updatedAt:new Date().toISOString(),candidateCount:candidates.length,checked:r.checked,matched:items.length,failedBatches:r.failed,unavailable:Object.keys(sources).filter(id=>!snaps[id]?.items?.length),snapshots:snaps,items,...g},null,2)}\n`);
 console.log(`Popular ${period} expanded: ${candidates.length} candidates -> ${items.length} Kobo; ${Object.entries(snaps).map(([id,s])=>`${id}:${s.items.length}`).join(' ')}`)
}}finally{await browser.close()}
