// 収集元の定義。
// kind: 'rss'  … RSS/Atom をそのまま読む（最も安定。可能な限りこちらを使う）
// kind: 'html' … CSS セレクタで一覧をパースする（サイト改修で壊れるので要メンテ）
//
// 新しい収集元を足すときは、まず対象サイトに RSS がないか確認してください。
// WordPress 系なら <トップURL>/feed/ が生きていることが多いです。

const googleNews = (query) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ja&gl=JP&ceid=JP:ja`;

export const SOURCES = [
  // ── 公式 ────────────────────────────────────────────────
  {
    id: 'tsuburaya-news',
    name: '円谷ステーション',
    category: 'official',
    kind: 'rss',
    url: 'https://m-78.jp/feed/',
    // フィードが無ければ下の html 定義に差し替えてください
  },
  {
    id: 'tsuburaya-event',
    name: '円谷ステーション イベント',
    category: 'official',
    kind: 'rss',
    url: 'https://m-78.jp/event/feed/',
    // 実地確認済み: /event/ 配下の専用 RSS が生きている（2026-08-03）。
    // html セレクタ版は地域・カテゴリ・日付が区切りなく連結されタイトルが壊れるため廃止した。
  },
  // 「ウルトラマン カードゲーム 大会情報」は削除した。
  // https://ultraman-cardgame.com/page/jp/tournament/tournament-list は Nuxt 製 SPA で、
  // 大会一覧は初期 HTML には含まれずマウント後に JS が取得する。
  // __NUXT_DATA__ にも一覧データは埋め込まれておらず（CSRF 情報のみ）、
  // 現行の cheerio 構成（静的 HTML 取得のみ）では中身を取得できないため実地確認の上で対象外にした（2026-08-03）。

  // ── 横断検索（自治体・商業施設・非公式主催を拾う主力）────────
  {
    id: 'news-event',
    name: 'ニュース検索（イベント）',
    category: 'news',
    kind: 'rss',
    url: googleNews('ウルトラマン イベント'),
  },
  {
    id: 'news-show',
    name: 'ニュース検索（ショー）',
    category: 'news',
    kind: 'rss',
    url: googleNews('ウルトラマン ショー 開催'),
  },
  {
    id: 'news-handshake',
    name: 'ニュース検索（撮影・握手会）',
    category: 'news',
    kind: 'rss',
    url: googleNews('ウルトラヒーロー 撮影会 握手会'),
  },
  {
    id: 'news-sale',
    name: 'ニュース検索（特売・セール）',
    category: 'sale',
    kind: 'rss',
    url: googleNews('ウルトラマン グッズ セール 発売'),
  },
];

// 楽天商品検索 API を使う場合はここに App ID を入れて有効化する。
// 未設定なら価格監視はスキップされます。
export const RAKUTEN = {
  enabled: Boolean(process.env.RAKUTEN_APP_ID),
  appId: process.env.RAKUTEN_APP_ID ?? '',
  keyword: 'ウルトラマン',
  // 「この価格を下回ったら新着扱い」の閾値。null なら価格判定なし。
  maxPrice: null,
};
