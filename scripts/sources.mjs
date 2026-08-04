// 収集元の定義。
// kind: 'rss'  … RSS/Atom をそのまま読む（最も安定。可能な限りこちらを使う）
// kind: 'html' … CSS セレクタで一覧をパースする（サイト改修で壊れるので要メンテ）
// kind: 'imagination' … 円谷イマジネーション専用。下の定義のコメントを参照
//
// 新しい収集元を足すときは、まず対象サイトに RSS がないか確認してください。
// WordPress 系なら <トップURL>/feed/ が生きていることが多いです。

// Google ニュースの検索は「新着順」ではなく「関連度順」で、返る件数に上限がある
// （実測で 100 件）。期間を絞らないと 13 年前の記事まで枠の中に入り、しかも枠の
// 中身は日をまたぐと入れ替わるため、古い記事が「初めて見る記事」として毎回
// 流れ込んでくる。実測では上限 100 件のうち 60 日以内は 24 件しかなく、
// 古い記事が直近の記事を押し出していた。when: で絞ると 60 日以内を 65 件
// 拾えるようになり、取りこぼしも減る（2026-08-04 実測）。
const NEWS_WINDOW = 'when:60d';

const googleNews = (query) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} ${NEWS_WINDOW}`)}&hl=ja&gl=JP&ceid=JP:ja`;

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
  // 円谷イマジネーション（公式の配信サービス）。RSS は無い。
  // 一覧は Next.js がサーバー側で描画したデータとして HTML に埋まっているので、
  // そこから拾う（collect.mjs の fetchImagination）。DOM には出てこないため
  // セレクタ方式は使えない。サイト改修で壊れる作りなので、ログで 0 件が続いたら疑うこと。
  // 円谷ステーションと内容が重なるが、重複は既存の重複判定（URL・タイトル・
  // 類似度）で潰れる。SOURCES の順で先に来たほうが残るので、公式サイトを上に置く。
  {
    id: 'imagination-event',
    name: '円谷イマジネーション（イベント情報）',
    category: 'official',
    kind: 'imagination',
    url: 'https://imagination.m-78.jp/search/news/news_1',
  },
  {
    id: 'imagination-goods',
    name: '円谷イマジネーション（グッズ情報）',
    category: 'sale',
    kind: 'imagination',
    url: 'https://imagination.m-78.jp/search/news/news_4',
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
