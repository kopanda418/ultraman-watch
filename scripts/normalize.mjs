import { createHash } from 'node:crypto';

// URL に付く計測パラメータ。これを消さないと同じ記事が別 ID になる。
const TRACKING_PARAMS = [
  /^utm_/, /^fbclid$/, /^gclid$/, /^yclid$/, /^msclkid$/,
  /^ref$/, /^ref_src$/, /^spm$/, /^cmpid$/, /^_ga$/,
];

export function normalizeUrl(input) {
  let u;
  try {
    u = new URL(input);
  } catch {
    return null;
  }
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.some((re) => re.test(key))) u.searchParams.delete(key);
  }
  u.search = u.searchParams.toString() ? `?${u.searchParams}` : '';
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString();
}

export const sha1 = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);

// タイトルの表記ゆれを吸収する。複数媒体が同じイベントを報じたときの
// 二次的な重複判定キーに使う。
// 例: 「【イベント】ウルトラマンショー in 東京 2026年9月12日 開催」と
//     「ウルトラマンショーin東京　2026年9月12日開催！」を同じキーに寄せる。
const NOISE_WORDS = /(開催|決定|情報|お知らせ|速報|募集|受付中|公開|実施)/g;

export function titleKey(title) {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[【\[（(《〈][^】\]）)》〉]*[】\]）)》〉]/g, '') // 【イベント】などの角括弧ごと除去
    .replace(/\d+\s*[年月日:：]/g, '')                        // 日付表記を除去
    .replace(/\d+/g, '')
    .replace(NOISE_WORDS, '')
    .replace(/[「」『』|｜/／\\・･,、.。!！?？;；"'’”“\-–—~〜\s]/g, '');
}

// 文字バイグラムの Jaccard 係数。表記ゆれが大きい場合の保険。
export function similarity(a, b) {
  const grams = (s) => new Set(Array.from({ length: Math.max(s.length - 1, 0) }, (_, i) => s.slice(i, i + 2)));
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return a === b ? 1 : 0;
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit += 1;
  return hit / (ga.size + gb.size - hit);
}

const KANTO = ['東京', '神奈川', '埼玉', '千葉', '茨城', '栃木', '群馬'];

// 「東京都」に「京都」が含まれるため、必ず正式名称を先に消してから
// 略称を探す。この順序を崩すと誤検出します。
const FULL_NAMES = {
  北海道: '北海道', 青森県: '青森', 岩手県: '岩手', 宮城県: '宮城', 秋田県: '秋田',
  山形県: '山形', 福島県: '福島', 茨城県: '茨城', 栃木県: '栃木', 群馬県: '群馬',
  埼玉県: '埼玉', 千葉県: '千葉', 東京都: '東京', 神奈川県: '神奈川', 新潟県: '新潟',
  富山県: '富山', 石川県: '石川', 福井県: '福井', 山梨県: '山梨', 長野県: '長野',
  岐阜県: '岐阜', 静岡県: '静岡', 愛知県: '愛知', 三重県: '三重', 滋賀県: '滋賀',
  京都府: '京都', 大阪府: '大阪', 兵庫県: '兵庫', 奈良県: '奈良', 和歌山県: '和歌山',
  鳥取県: '鳥取', 島根県: '島根', 岡山県: '岡山', 広島県: '広島', 山口県: '山口',
  徳島県: '徳島', 香川県: '香川', 愛媛県: '愛媛', 高知県: '高知', 福岡県: '福岡',
  佐賀県: '佐賀', 長崎県: '長崎', 熊本県: '熊本', 大分県: '大分', 宮崎県: '宮崎',
  鹿児島県: '鹿児島', 沖縄県: '沖縄',
};

const SHORT_NAMES = [...new Set(Object.values(FULL_NAMES))];

export function detectRegion(text) {
  const found = new Set();
  let rest = text;

  for (const [full, short] of Object.entries(FULL_NAMES)) {
    if (rest.includes(full)) {
      found.add(short);
      rest = rest.split(full).join(' ');
    }
  }
  for (const short of SHORT_NAMES) {
    if (rest.includes(short)) found.add(short);
  }

  const prefectures = [...found];
  return { prefectures, isKanto: prefectures.some((p) => KANTO.includes(p)) };
}

const pad = (n) => String(n).padStart(2, '0');

// 「YYYY年M月D日」「YYYY/M/D」「M月D日」を出現順に拾う。
// 年が省略された日付の年をどう補うかが肝で、二段構えにしている。
//   1. 同じ文の中に既に年付きの日付があれば、その年を引き継ぐ
//      （「2026年6月5日(金)〜11月30日(月)」の後半。月が戻るときだけ翌年）
//   2. 手掛かりが無ければ、記事が書かれた日を基準にする
//      （「12月29日開催」なら、その記事が出た年の12月29日）
// 2 で現在年を使うと、古い記事のイベントが未来の予定に化けて
// isStale をすり抜ける。基準は必ず記事の公開日を渡すこと。
const DATE_RE = /(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日|(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})|(\d{1,2})月\s*(\d{1,2})日/g;

export function detectEventPeriod(text, reference = new Date()) {
  const ref = reference instanceof Date ? new Date(reference) : new Date(reference ?? Date.now());
  const base = Number.isNaN(ref.getTime()) ? new Date() : ref;
  const refYear = base.getFullYear();
  const refMonth = base.getMonth() + 1;

  const dates = [];
  let prevYear = null;
  let prevMonth = null;

  for (const m of text.matchAll(DATE_RE)) {
    let year;
    let month;
    let day;
    if (m[1]) [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
    else if (m[4]) [year, month, day] = [Number(m[4]), Number(m[5]), Number(m[6])];
    else {
      month = Number(m[7]);
      day = Number(m[8]);
      if (prevYear !== null) {
        year = prevYear;
        // 「12月20日〜1月10日」のような年跨ぎ
        if (prevMonth !== null && month < prevMonth) year += 1;
      } else {
        year = refYear;
        // 記事より前の月なら、翌年の予定を指していると読む
        if (month < refMonth) year += 1;
      }
    }
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    dates.push(`${year}-${pad(month)}-${pad(day)}`);
    prevYear = year;
    prevMonth = month;
  }

  if (dates.length === 0) return { start: null, end: null };
  const sorted = [...dates].sort();
  const start = dates[0];
  const end = sorted[sorted.length - 1];
  return { start, end: end === start ? null : end };
}

// 開催日（開始日）らしき文字列を拾う。見つからなければ null。
export function detectEventDate(text) {
  return detectEventPeriod(text).start;
}

// 終わったイベント・古すぎる記事かどうか。収集の時点で落とすのに使う。
// ・開催日が分かる → 終了日（無ければ開始日）が今日より前なら終了済み
// ・開催日が分からない → 記事の公開日が古すぎるなら、イベントも終わったとみなす
// 公開日すら無いものは判断材料が無いので残す（消しすぎない側に倒す）。
//
// 当初は1年にしていたが、それでは一覧 188 件中 160 件が開催日不明になり、
// うち 97 件が公開から 60 日超という「古い告知だらけ」の状態になった。
// ニュース検索は 60 日以内に絞って取得している（sources.mjs）ので、
// それより少し広い 90 日を保持の上限にする。
const STALE_ARTICLE_DAYS = 90;

export function isStale(item, now = new Date()) {
  // Actions は UTC で動くが、対象は日本のイベントなので JST の日付で判定する
  const today = new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
  const lastDay = item.eventEndDate ?? item.eventDate;
  if (lastDay) return lastDay < today;
  if (item.publishedAt) {
    return item.publishedAt < new Date(now.getTime() - STALE_ARTICLE_DAYS * 86_400_000).toISOString();
  }
  return false;
}

export function normalizeItem(raw) {
  const url = normalizeUrl(raw.url);
  if (!url) return null;

  const title = (raw.title ?? '').replace(/\s+/g, ' ').trim();
  if (!title) return null;

  const haystack = `${title} ${raw.summary ?? ''}`;
  const region = detectRegion(haystack);
  // 年の省略を補う基準は記事が書かれた日。現在日を使うと古い記事が未来に化ける
  const { start: eventDate, end: eventEndDate } = detectEventPeriod(haystack, raw.publishedAt);

  return {
    id: sha1(url),
    url,
    title,
    summary: (raw.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 180),
    sourceId: raw.sourceId,
    sourceName: raw.sourceName,
    category: raw.category,
    // ニュース検索経由のとき、記事を出した媒体のドメイン。
    // 元記事URLは分からないが、どのサイトの記事かはここで分かる。
    publisherHost: raw.publisherHost ?? null,
    publishedAt: raw.publishedAt ?? null,
    eventDate,
    eventEndDate,
    prefectures: region.prefectures,
    isKanto: region.isKanto,
    // 二次キー: 別媒体が同じイベントを報じたときの重複を潰す
    titleKey: titleKey(title),
    altKey: sha1(`${titleKey(title)}|${eventDate ?? ''}`),
  };
}

// 関東優先 → 開催日が新しい順（降順） → 新しく見つかった順
// 開催日は降順。過去のイベントは収集時に除外しているので、
// 先頭に来るのは「一番先の予定」になる。
export function sortForDisplay(items) {
  return [...items].sort((a, b) => {
    if (a.isKanto !== b.isKanto) return a.isKanto ? -1 : 1;
    if (a.eventDate && b.eventDate) return b.eventDate.localeCompare(a.eventDate);
    if (a.eventDate) return -1;
    if (b.eventDate) return 1;
    return (b.firstSeen ?? '').localeCompare(a.firstSeen ?? '');
  });
}
