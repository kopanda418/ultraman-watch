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

// 開催日らしき文字列を拾う。見つからなければ null。
export function detectEventDate(text) {
  const patterns = [
    /(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/,
    /(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const [, y, mo, d] = m;
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  const md = text.match(/(\d{1,2})月\s*(\d{1,2})日/);
  if (md) {
    const year = new Date().getFullYear();
    return `${year}-${String(md[1]).padStart(2, '0')}-${String(md[2]).padStart(2, '0')}`;
  }
  return null;
}

export function normalizeItem(raw) {
  const url = normalizeUrl(raw.url);
  if (!url) return null;

  const title = (raw.title ?? '').replace(/\s+/g, ' ').trim();
  if (!title) return null;

  const haystack = `${title} ${raw.summary ?? ''}`;
  const region = detectRegion(haystack);
  const eventDate = detectEventDate(haystack);

  return {
    id: sha1(url),
    url,
    title,
    summary: (raw.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 180),
    sourceId: raw.sourceId,
    sourceName: raw.sourceName,
    category: raw.category,
    publishedAt: raw.publishedAt ?? null,
    eventDate,
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
