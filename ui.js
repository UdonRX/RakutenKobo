import { GENRES, AWARDS } from './catalog.js';

const VERSION='0.3.1';
const esc=(value='')=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const yen=value=>Number(value)>0?`¥${Number(value).toLocaleString()}`:'価格情報なし';

const AWARD_DESCRIPTIONS={
  hontai:'全国の書店員が「いちばん売りたい本」を投票で選ぶ賞。話題性と読みやすさを兼ねた作品が多く選ばれます。',
  akutagawa:'新進作家による純文学作品を対象とする代表的な文学賞。現代文学の新しい表現に出会いやすい賞です。',
  naoki:'大衆文芸・エンターテインメント性の高い作品を中心に選ばれる代表的な文学賞です。',
  yamamoto:'物語性に富んだ優れた小説を顕彰する文学賞。ジャンルを問わず読み応えのある作品が選ばれます。',
  yoshikawa:'優れた大衆文学作品や作家の業績を顕彰する文学賞。長く読まれる骨太な作品が中心です。',
  'yoshikawa-new':'将来性のある新鋭作家の優れた作品に贈られる新人文学賞です。',
  edogawa:'未発表の長編推理小説を対象とする公募新人賞。新しいミステリー作家の登竜門として知られます。',
  'mystery-writers':'日本推理作家協会が、その年の優れたミステリー作品を選ぶ賞です。',
  oyabu:'優れたエンターテインメント小説の新鋭を顕彰する賞。骨太な物語や犯罪・冒険小説も多く選ばれます。'
};

export const NAV=[['popular','人気','◉'],['new','新作','✦'],['sale','セール','％'],['awards','受賞作','♛']];
export const SEARCH_MODES=[['title','タイトル'],['keyword','すべて'],['author','著者'],['publisher','出版社'],['isbn','ISBN']];
export const SORTS=[['standard','関連順'],['-releaseDate','新しい順'],['reviewCount','レビュー数'],['reviewAverage','評価順'],['+itemPrice','安い順'],['-itemPrice','高い順']];

export function chips(items,current,attr,scrollKey=''){
  return `<div class="chips"${scrollKey?` data-scroll-key="${esc(scrollKey)}"`:''}>${items.map(item=>`<button class="${String(current)===String(item.id)?'active':''}" data-${attr}="${esc(item.id)}">${esc(item.label)}</button>`).join('')}</div>`;
}
export function intro(title,text){return `<div class="section-intro"><h2>${esc(title)}</h2><p>${esc(text)}</p></div>`}
function skeleton(){return `<div class="book-grid">${Array(8).fill('<div class="skeleton-card"><div></div><span></span><span></span></div>').join('')}</div>`}
function empty(title,text){return `<div class="empty"><div class="empty-icon">▢</div><h3>${esc(title)}</h3><p>${esc(text)}</p></div>`}
function favorite(state,id){return state.favorites.some(book=>book.id===id)}
function isWatched(state,id){return state.watchList.some(book=>book.id===id)}
function priceHistory(state,book){return state.priceHistory?.[String(book.id||book.isbn||'')]||null}
function saleEndInfo(value){
  if(!value)return null;
  const time=new Date(value).getTime();if(!Number.isFinite(time))return null;
  const diff=time-Date.now(),date=new Date(time),month=date.getMonth()+1,day=date.getDate(),hour=String(date.getHours()).padStart(2,'0'),minute=String(date.getMinutes()).padStart(2,'0');
  const label=`${month}/${day} ${hour}:${minute}まで`;
  if(diff<=0)return {label,urgent:false,ended:true};
  const hours=Math.ceil(diff/3600000);
  return {label:hours<=48?`あと${hours}時間 · ${label}`:label,urgent:hours<=72,ended:false};
}
function salePriceMarkup(book,detail=false){
  const regular=Number(book.regularPrice||0),sale=Number(book.salePrice||0),current=Number(book.currentPrice||book.price||sale||0),discount=Number(book.discountPercent||0);
  if(regular&&sale&&sale<regular){
    return `<div class="sale-price-row${detail?' detail-sale-price':''}"><span class="regular-price">${yen(regular)}</span><strong>${yen(sale)}</strong>${discount?`<b class="discount-badge">${discount}%OFF</b>`:''}</div>`;
  }
  return `<strong${detail?' class="detail-price"':''}>${yen(current)}</strong>`;
}
function rankingBadges(book){
  const sources=book.ranking?.sources||[];if(!sources.length)return '';
  return `<div class="ranking-sources">${sources.slice(0,3).map(item=>`<span>${esc(item.label||item.source)}${item.rank?` #${esc(item.rank)}`:''}</span>`).join('')}</div>`;
}
function bookFlags(state,book){
  const end=saleEndInfo(book.saleEndAt),history=priceHistory(state,book),current=Number(book.salePrice||book.currentPrice||book.price||0),drop=Number(book.watchDrop||0);
  const flags=[];
  if(end&&!end.ended)flags.push(`<span class="sale-end ${end.urgent?'urgent':''}">${esc(end.label)}</span>`);
  if(history?.min&&current&&Number(history.min)===current)flags.push('<span class="history-low">過去最安</span>');
  if(drop>0)flags.push(`<span class="watch-drop">${yen(drop)}値下がり</span>`);
  return flags.length?`<div class="book-flags">${flags.join('')}</div>`:'';
}

export function cards(state,books,ranked=false){
  if(state.loading)return skeleton();if(state.error)return empty('本を取得できません',state.error);if(!books.length)return empty('該当するKobo本がありません','条件を変えて探してみてください。');
  return `<div class="book-grid">${books.map((book,index)=>`<article class="book-card"><button class="cover-button" data-open="${index}">${book.image?`<img src="${esc(book.image)}" alt="" loading="lazy" decoding="async">`:'<div class="cover-placeholder">BOOK</div>'}${ranked?`<b class="rank">${book.ranking?.rank||index+1}</b>`:''}</button><div class="book-meta"><button class="book-title" data-open="${index}">${esc(book.title)}</button>${rankingBadges(book)}${book.awardMeta?`<p>${esc([book.awardMeta.edition,book.awardMeta.status].filter(Boolean).join(' · '))}</p>`:''}<p>${esc(book.author||'著者不明')}</p>${bookFlags(state,book)}<div class="price-row"><div class="price-stack">${salePriceMarkup(book)}</div><button class="heart ${favorite(state,book.id)?'active':''}" data-fav="${index}">${favorite(state,book.id)?'♥':'♡'}</button></div></div></article>`).join('')}</div>`;
}

function rankingSources(state){return [{id:'combined',label:'総合'},...Object.entries(state.rankingData||{}).map(([id,snap])=>({id,label:snap.label||id}))]}
function rankingNote(state){
  const snapshots=state.rankingData||{};const entries=state.source==='combined'?Object.entries(snapshots):Object.entries(snapshots).filter(([id])=>id===state.source);
  const sourceText=entries.length?entries.map(([,snap])=>`${snap.attribution||snap.label} / ${snap.periodLabel||''} / ${snap.updatedAt||'取得日不明'}${snap.live===false?'（保存スナップショット）':''}`).join('　|　'):'利用できるランキングがありません';
  const meta=state.popularMeta;const match=meta?` 候補${meta.candidates}冊からKobo版${meta.matched}冊を表示。`:'';
  const unavailable=(state.rankingUnavailable||[]).length?` 一時取得できない情報源: ${state.rankingUnavailable.join(' / ')}。`:'';
  return sourceText+'。'+match+unavailable+'ランキング掲載本をタイトル等でKoboへ照合し、Koboで購入できる本だけ表示します。';
}
export function popularView(state){return `<div class="segmented">${[['week','今週'],['month','今月'],['year','今年']].map(([id,label])=>`<button data-period="${id}" class="${state.period===id?'active':''}">${label}</button>`).join('')}</div>${chips(rankingSources(state),state.source,'source','ranking-source-tabs')}${intro('いま本当に売れている本','Amazon・楽天ブックス・書店ランキングなどを横断し、Koboで買える作品だけに絞ります。')}${cards(state,state.books,true)}<p class="source-note">${esc(rankingNote(state))}</p>`}
export function newView(state){return `${intro('新しく届いた本','楽天Koboの新着を発売日の新しい順に表示。右下のジャンルから、このタブだけ絞り込めます。')}${cards(state,state.books)}`}
export function saleView(state){
  const sorts=[{id:'recommended',label:'おすすめ'},{id:'discount',label:'割引率'},{id:'price',label:'安い順'},{id:'ending',label:'終了間近'}];
  const meta=state.saleMeta?` セール候補${state.saleMeta.parsed||0}冊をKoboへ照合し${state.saleMeta.matched||0}冊一致。`:'';
  return `${chips(sorts,state.saleSort,'sale-sort','sale-sort-tabs')}${intro('いまセール中','通常価格とセール価格、割引率、終了時刻をまとめて確認できます。')}${cards(state,state.books)}<p class="source-note">楽天ブックスで公開されているKoboセール表示を取得し、Kobo APIの商品と照合。${esc(meta)}価格・終了時刻は変更される場合があるため、購入前にKoboの商品ページでも確認してください。</p>`;
}
export function awardView(state,awardYears){const award=AWARDS.find(item=>item.id===state.award)||AWARDS[0],years=awardYears.map(year=>({id:String(year),label:String(year)})),description=AWARD_DESCRIPTIONS[award.id]||'優れた作品を選ぶ文学賞です。';return `${chips(AWARDS,state.award,'award','award-tabs')}${chips(years,String(state.awardYear||''),'award-year','award-year-tabs')}${intro(award.label,description)}${cards(state,state.books)}<p class="source-note">受賞作だけでなく、公開されている候補作・ノミネート作も対象。タイトル・著者でKoboへ照合し、Kobo版が見つかった作品だけを表示します。</p>`}

function genreLabel(state){return GENRES.find(g=>g.id===state.genre)?.label||'ジャンル'}
function genreFab(state){return `<button class="genre-fab ${state.genre?'active':''}" data-action="genres"><b>▦</b><span>${esc(genreLabel(state))}</span></button>`}
function genreSheet(state){
  const options=[{id:'',label:'すべて',emoji:'全'},...GENRES];
  return `<div class="sheet-backdrop genre-backdrop" data-close-genres><div class="sheet genre-picker" data-stop><div class="drag"></div><div class="genre-picker-head"><div><div class="eyebrow">FILTER</div><h2>ジャンル</h2><p>選択はこのタブだけに保存されます。</p></div><button class="close-float" data-close-genres>×</button></div><div class="genre-grid compact">${options.map(g=>`<button class="${String(state.genre||'')===String(g.id)?'active':''}" data-genre-option="${esc(g.id)}"><span>${esc(g.emoji||'全')}</span><strong>${esc(g.label)}</strong><b>›</b></button>`).join('')}</div></div></div>`;
}

export function searchSheet(state,history){return `<div class="sheet full"><div class="sheet-head"><div class="search-field"><span>⌕</span><input id="search-input" value="${esc(state.query)}" placeholder="本のタイトル・著者を検索"></div><button class="icon-button" data-close-search>×</button></div>${chips(SEARCH_MODES.map(([id,label])=>({id,label})),state.searchMode,'search-mode','search-mode-tabs')}<div class="sort-row"><span>並び替え</span><select id="sort-select">${SORTS.map(([id,label])=>`<option value="${id}" ${state.sort===id?'selected':''}>${label}</option>`).join('')}</select></div><div class="sheet-content">${state.query?cards(state,state.books):`<div class="history"><h3>最近の検索</h3>${history.length?history.map(item=>`<button data-history="${esc(item)}">${esc(item)}<b>›</b></button>`).join(''):'<p>検索履歴はこのiPhone内だけに保存されます。</p>'}</div>`}</div></div>`}

export function detailSheet(state,book){
  const fav=favorite(state,book.id),watch=isWatched(state,book.id),award=book.awardMeta,awardText=award?[award.year,award.edition,award.status,award.rank?`${award.rank}位`:''].filter(Boolean).join(' · '):'',end=saleEndInfo(book.saleEndAt),history=priceHistory(state,book),sources=book.ranking?.sources||[];
  return `<div class="sheet-backdrop" data-close-detail><div class="sheet detail" data-stop><div class="drag"></div><button class="close-float" data-close-detail>×</button><div class="detail-top"><div class="detail-cover">${book.image?`<img src="${esc(book.image)}" alt="" decoding="async">`:'<div class="cover-placeholder">BOOK</div>'}</div><div><span class="detail-kicker">${esc(book.publisher||'Rakuten Kobo')}</span><h2>${esc(book.title)}</h2><p>${esc(book.author||'')}</p>${salePriceMarkup(book,true)}</div></div><div class="detail-actions three"><button data-detail-fav>${fav?'♥ 保存済み':'♡ 気になる'}</button><button data-detail-watch>${watch?'✓ 監視中':'↘ 値下げ監視'}</button><a href="${esc(book.url)}" target="_blank" rel="noreferrer">Koboで見る ↗</a></div><div class="detail-info">${book.regularPrice?`<p><b>通常価格</b><span>${yen(book.regularPrice)}${book.discountPercent?` → ${book.discountPercent}%OFF`:''}</span></p>`:''}${end&&!end.ended?`<p><b>セール終了</b><span>${esc(end.label)}</span></p>`:''}${history?.min?`<p><b>過去最安</b><span>${yen(history.min)} <small>この端末で確認した範囲</small></span></p>`:''}${sources.length?`<p><b>ランキング</b><span>${sources.map(item=>`${item.label||item.source}${item.rank?` #${item.rank}`:''}`).join(' / ')}</span></p>`:''}${book.series?`<p><b>シリーズ</b><span>${esc(book.series)}</span></p>`:''}${book.salesDate?`<p><b>発売日</b><span>${esc(book.salesDate)}</span></p>`:''}${book.reviewCount?`<p><b>レビュー</b><span>★ ${Number(book.reviewAverage||0).toFixed(1)} / ${Number(book.reviewCount).toLocaleString()}件</span></p>`:''}${awardText?`<p><b>受賞情報</b><span>${esc(awardText)}</span></p>`:''}${award?.originalTitle?`<p><b>応募時題</b><span>${esc(award.originalTitle)}</span></p>`:''}<div class="caption">${esc(book.caption||'商品説明は楽天Koboで確認できます。')}</div></div></div></div>`;
}

export function favoritesView(state){
  const watchMode=state.listMode==='watch',baseState={...state,loading:watchMode?state.watchLoading:false,error:''},books=watchMode?state.watchList:state.favorites;
  return `<div class="sheet full"><div class="sheet-head"><div><div class="eyebrow">MY LIST</div><h2>気になる本</h2></div><button class="icon-button" data-close-favorites>×</button></div><div class="list-switch"><button data-list-mode="favorites" class="${!watchMode?'active':''}">♡ 保存</button><button data-list-mode="watch" class="${watchMode?'active':''}">↘ 値下げウォッチ${state.watchList.length?` ${state.watchList.length}`:''}</button></div><div class="sheet-content">${watchMode?`<p class="watch-note">開くたびに最新のKobo価格を照合します。登録時より安くなった本は「値下がり」と表示します。</p>`:''}${books.length?cards(baseState,books):empty(watchMode?'ウォッチ中の本はありません':'まだ保存されていません',watchMode?'本の詳細から「値下げ監視」を押すと登録できます。':'本の♡を押すと、このiPhoneに保存されます。')}</div></div>`;
}

export function layout(state,content,history){
  const title=NAV.find(item=>item[0]===state.tab)?.[1]||'Kobo Finder';
  return `<div class="app-shell"><header class="topbar"><div><div class="eyebrow">KOBO FINDER · v${VERSION}</div><h1>${title}</h1></div><div class="top-actions"><button class="icon-button" data-action="search">⌕</button><button class="icon-button fav-button" data-action="favorites">♡${state.favorites.length?`<span>${state.favorites.length}</span>`:''}</button></div></header><main class="content">${content}</main>${genreFab(state)}<nav class="bottom-nav">${NAV.map(([id,label,mark])=>`<button data-tab="${id}" class="${state.tab===id?'active':''}"><b>${mark}</b><span>${label}</span></button>`).join('')}</nav></div>${state.genreSheetOpen?genreSheet(state):''}${state.searchOpen?searchSheet(state,history):''}${state.selected?detailSheet(state,state.selected):''}${state.favoritesOpen?favoritesView(state):''}`;
}
