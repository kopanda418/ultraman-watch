// 収集元の定義。
// kind: 'rss'  … RSS/Atom をそのまま読む（最も安定。可能な限りこちらを使う）
// kind: 'news' … Google ニュース検索。期間を割って何回かに分けて取る（下記）
// kind: 'html' … CSS セレクタで一覧をパースする（サイト改修で壊れるので要メンテ）
// kind: 'imagination' … 円谷イマジネーション専用。下の定義のコメントを参照
//
// 新しい収集元を足すときは、まず対象サイトに RSS がないか確認してください。
// WordPress 系なら <トップURL>/feed/ が生きていることが多いです。

// ── Google ニュース検索の取り方 ─────────────────────────────
// 検索結果は「新着順」ではなく関連度順で、返る件数に上限がある（実測 100 件）。
// 期間を絞らないと 13 年前の記事まで枠に入り、しかも枠の中身は日をまたぐと
// 入れ替わるため、古い記事が「初めて見る記事」＝新着として毎回流れ込んでくる。
// そこで収集そのものを直近 60 日に限定する。
export const NEWS_WINDOW_DAYS = 60;

// さらに、期間を割って何回かに分けて取る。
// Google は類似記事をまとめて代表 1 件しか返さないため、期間を狭めるほど
// 別の記事が出てくる。上限に達していなくても取りこぼしている。
// 実測（2026-08-04、「ウルトラマン イベント」の 60 日分）:
//   単発 72 件 → 15 日刻み 4 分割 166 件 → 7.5 日刻み 8 分割 284 件
// 細かくするほど増えるが、増える分は日程未定・関東外に偏り雑音も混ざるため、
// 量と精度の釣り合いで 15 日を採った（依頼者と確認済み）。
export const NEWS_SLICE_DAYS = 15;

const googleNewsUrl = (q) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ja&gl=JP&ceid=JP:ja`;

// 期間を指定して取る。`&num=` や `&start=` は無視されるためページングはできず、
// 期間を割ることが上限を超える唯一の手段（実地確認・2026-08-04）。
export const newsSliceUrl = (query, after, before) =>
  googleNewsUrl(`${query} after:${after} before:${before}`);

// 「情報源」欄に出す代表URL。実際の取得は上の期間指定版を何回か叩いて行う。
const googleNews = (query) => googleNewsUrl(`${query} when:${NEWS_WINDOW_DAYS}d`);

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
    kind: 'news',
    query: 'ウルトラマン イベント',
    url: googleNews('ウルトラマン イベント'),
  },
  {
    id: 'news-show',
    name: 'ニュース検索（ショー）',
    category: 'news',
    kind: 'news',
    query: 'ウルトラマン ショー 開催',
    url: googleNews('ウルトラマン ショー 開催'),
  },
  {
    id: 'news-handshake',
    name: 'ニュース検索（撮影・握手会）',
    category: 'news',
    kind: 'news',
    query: 'ウルトラヒーロー 撮影会 握手会',
    url: googleNews('ウルトラヒーロー 撮影会 握手会'),
  },
  {
    id: 'news-sale',
    name: 'ニュース検索（特売・セール）',
    category: 'sale',
    kind: 'news',
    query: 'ウルトラマン グッズ セール 発売',
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
