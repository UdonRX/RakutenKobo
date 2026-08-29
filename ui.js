import { GENRES, AWARDS, RANKING_SOURCE_META, RANKING_SNAPSHOTS } from './catalog.js';

const VERSION='0.2.1';
const esc = (value = '') => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const yen = value => value ? `¥${Number(value).toLocaleString()}` : '価格情報なし';
const norm = (value='') => String(value).normalize('NFKC').replace(/[\s　]/g,'');

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

export const NAV = [['popular','人気','◉'],['new','新着','✦'],['awards','受賞作','♛'],['genres','ジャンル','▦']];
export const SEARCH_MODES = [['title','タイトル'],['keyword','すべて'],['author','著者'],['publisher','出版社'],['isbn','ISBN']];
export const SORTS = [['standard','関連順'],['-releaseDate','新しい順'],['reviewCount','レビュー数'],['reviewAverage','評価順'],['+itemPrice','安い順'],['-itemPrice','高い順']];

export function chips(items, current, attr, scrollKey='') {
  return `<div class="chips"${scrollKey?` data-scroll-key="${esc(scrollKey)}"`:''}>${items.map(item => `<button class="${String(current)===String(item.id)?'active':''}" data-${attr}="${esc(item.id)}">${esc(item.label)}</button>`).join('')}</div>`;
}

export function intro(title, text) { return `<div class="section-intro"><h2>${esc(title)}</h2><p>${esc(text)}</p></div>`; }
function skeleton(){return `<div class="book-grid">${Array(8).fill('<div class="skeleton-card"><div></div><span></span><span></span></div>').join('')}</div>`}
function empty(title,text){return `<div class="empty"><div class="empty-icon">▢</div><h3>${esc(title)}</h3><p>${esc(text)}</p></div>`}

export function cards(state, books, ranked=false){
  if(state.loading)return skeleton();if(state.error)return empty('本を取得できません',state.error);if(!books.length)return empty('該当するKobo本がありません','条件を変えて探してみてください。');
  const favorite=id=>state.favorites.some(book=>book.id===id);
  return `<div class="book-grid">${books.map((book,index)=>`<article class="book-card"><button class="cover-button" data-open="${index}">${book.image?`<img src="${esc(book.image)}" alt="" loading="lazy" decoding="async">`:'<div class="cover-placeholder">BOOK</div>'}${ranked?`<b class="rank">${book.ranking?.rank||index+1}</b>`:''}</button><div class="book-meta"><button class="book-title" data-open="${index}">${esc(book.title)}</button>${book.awardMeta?`<p>${esc([book.awardMeta.edition,book.awardMeta.status].filter(Boolean).join(' · '))}</p>`:''}<p>${esc(book.author||'著者不明')}</p><div><strong>${yen(book.price)}</strong><button class="heart ${favorite(book.id)?'active':''}" data-fav="${index}">${favorite(book.id)?'♥':'♡'}</button></div></div></article>`).join('')}</div>`;
}

export function availableRankingSources(period){const external=Object.keys(RANKING_SNAPSHOTS[period]||{}).filter(id=>RANKING_SOURCE_META[id]).map(id=>({id,label:RANKING_SOURCE_META[id].label}));return[{id:'combined',label:'総合'},...external,{id:'kobo',label:'Koboレビュー'}]}
function rankingNote(state){
  if(state.source==='kobo')return'楽天Kobo APIのレビュー件数順をリアルタイム取得。';
  const bucket=RANKING_SNAPSHOTS[state.period]||{},ids=state.source==='combined'?Object.keys(bucket):[state.source];
  const sourceText=ids.length?ids.map(id=>{const snap=bucket[id],meta=RANKING_SOURCE_META[id];return`${meta?.attribution||id} / ${snap?.updatedAt||'日付不明'} / ${snap?.periodLabel||''}${snap?.genre?` / ${snap.genre}`:''}`}).join('　|　'):'この期間の外部ランキングスナップショットはありません';
  const meta=state.popularMeta;
  const matchText=meta?` 外部ランキング候補${meta.candidates}冊をKoboと照合し${meta.matched}冊一致${meta.filled?`、不足分${meta.filled}冊をKoboレビュー上位から補完`:''}。`:'';
  return sourceText+'。'+matchText+'公開情報は基準日付きスナップショットとして管理し、アクセス時の自動スクレイピングは行いません。';
}

export function popularView(state){const sources=availableRankingSources(state.period);return `<div class="segmented">${[['week','今週'],['month','今月'],['year','今年']].map(([id,label])=>`<button data-period="${id}" class="${state.period===id?'active':''}">${label}</button>`).join('')}</div>${chips(sources,state.source,'source','ranking-source-tabs')}${intro('いま読まれている本','公開ランキングをKobo版へ照合し、総合ではKoboレビューも補助信号として使います。')}${cards(state,state.books,true)}<p class="source-note">${esc(rankingNote(state))}</p>`}
export function newView(state){return `${intro('新しく届いた本','楽天Koboのルートジャンルを発売日の新しい順に表示。予約作品も含まれます。')}${cards(state,state.books)}`}
export function awardView(state,awardYears){const award=AWARDS.find(item=>item.id===state.award)||AWARDS[0],years=awardYears.map(year=>({id:String(year),label:String(year)})),description=AWARD_DESCRIPTIONS[award.id]||'優れた作品を選ぶ文学賞です。';return `${chips(AWARDS,state.award,'award','award-tabs')}${chips(years,String(state.awardYear||''),'award-year','award-year-tabs')}${intro(award.label,description)}${cards(state,state.books)}<p class="source-note">賞データは公式・主催者情報を基準に管理し、表示時はタイトル・著者でKobo APIへ照合。Kobo版が見つかった作品だけを表示します。</p>`}

function fictionChildren(fictionSubgenreIds){return GENRES.filter(g=>fictionSubgenreIds?.has(g.id)).map(g=>({id:g.id,label:g.label}))}
export function genresView(state,fictionSubgenreIds){
  if(!state.genre){
    const roots=GENRES.filter(g=>g.id==='fiction'||!fictionSubgenreIds?.has(g.id));
    return `${intro('ジャンルから探す','小説配下のジャンルは「小説」の中で絞り込み。小説ではライトノベルを除外し、成人向け作品は表示しません。')}<div class="genre-grid">${roots.map(g=>`<button data-genre="${g.id}"><span>${g.emoji}</span><strong>${esc(g.label)}</strong><b>›</b></button>`).join('')}</div>`;
  }
  const base=GENRES.find(g=>g.id===state.genre),active=state.genre==='fiction'&&state.genreSubfilter!=='all'?GENRES.find(g=>g.id===state.genreSubfilter):base,resolved=state.genreResolved;
  const filter=state.genre==='fiction'?chips([{id:'all',label:'すべて'},...fictionChildren(fictionSubgenreIds)],state.genreSubfilter,'genre-filter','fiction-filter-tabs'):'';
  const resolvedText=resolved?`正式Koboジャンル: ${resolved.name}（${resolved.id}）${state.genre==='fiction'?' / ライトノベル除外':''}`:`公式ジャンルIDを検索中。特定できない場合のみ「${active?.fallbackQuery||base?.fallbackQuery}」で補助検索します。`;
  return `<button class="back-pill" data-back-genres>← ジャンル一覧</button>${filter}${intro(base.label,resolvedText)}${cards(state,state.books)}`;
}

export function searchSheet(state,history){return `<div class="sheet full"><div class="sheet-head"><div class="search-field"><span>⌕</span><input id="search-input" value="${esc(state.query)}" placeholder="本のタイトル・著者を検索"></div><button class="icon-button" data-close-search>×</button></div>${chips(SEARCH_MODES.map(([id,label])=>({id,label})),state.searchMode,'search-mode','search-mode-tabs')}<div class="sort-row"><span>並び替え</span><select id="sort-select">${SORTS.map(([id,label])=>`<option value="${id}" ${state.sort===id?'selected':''}>${label}</option>`).join('')}</select></div><div class="sheet-content">${state.query?cards(state,state.books):`<div class="history"><h3>最近の検索</h3>${history.length?history.map(item=>`<button data-history="${esc(item)}">${esc(item)}<b>›</b></button>`).join(''):'<p>検索履歴はこのiPhone内だけに保存されます。</p>'}</div>`}</div></div>`}

export function detailSheet(state,book){const fav=state.favorites.some(item=>item.id===book.id),award=book.awardMeta,awardText=award?[award.year,award.edition,award.status,award.rank?`${award.rank}位`:''].filter(Boolean).join(' · '):'';return `<div class="sheet-backdrop" data-close-detail><div class="sheet detail" data-stop><div class="drag"></div><button class="close-float" data-close-detail>×</button><div class="detail-top"><div class="detail-cover">${book.image?`<img src="${esc(book.image)}" alt="" decoding="async">`:'<div class="cover-placeholder">BOOK</div>'}</div><div><span class="detail-kicker">${esc(book.publisher||'Rakuten Kobo')}</span><h2>${esc(book.title)}</h2><p>${esc(book.author||'')}</p><strong class="detail-price">${yen(book.price)}</strong></div></div><div class="detail-actions"><button data-detail-fav>${fav?'♥ 保存済み':'♡ 気になる'}</button><a href="${esc(book.url)}" target="_blank" rel="noreferrer">Koboで見る ↗</a></div><div class="detail-info">${book.series?`<p><b>シリーズ</b><span>${esc(book.series)}</span></p>`:''}${book.salesDate?`<p><b>発売日</b><span>${esc(book.salesDate)}</span></p>`:''}${book.reviewCount?`<p><b>レビュー</b><span>★ ${Number(book.reviewAverage||0).toFixed(1)} / ${Number(book.reviewCount).toLocaleString()}件</span></p>`:''}${awardText?`<p><b>受賞情報</b><span>${esc(awardText)}</span></p>`:''}${award?.originalTitle?`<p><b>応募時題</b><span>${esc(award.originalTitle)}</span></p>`:''}<div class="caption">${esc(book.caption||'商品説明は楽天Koboで確認できます。')}</div></div></div></div>`}
export function favoritesView(state){return `<div class="sheet full"><div class="sheet-head"><div><div class="eyebrow">MY LIST</div><h2>気になる本</h2></div><button class="icon-button" data-close-favorites>×</button></div><div class="sheet-content">${state.favorites.length?cards(state,state.favorites):empty('まだ保存されていません','本の♡を押すと、このiPhoneに保存されます。')}</div></div>`}
export function layout(state,content,history){const title=NAV.find(item=>item[0]===state.tab)?.[1]||'Kobo Finder';return `<div class="app-shell"><header class="topbar"><div><div class="eyebrow">KOBO FINDER · v${VERSION}</div><h1>${title}</h1></div><div class="top-actions"><button class="icon-button" data-action="search">⌕</button><button class="icon-button fav-button" data-action="favorites">♡${state.favorites.length?`<span>${state.favorites.length}</span>`:''}</button></div></header><main class="content">${content}</main><nav class="bottom-nav">${NAV.map(([id,label,mark])=>`<button data-tab="${id}" class="${state.tab===id?'active':''}"><b>${mark}</b><span>${label}</span></button>`).join('')}</nav></div>${state.searchOpen?searchSheet(state,history):''}${state.selected?detailSheet(state,state.selected):''}${state.favoritesOpen?favoritesView(state):''}`}
