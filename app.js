import { GENRES, AWARD_BOOKS, RANKING_SNAPSHOTS } from './catalog.js';
import { layout, popularView, newView, awardView, genresView, availableRankingSources } from './ui.js';

const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
const load=(k,f)=>{try{return JSON.parse(localStorage.getItem(k)||JSON.stringify(f))}catch{return f}};
const save=(k,v)=>localStorage.setItem(k,JSON.stringify(v));
const normalize=(v='')=>String(v).normalize('NFKC').toLowerCase().replace(/[\s　・･:：!?！？()（）【】\[\]「」『』〈〉《》#＃―ー\-]/g,'');

const HONTAI_2024 = [
  ['水車小屋のネネ','津村記久子','2位',2],
  ['存在のすべてを','塩田武士','3位',3],
  ['スピノザの診察室','夏川草介','4位',4],
  ['レーエンデ国物語','多崎礼','5位',5],
  ['黄色い家','川上未映子','6位',6],
  ['リカバリー・カバヒコ','青山美智子','7位',7],
  ['星を編む','凪良ゆう','8位',8],
  ['放課後ミステリクラブ 1 金魚の泳ぐプール事件','知念実希人','9位',9],
  ['君が手にするはずだった黄金について','小川哲','10位',10]
].map(([title,author,status,rank])=>({award:'hontai',year:2024,title,author,status,edition:'第21回',rank}));
const AWARD_DATA = [...AWARD_BOOKS, ...HONTAI_2024].filter((item,index,list)=>list.findIndex(other=>other.award===item.award&&other.year===item.year&&normalize(other.title)===normalize(item.title))===index);
const FICTION_SUBGENRE_IDS = new Set(GENRES.filter(item=>item.id!=='fiction'&&item.parentNames?.some(name=>normalize(name)===normalize('小説・エッセイ'))).map(item=>item.id));

const state={tab:'popular',period:'week',source:'combined',award:'hontai',awardYear:null,genre:null,genreSubfilter:'all',genreResolved:null,selected:null,searchOpen:false,favoritesOpen:false,favorites:load('kobo-favorites-v1',[]),searchMode:'title',sort:'standard',query:'',books:[],loading:false,error:'',popularMeta:null};
let requestToken=0, searchTimer=null;
const chipScroll=load('kobo-chip-scroll-v1',{});

async function api(params){
  let response;
  if(params.action==='resolve'){
    response=await fetch('/api/kobo?action=resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:JSON.parse(params.items||'[]')})});
  }else response=await fetch('/api/kobo?'+new URLSearchParams(params));
  const data=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(data.detail||data.error||'データを取得できませんでした');
  return data;
}

function dedupe(list){const seen=new Set();return list.filter(book=>{const key=`${normalize(book.series||book.title)}|${normalize(book.author)}`;if(seen.has(key))return false;seen.add(key);return true})}
function fav(id){return state.favorites.some(book=>book.id===id)}
function toggleFav(book){state.favorites=fav(book.id)?state.favorites.filter(item=>item.id!==book.id):[book,...state.favorites].slice(0,100);save('kobo-favorites-v1',state.favorites);render()}

function awardYears(){return [...new Set(AWARD_DATA.filter(item=>item.award===state.award).map(item=>item.year))].sort((a,b)=>b-a)}
function ensureAwardYear(){const years=awardYears();if(!years.includes(Number(state.awardYear)))state.awardYear=years[0]||null}
function statusPriority(item){const s=item.status||'';if(s.includes('大賞')||s.includes('受賞'))return item.rank||0;if(item.rank)return item.rank;if(s.includes('候補')||s.includes('ノミネート'))return 20;return 30}

function rankingSeeds(){
  const bucket=RANKING_SNAPSHOTS[state.period]||{};
  if(state.source!=='combined') return (bucket[state.source]?.items||[]).map(item=>({...item,source:state.source,sources:[{source:state.source,rank:item.rank}]}));
  const merged=new Map();
  for(const [source,snap] of Object.entries(bucket)) for(const item of snap.items||[]){
    const key=`${normalize(item.title)}|${normalize(item.author)}`;
    const cur=merged.get(key)||{title:item.title,author:item.author,score:0,sources:[]};
    cur.score+=Math.max(10,105-item.rank*5);cur.sources.push({source,rank:item.rank});merged.set(key,cur);
  }
  return [...merged.values()].sort((a,b)=>b.score-a.score).map((item,index)=>({...item,rank:index+1,source:'combined'}));
}

async function resolveMetadata(entries){
  if(!entries.length)return {items:[],requested:0,matched:0};
  const out=[];let requested=0,matched=0;
  for(let i=0;i<entries.length;i+=10){
    const chunk=entries.slice(i,i+10);
    const data=await api({action:'resolve',items:JSON.stringify(chunk)});
    out.push(...(data.items||[]));requested+=Number(data.requested||chunk.length);matched+=Number(data.matched||0);
  }
  return {items:out,requested,matched};
}

async function loadPopular(){
  const token=++requestToken;state.loading=true;state.error='';state.books=[];state.popularMeta=null;render();
  try{
    if(state.source==='kobo'){
      const data=await api({action:'search',sort:'reviewCount',hits:'30'});
      if(token===requestToken){state.books=(data.items||[]).map((book,index)=>({...book,ranking:{rank:index+1,source:'kobo',sources:[{source:'kobo',rank:index+1}]}}));state.popularMeta={candidates:data.items?.length||0,matched:data.items?.length||0,filled:0}}
    }else{
      const seeds=rankingSeeds().slice(0,30);
      const resolvedData=await resolveMetadata(seeds);
      let external=dedupe(resolvedData.items.map(book=>({...book,ranking:book.matchMeta})));
      let filled=0;
      if(state.source==='combined'&&external.length<12){
        const fallback=await api({action:'search',sort:'reviewCount',hits:'30'});
        const existing=new Set(external.map(book=>`${normalize(book.series||book.title)}|${normalize(book.author)}`));
        const extras=(fallback.items||[]).filter(book=>!existing.has(`${normalize(book.series||book.title)}|${normalize(book.author)}`)).slice(0,12-external.length).map(book=>({...book,ranking:{source:'kobo',sources:[{source:'kobo',rank:null}]}}));
        filled=extras.length;external=[...external,...extras];
        external=external.map((book,index)=>({...book,ranking:{...(book.ranking||{}),rank:index+1}}));
      }
      if(token===requestToken){state.books=external;state.popularMeta={candidates:seeds.length,matched:resolvedData.items.length,filled}}
    }
  }catch(error){if(token===requestToken)state.error=error.message}
  finally{if(token===requestToken){state.loading=false;render()}}
}

async function loadNew(){
  const token=++requestToken;state.loading=true;state.error='';state.books=[];render();
  try{const data=await api({action:'search',sort:'-releaseDate',hits:'30'});if(token===requestToken)state.books=data.items||[]}
  catch(error){if(token===requestToken)state.error=error.message}
  finally{if(token===requestToken){state.loading=false;render()}}
}

async function loadAward(){
  ensureAwardYear();const token=++requestToken;state.loading=true;state.error='';state.books=[];render();
  const entries=AWARD_DATA.filter(item=>item.award===state.award&&item.year===Number(state.awardYear)).sort((a,b)=>statusPriority(a)-statusPriority(b));
  try{const resolvedData=await resolveMetadata(entries);if(token===requestToken)state.books=dedupe(resolvedData.items.map(book=>({...book,awardMeta:book.matchMeta})))}
  catch(error){if(token===requestToken)state.error=error.message}
  finally{if(token===requestToken){state.loading=false;render()}}
}

function activeGenreConfig(){
  const base=GENRES.find(item=>item.id===state.genre);
  if(!base)return null;
  if(base.id==='fiction'&&state.genreSubfilter!=='all')return GENRES.find(item=>item.id===state.genreSubfilter)||base;
  return base;
}

async function loadGenre(){
  if(!state.genre)return;const genre=activeGenreConfig(), token=++requestToken;
  state.loading=true;state.error='';state.books=[];state.genreResolved=null;render();
  try{
    const inFictionFamily=state.genre==='fiction';
    const data=await api({action:'search',genreKey:genre.id,genreNames:genre.names.join('|'),parentNames:genre.parentNames.join('|'),fallbackQuery:genre.fallbackQuery,sort:'reviewCount',hits:'30',excludeLightNovel:(inFictionFamily||genre.excludeLightNovel)?'1':'0'});
    if(token===requestToken){state.books=data.items||[];state.genreResolved=data.resolvedGenre||null}
  }catch(error){if(token===requestToken)state.error=error.message}
  finally{if(token===requestToken){state.loading=false;render()}}
}

function currentView(){
  if(state.tab==='popular')return popularView(state);
  if(state.tab==='new')return newView(state);
  if(state.tab==='awards')return awardView(state,awardYears());
  return genresView(state,FICTION_SUBGENRE_IDS);
}

function captureChipScroll(){
  $$('[data-scroll-key]').forEach(el=>{chipScroll[el.dataset.scrollKey]=el.scrollLeft});
  save('kobo-chip-scroll-v1',chipScroll);
}
function restoreChipScroll(){
  $$('[data-scroll-key]').forEach(el=>{const value=Number(chipScroll[el.dataset.scrollKey]||0);if(value)el.scrollLeft=value});
}
function render(){captureChipScroll();document.querySelector('#app').innerHTML=layout(state,currentView(),load('kobo-search-history-v1',[]));bind();requestAnimationFrame(restoreChipScroll)}

function bind(){
  $$('[data-tab]').forEach(button=>button.onclick=()=>{state.tab=button.dataset.tab;state.genre=null;state.genreSubfilter='all';state.genreResolved=null;state.books=[];state.error='';if(state.tab==='awards')ensureAwardYear();render();if(state.tab==='popular')loadPopular();if(state.tab==='new')loadNew();if(state.tab==='awards')loadAward()});
  $('[data-action="search"]')?.addEventListener('click',()=>{state.searchOpen=true;state.books=[];state.error='';render();setTimeout(()=>$('#search-input')?.focus(),30)});
  $('[data-action="favorites"]')?.addEventListener('click',()=>{state.favoritesOpen=true;render()});
  $('[data-close-favorites]')?.addEventListener('click',()=>{state.favoritesOpen=false;render()});
  $$('[data-period]').forEach(button=>button.onclick=()=>{state.period=button.dataset.period;const ids=availableRankingSources(state.period).map(item=>item.id);if(!ids.includes(state.source))state.source='combined';loadPopular()});
  $$('[data-source]').forEach(button=>button.onclick=()=>{state.source=button.dataset.source;loadPopular()});
  $$('[data-award]').forEach(button=>button.onclick=()=>{state.award=button.dataset.award;state.awardYear=null;chipScroll['award-year-tabs']=0;ensureAwardYear();loadAward()});
  $$('[data-award-year]').forEach(button=>button.onclick=()=>{state.awardYear=Number(button.dataset.awardYear);loadAward()});
  $$('[data-genre]').forEach(button=>button.onclick=()=>{state.genre=button.dataset.genre;state.genreSubfilter='all';loadGenre()});
  $$('[data-genre-filter]').forEach(button=>button.onclick=()=>{state.genreSubfilter=button.dataset.genreFilter;loadGenre()});
  $('[data-back-genres]')?.addEventListener('click',()=>{state.genre=null;state.genreSubfilter='all';state.genreResolved=null;state.books=[];render()});
  $$('[data-open]').forEach(button=>button.onclick=()=>{const source=state.favoritesOpen?state.favorites:state.books;state.selected=source[Number(button.dataset.open)];render()});
  $$('[data-fav]').forEach(button=>button.onclick=event=>{event.stopPropagation();const source=state.favoritesOpen?state.favorites:state.books;toggleFav(source[Number(button.dataset.fav)])});
  $('[data-detail-fav]')?.addEventListener('click',()=>toggleFav(state.selected));
  $$('[data-close-detail]').forEach(item=>item.onclick=()=>{state.selected=null;render()}); $('[data-stop]')?.addEventListener('click',event=>event.stopPropagation());
  $('[data-close-search]')?.addEventListener('click',()=>{state.searchOpen=false;state.query='';state.books=[];state.error='';render()});
  $$('[data-search-mode]').forEach(button=>button.onclick=()=>{state.searchMode=button.dataset.searchMode;runSearch()});
  $('#sort-select')?.addEventListener('change',event=>{state.sort=event.target.value;runSearch()});
  $('#search-input')?.addEventListener('input',event=>{state.query=event.target.value;clearTimeout(searchTimer);searchTimer=setTimeout(runSearch,350)});
  $$('[data-history]').forEach(button=>button.onclick=()=>{state.query=button.dataset.history;render();runSearch()});
}

async function runSearch(){
  if(!state.searchOpen||!state.query.trim()){state.books=[];state.error='';render();return}
  const query=state.query.trim(), token=++requestToken;state.loading=true;state.error='';render();
  try{
    const data=await api({action:'search',q:query,mode:state.searchMode,sort:state.sort,hits:'24'});
    if(token===requestToken){state.books=data.items||[];const history=load('kobo-search-history-v1',[]);save('kobo-search-history-v1',[query,...history.filter(item=>item!==query)].slice(0,8))}
  }catch(error){if(token===requestToken)state.error=error.message}
  finally{if(token===requestToken){state.loading=false;render();setTimeout(()=>{const input=$('#search-input');if(input){input.focus();input.setSelectionRange(input.value.length,input.value.length)}},0)}}
}

if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
ensureAwardYear();render();loadPopular();
