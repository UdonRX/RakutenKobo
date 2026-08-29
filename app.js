import { GENRES, AWARD_BOOKS, RANKING_SNAPSHOTS } from './catalog.js';
import { layout, popularView, newView, awardView, genresView, availableRankingSources } from './ui.js';

const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
const load=(k,f)=>{try{return JSON.parse(localStorage.getItem(k)||JSON.stringify(f))}catch{return f}};
const save=(k,v)=>localStorage.setItem(k,JSON.stringify(v));
const normalize=(v='')=>String(v).normalize('NFKC').toLowerCase().replace(/[\s　・･:：!?！？()（）【】\[\]「」『』〈〉《》#＃―ー\-]/g,'');

const state={tab:'popular',period:'week',source:'combined',award:'hontai',awardYear:null,genre:null,genreResolved:null,selected:null,searchOpen:false,favoritesOpen:false,favorites:load('kobo-favorites-v1',[]),searchMode:'title',sort:'standard',query:'',books:[],loading:false,error:''};
let requestToken=0, searchTimer=null;

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

function awardYears(){return [...new Set(AWARD_BOOKS.filter(item=>item.award===state.award).map(item=>item.year))].sort((a,b)=>b-a)}
function ensureAwardYear(){const years=awardYears();if(!years.includes(Number(state.awardYear)))state.awardYear=years[0]||null}
function statusPriority(item){const s=item.status||'';if(s.includes('大賞')||s.includes('受賞'))return 0;if(item.rank)return item.rank;if(s.includes('候補')||s.includes('ノミネート'))return 20;return 30}

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
  if(!entries.length)return [];
  const data=await api({action:'resolve',items:JSON.stringify(entries.slice(0,12))});
  return data.items||[];
}

async function loadPopular(){
  const token=++requestToken;state.loading=true;state.error='';state.books=[];render();
  try{
    if(state.source==='kobo'){
      const data=await api({action:'search',sort:'reviewCount',hits:'24'});
      if(token===requestToken)state.books=(data.items||[]).map((book,index)=>({...book,ranking:{rank:index+1,source:'kobo',sources:[{source:'kobo',rank:index+1}]}}));
    }else{
      const resolved=await resolveMetadata(rankingSeeds().slice(0,12));
      if(token===requestToken)state.books=dedupe(resolved.map(book=>({...book,ranking:book.matchMeta})));
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
  const entries=AWARD_BOOKS.filter(item=>item.award===state.award&&item.year===Number(state.awardYear)).sort((a,b)=>statusPriority(a)-statusPriority(b));
  try{const resolved=await resolveMetadata(entries);if(token===requestToken)state.books=dedupe(resolved.map(book=>({...book,awardMeta:book.matchMeta})))}
  catch(error){if(token===requestToken)state.error=error.message}
  finally{if(token===requestToken){state.loading=false;render()}}
}

async function loadGenre(){
  if(!state.genre)return;const genre=GENRES.find(item=>item.id===state.genre), token=++requestToken;
  state.loading=true;state.error='';state.books=[];state.genreResolved=null;render();
  try{
    const data=await api({action:'search',genreKey:genre.id,genreNames:genre.names.join('|'),parentNames:genre.parentNames.join('|'),fallbackQuery:genre.fallbackQuery,sort:'reviewCount',hits:'30',excludeLightNovel:genre.excludeLightNovel?'1':'0'});
    if(token===requestToken){state.books=data.items||[];state.genreResolved=data.resolvedGenre||null}
  }catch(error){if(token===requestToken)state.error=error.message}
  finally{if(token===requestToken){state.loading=false;render()}}
}

function currentView(){
  if(state.tab==='popular')return popularView(state);
  if(state.tab==='new')return newView(state);
  if(state.tab==='awards')return awardView(state,awardYears());
  return genresView(state);
}

function render(){document.querySelector('#app').innerHTML=layout(state,currentView(),load('kobo-search-history-v1',[]));bind()}

function bind(){
  $$('[data-tab]').forEach(button=>button.onclick=()=>{state.tab=button.dataset.tab;state.genre=null;state.genreResolved=null;state.books=[];state.error='';if(state.tab==='awards')ensureAwardYear();render();if(state.tab==='popular')loadPopular();if(state.tab==='new')loadNew();if(state.tab==='awards')loadAward()});
  $('[data-action="search"]')?.addEventListener('click',()=>{state.searchOpen=true;state.books=[];state.error='';render();setTimeout(()=>$('#search-input')?.focus(),30)});
  $('[data-action="favorites"]')?.addEventListener('click',()=>{state.favoritesOpen=true;render()});
  $('[data-close-favorites]')?.addEventListener('click',()=>{state.favoritesOpen=false;render()});
  $$('[data-period]').forEach(button=>button.onclick=()=>{state.period=button.dataset.period;const ids=availableRankingSources(state.period).map(item=>item.id);if(!ids.includes(state.source))state.source='combined';loadPopular()});
  $$('[data-source]').forEach(button=>button.onclick=()=>{state.source=button.dataset.source;loadPopular()});
  $$('[data-award]').forEach(button=>button.onclick=()=>{state.award=button.dataset.award;state.awardYear=null;ensureAwardYear();loadAward()});
  $$('[data-award-year]').forEach(button=>button.onclick=()=>{state.awardYear=Number(button.dataset.awardYear);loadAward()});
  $$('[data-genre]').forEach(button=>button.onclick=()=>{state.genre=button.dataset.genre;loadGenre()});
  $('[data-back-genres]')?.addEventListener('click',()=>{state.genre=null;state.genreResolved=null;state.books=[];render()});
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
