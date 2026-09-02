(() => {
  const originalFetch = window.fetch.bind(window);
  const SNAPSHOT_URL = 'https://raw.githubusercontent.com/UdonRX/RakutenKobo/ranking-data/data/amazon-ranking.json';
  const CACHE_PREFIX = 'kobo-ranking-response-v2:';
  const CACHE_TTL = 6 * 60 * 60 * 1000;
  const REFRESH_AFTER = 30 * 60 * 1000;

  const FALLBACK = {
    week: {
      maruzen: {
        id: 'maruzen', label: '丸善ジュンク堂', attribution: '丸善ジュンク堂書店調べ',
        sourceUrl: 'https://www.maruzenjunkudo.co.jp/', periodLabel: '直近7日間', updatedAt: '2026-08-27', live: false,
        items: [
          ['永遠の記憶','東野圭吾'],['あなたが誰かを殺した','東野圭吾'],['プレゼント','伊坂幸太郎'],['80代になるとたいていボケるか死ぬ。70代は神様から与えられた特別な時間','林真理子'],['シャーロック・ホームズの凱旋','森見登美彦'],['白鳥とコウモリ（上）','東野圭吾'],['容疑者Xの献身','東野圭吾'],['白鳥とコウモリ（下）','東野圭吾'],['ブラッディダイスの殺人 上','M・W・クレイヴン'],['ブラッディダイスの殺人 下','M・W・クレイヴン']
        ].map(([title,author],index)=>({title,author,rank:index+1}))
      },
      tohan: {
        id: 'tohan', label: 'トーハン', attribution: 'トーハン調べ',
        sourceUrl: 'https://www.tohan.jp/bestsellers/', periodLabel: '週間', updatedAt: '2026-08-04', live: false,
        items: [
          ['つかめ!理科ダマン 12 最強ロボット決戦!編','シン・テフン'],['夏帆─The Tale of KAHO─','村上春樹'],['80代になるとたいていボケるか死ぬ。70代は神様から与えられた特別な時間','林真理子'],['楽園','夕木春央'],['地球の歩き方 スター・ウォーズ','地球の歩き方編集室'],['ポケモンずかんドリル 小学1年生 夏休みドリル','矢部一夫'],['くもんの夏休みドリル 小学1年生',''],['2026／27 J1&J2&J3選手名鑑','サッカーダイジェスト'],['おとなの学びシリーズ NHK3か月でマスターする ギター','ドクターキャピタル'],['けんぐゎい','朝倉かすみ']
        ].map(([title,author],index)=>({title,author,rank:index+1}))
      }
    },
    month: {
      tohan: {
        id: 'tohan', label: 'トーハン', attribution: 'トーハン調べ', sourceUrl: 'https://www.tohan.jp/bestsellers/', periodLabel: '2026年6月期', updatedAt: '2026-06', live: false,
        items: [
          ['GOAT Summer 2026',''],['ファイア・ドーム 上','辻村深月'],['ファイア・ドーム 下','辻村深月'],['80代になるとたいていボケるか死ぬ。70代は神様から与えられた特別な時間','林真理子'],['多類婚姻譚','凪良ゆう'],['100日後に英語がものになる 1日10分 ネイティブ英語書き写し','ブレット・リンゼイ'],['イン・ザ・メガチャーチ','朝井リョウ'],['青天','若林正恭'],['悩みの本──あなたが本気で生きている証','高橋佳子'],['NHK大河ドラマ・ガイド 豊臣兄弟! 後編','']
        ].map(([title,author],index)=>({title,author,rank:index+1}))
      }
    },
    year: {
      tohan: {
        id: 'tohan', label: 'トーハン', attribution: 'トーハン調べ', sourceUrl: 'https://www.tohan.jp/bestsellers/2026_firsthalf_total/', periodLabel: '2026年上半期', updatedAt: '2026-06-01', live: false,
        items: [
          ['科学的に証明された すごい習慣大百科','堀田秀吾'],['変な地図','雨穴'],['イン・ザ・メガチャーチ','朝井リョウ'],['成瀬は都を駆け抜ける','宮島未奈'],['TOEIC L&R TEST 出る単特急 金のフレーズ 増補改訂版','TEX加藤'],['WORLD SEIKYO vol.7',''],['暁星','湊かなえ'],['大河の一滴 最終章','五木寛之'],['不滅なるものへの挑戦 霊性の時代を拓くために','大川隆法'],['棺桶まで歩こう','萬田緑平']
        ].map(([title,author],index)=>({title,author,rank:index+1}))
      }
    }
  };

  function requestUrl(input) {
    try { return new URL(typeof input === 'string' ? input : input?.url, location.origin); }
    catch { return null; }
  }
  function rankingPeriod(input) {
    const url = requestUrl(input);
    if (url?.pathname !== '/api/kobo' || url.searchParams.get('action') !== 'rankings') return null;
    return url.searchParams.get('period') || 'week';
  }
  function readCache(period) {
    try {
      const value = JSON.parse(localStorage.getItem(`${CACHE_PREFIX}${period}`) || 'null');
      if (!value?.ts || !value?.data) return null;
      const age = Date.now() - Number(value.ts);
      if (age < 0 || age > CACHE_TTL) return null;
      return { ...value, age };
    } catch { return null; }
  }
  function writeCache(period, data) {
    try { localStorage.setItem(`${CACHE_PREFIX}${period}`, JSON.stringify({ ts: Date.now(), data })); } catch {}
  }
  function jsonResponse(data) {
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  function fallbackResponse(period) {
    const snapshots = FALLBACK[period] || {};
    return { period, snapshots, unavailable: [], fetchedAt: new Date().toISOString(), bootstrap: true };
  }
  async function readAmazonSnapshot() {
    try {
      const response = await originalFetch(`${SNAPSHOT_URL}?t=${Math.floor(Date.now() / 1800000)}`, { cache: 'no-store', mode: 'cors' });
      if (!response.ok) return null;
      const data = await response.json();
      return Array.isArray(data?.items) && data.items.length ? data : null;
    } catch { return null; }
  }
  async function fetchFresh(input, init, period) {
    const [baseResponse, amazon] = await Promise.all([
      originalFetch(input, init),
      period === 'week' ? readAmazonSnapshot() : Promise.resolve(null)
    ]);
    if (!baseResponse.ok) return baseResponse;
    const data = await baseResponse.clone().json().catch(() => null);
    if (!data) return baseResponse;
    if (amazon) {
      data.snapshots = { ...(data.snapshots || {}), amazon };
      data.unavailable = (data.unavailable || []).filter(id => id !== 'amazon');
    }
    writeCache(period, data);
    return jsonResponse(data);
  }

  window.fetch = async (input, init) => {
    const period = rankingPeriod(input);
    if (!period) return originalFetch(input, init);

    const cached = readCache(period);
    if (cached) {
      if (cached.age > REFRESH_AFTER) fetchFresh(input, init, period).catch(() => {});
      return jsonResponse(cached.data);
    }

    const fallback = fallbackResponse(period);
    if (Object.keys(fallback.snapshots).length) {
      fetchFresh(input, init, period).catch(() => {});
      return jsonResponse(fallback);
    }

    return fetchFresh(input, init, period);
  };
})();
