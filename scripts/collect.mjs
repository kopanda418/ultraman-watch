import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import Parser from 'rss-parser';
import {
  SOURCES,
  RAKUTEN,
  NEWS_WINDOW_DAYS,
  NEWS_SLICE_DAYS,
  newsSliceUrl,
} from './sources.mjs';
import {
  normalizeItem,
  sortForDisplay,
  similarity,
  detectEventPeriod,
  isStale,
  titleKey,
  sha1,
} from './normalize.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SEEN_PATH = path.join(ROOT, 'state', 'seen.json');
const LAST_RUN_PATH = path.join(ROOT, 'state', 'last-run.json');
const ITEMS_PATH = path.join(ROOT, 'docs', 'data', 'items.json');
const SOURCES_PATH = path.join(ROOT, 'docs', 'data', 'sources.json');

// items.json に残す最大件数。溢れた分は並び順の末尾（関東外・日程未定・古い順）
// から落ち、seen.json には既報として残るため戻ってこない。
// 上限の根拠は DECISIONS.md「保持は 300 件まで」を参照。
const KEEP_ITEMS = 300;
const POLITE_DELAY_MS = 3000;    // 相手サーバーへの間隔
const UA = 'ultraman-watch/1.0 (personal event tracker)';

const force = process.env.FORCE === 'true';
const everyNDays = Number(process.env.RUN_EVERY_N_DAYS ?? 2);

// ── 1日おき判定 ────────────────────────────────────────────
// cron の */2 は月をまたぐと連続実行になるため、毎日起動して
// ここで通算日数の剰余を見る。
const epochDay = Math.floor(Date.now() / 86_400_000);
if (!force && everyNDays > 1 && epochDay % everyNDays !== 0) {
  console.log(`今日は収集対象外の日です（epochDay=${epochDay}）。何もせず終了します。`);
  await writeFile(LAST_RUN_PATH, JSON.stringify({ skipped: true, newCount: 0 }, null, 2));
  process.exit(0);
}

const rss = new Parser({
  headers: { 'User-Agent': UA },
  timeout: 20000,
  // Google ニュースの item には媒体を示す <source url="..."> が付く。
  // 元記事のURLは分からないが、どのサイトの記事かはこれで分かる。
  customFields: { item: [['source', 'source', { keepArray: true }]] },
});

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
};

const mapRssItem = (it, src) => ({
  url: it.link,
  title: it.title,
  summary: (it.contentSnippet ?? it.content ?? '').replace(/<[^>]+>/g, ''),
  publishedAt: it.isoDate ?? null,
  publisherHost: hostOf(it.source?.[0]?.$?.url),
  sourceId: src.id,
  sourceName: src.name,
  category: src.category,
});

async function fetchRss(src) {
  const feed = await rss.parseURL(src.url);
  return (feed.items ?? []).map((it) => mapRssItem(it, src));
}

// ── Google ニュース検索 ───────────────────────────────────
// 1回のリクエストでは取りこぼす（sources.mjs のコメント参照）ので、
// 対象期間を NEWS_SLICE_DAYS ずつに割って何回かに分けて取る。
// さらに、ある区間が上限に張り付いたらその区間には確実に取りこぼしがあるので、
// そこだけ半分に割って取り直す。際限なく叩かないよう深さで打ち切る。
const NEWS_CAP = 100;         // これ以上は返らない＝取りこぼしの合図
const NEWS_MAX_DEPTH = 3;     // 15日 → 最小 1.875 日まで割る
const NEWS_MAX_REQUESTS = 24; // 1ソースあたりの上限。相手にも自分にも負担をかけすぎない

// Google は検索語をゆるく解釈するため、期間を割って件数を増やすと無関係な記事も
// 一緒に増える（実測でパズドラ・名探偵コナン・大昆虫展・ものまねライブなど、
// 293 件中 44 件）。しかも日程未定・関東だと一覧の上のほうに出てしまう。
// 検索結果に限り、ウルトラマン関連と分かる語が見出しにも概要にも無いものは捨てる。
// 公式サイト由来の記事にはこの判定を掛けない（「S.H.Figuarts …」のように
// 語が出ない見出しがあり、公式である時点で関連は保証されているため）。
const NEWS_RELEVANT = /ウルトラ|円谷|ツブラヤ|シュワッチ|ULTRA|TSUBURAYA|M-?78/i;

const looksRelevant = (raw) =>
  NEWS_RELEVANT.test(`${raw.title ?? ''} ${raw.summary ?? ''}`.normalize('NFKC'));

const DAY_MS = 86_400_000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

async function fetchNews(src) {
  const out = [];
  let requests = 0;
  let split = 0;
  let dropped = 0;

  // before: は指定日を含まない挙動なので、終端は 1 日先を渡す。
  // そうしないと当日の記事が丸ごと落ちる。隣の区間と 1 日重なるが、
  // 重複は既存の判定で潰れるので実害はない。
  const take = async (from, to, depth) => {
    if (requests >= NEWS_MAX_REQUESTS) return;
    const feed = await rss.parseURL(newsSliceUrl(src.query, ymd(from), ymd(to + DAY_MS)));
    requests += 1;
    await sleep(POLITE_DELAY_MS);

    const items = feed.items ?? [];
    for (const raw of items.map((it) => mapRssItem(it, src))) {
      if (looksRelevant(raw)) out.push(raw);
      else dropped += 1;
    }

    // 上限に張り付いた区間は確実に取りこぼしがあるので、そこだけ割って取り直す
    if (items.length >= NEWS_CAP && depth < NEWS_MAX_DEPTH) {
      split += 1;
      const mid = Math.round((from + to) / 2);
      await take(from, mid, depth + 1);
      await take(mid, to, depth + 1);
    }
  };

  const now = Date.now();
  const sliceMs = NEWS_SLICE_DAYS * DAY_MS;
  for (let from = now - NEWS_WINDOW_DAYS * DAY_MS; from < now; from += sliceMs) {
    await take(from, Math.min(from + sliceMs, now), 0);
  }

  console.log(
    `  ${src.name}: 直近${NEWS_WINDOW_DAYS}日を ${requests} 回に分けて取得` +
      (split ? ` / 上限に当たって再分割 ${split} 区間` : '') +
      (dropped ? ` / 無関係として除外 ${dropped} 件` : ''),
  );
  return out;
}

async function fetchHtml(src) {
  const res = await fetch(src.url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const out = [];
  $(src.list).each((_, el) => {
    const $el = $(el);
    const title = (src.title === 'self' ? $el.text() : $el.find(src.title).text()).trim();
    const href = src.link === 'self' ? $el.attr('href') : $el.find(src.link).attr('href');
    if (!title || !href) return;
    out.push({
      url: new URL(href, src.url).toString(),
      title,
      summary: '',
      publishedAt: null,
      sourceId: src.id,
      sourceName: src.name,
      category: src.category,
    });
  });
  return out;
}

// ── 円谷イマジネーション ──────────────────────────────────
// Next.js の App Router 製で、一覧は DOM に出てこない。ただしサーバー側で
// 描画したデータが self.__next_f.push([1,"…"]) の中に JSON のまま入っている。
// 断片を全部つないでから、記事一覧の配列だけを切り出す。
const IMAGINATION_ORIGIN = 'https://imagination.m-78.jp';
// 一覧には動画カテゴリなど別の "list" も混ざるので、記事側だけを狙う目印。
const IMAGINATION_LIST = '"list":[{"is_series"';

// 対応する括弧まで数えて配列を切り出す。文字列の中の括弧は数えない。
function sliceJsonArray(text, marker) {
  const at = text.indexOf(marker);
  if (at === -1) return null;
  const start = text.indexOf('[', at);
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '[') depth += 1;
    else if (c === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// 「2026/07/17 18:00:00」（日本時間）を ISO 文字列に直す
function jstToIso(value) {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value ?? '');
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h - 9, mi, s)).toISOString();
}

async function fetchImagination(src) {
  const res = await fetch(src.url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  let payload = '';
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try {
      payload += JSON.parse(m[1]);
    } catch {
      // 壊れた断片は捨てて続ける
    }
  }

  const raw = sliceJsonArray(payload, IMAGINATION_LIST);
  if (!raw) throw new Error('記事一覧が見つからない（ページの作りが変わった可能性）');

  return JSON.parse(raw)
    .filter((it) => it?.code && it?.name)
    .map((it) => ({
      url: `${IMAGINATION_ORIGIN}/contents/${it.code}`,
      title: it.name,
      summary: '',
      publishedAt: jstToIso(it.display_start_datetime),
      publisherHost: null,
      sourceId: src.id,
      sourceName: src.name,
      category: src.category,
    }));
}

async function fetchRakuten() {
  if (!RAKUTEN.enabled) return [];
  const endpoint = new URL('https://app.rakuten.co.jp/services/api/IchibaItem/Search/20220601');
  endpoint.searchParams.set('applicationId', RAKUTEN.appId);
  endpoint.searchParams.set('keyword', RAKUTEN.keyword);
  endpoint.searchParams.set('sort', '+itemPrice');
  endpoint.searchParams.set('hits', '30');
  const res = await fetch(endpoint, { headers: { 'User-Agent': UA } });
  if (!res.ok) return [];
  const json = await res.json();
  return (json.Items ?? [])
    .map((w) => w.Item)
    .filter((i) => RAKUTEN.maxPrice == null || i.itemPrice <= RAKUTEN.maxPrice)
    .map((i) => ({
      url: i.itemUrl,
      title: `${i.itemName}（${i.itemPrice.toLocaleString()}円）`,
      summary: i.shopName,
      publishedAt: null,
      sourceId: 'rakuten',
      sourceName: '楽天市場',
      category: 'sale',
    }));
}

async function collectAll() {
  const raw = [];
  for (const src of SOURCES) {
    try {
      const fetcher =
        { rss: fetchRss, news: fetchNews, imagination: fetchImagination }[src.kind] ?? fetchHtml;
      const got = await fetcher(src);
      console.log(`✓ ${src.name}: ${got.length} 件`);
      raw.push(...got);
    } catch (err) {
      // 1 つのソースが落ちても全体は止めない
      console.warn(`✗ ${src.name}: ${err.message}`);
    }
    await sleep(POLITE_DELAY_MS);
  }
  try {
    const rakuten = await fetchRakuten();
    if (rakuten.length) console.log(`✓ 楽天市場: ${rakuten.length} 件`);
    raw.push(...rakuten);
  } catch (err) {
    console.warn(`✗ 楽天市場: ${err.message}`);
  }
  return raw;
}

// ── アーカイブの取得 ──────────────────────────────────────
// PWA で「アーカイブ」した記事は、保持上限を超えたときに真っ先に落とす。
// どれがアーカイブされたかは Supabase の archived_ids ビューから読む。
// URL と anon キーは docs/app.js と同じ、公開される前提の値。記事IDしか
// 返さない読み取り専用のビューなので秘密の鍵は要らない（DECISIONS.md 参照）。
const SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://ijtywsqdudtqfkliwigo.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ?? 'sb_publishable_IXW1ziW7LmN46R8YZznXmw_bY_4Jd6O';

const supabaseGet = async (view, select) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${view}?select=${select}`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

async function fetchArchivedIds() {
  try {
    return new Set((await supabaseGet('archived_ids', 'id')).map((r) => r.id));
  } catch (err) {
    // 読めなくても収集は止めない。落とす順番がこれまで通りになるだけ。
    console.warn(`✗ アーカイブの取得: ${err.message}`);
    return new Set();
  }
}

// PWA で利用者が入れ直した開催日。自動の読み取りより常に優先する。
// 反映しないと、次の収集で自動の値に戻り、手直しが無かったことになる。
async function fetchDateEdits() {
  try {
    const rows = await supabaseGet('edited_event_dates', 'id,event_date,event_end_date');
    return new Map(rows.map((r) => [r.id, { start: r.event_date, end: r.event_end_date }]));
  } catch (err) {
    console.warn(`✗ 手直しした開催日の取得: ${err.message}`);
    return new Map();
  }
}

const readJson = async (p, fallback) => {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return fallback;
  }
};

// タイトル・概要に開催日が無い項目を、記事本文を見に行って補完する。
// 円谷ステーションのイベントページ（m-78.jp/event/）は「開催期間」という
// ラベルの直後に日付が入る一定の型なので、そこだけを対象にする。
// 他サイトは構造がバラバラで確度が低いため対象外（BACKLOG.md 参照）。
const DATE_ENRICH_SOURCE_IDS = ['tsuburaya-event'];

// ニュース検索で拾った記事は元URLに到達できない（DECISIONS.md）。
// ただし媒体が円谷ステーション自身なら、公式サイトの検索APIでタイトルから
// 同じ記事を引き当てられる。robots.txt が許可している公開APIで、鍵も要らない。
const OFFICIAL_HOST = 'm-78.jp';
// イベントページだけを対象にする。開催期間が載っているのはここだけで、
// ニュース記事のほうを引き当てても日付は取れなかった（実地確認・2026-08-03）。
const OFFICIAL_EVENT_API = 'https://m-78.jp/wp-json/wp/v2/event';
// 同じシリーズの別公演（「福岡公演」と「神奈川公演」など）が 0.75 前後で
// 並ぶため、取り違えないよう高めに置く。
const TITLE_MATCH_THRESHOLD = 0.9;

// Google ニュースのタイトルは「記事名 – サイトの飾り – 媒体名」のように
// 区切りで飾りが付く。先頭の記事名だけにしないと検索が当たらない。
// 区切りは前後に空白があるものだけ見る（「60周年展-ひらかたパーク」を割らないため）。
const stripDecoration = (title) => title.split(/\s+[-–—|｜]\s+/)[0].trim();

// WordPress の検索APIはタイトルを文字参照のまま返す。
const decodeEntities = (s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

// タイトルから公式サイトのイベントページを探す。見つからなければ null。
// 毎年開催されるイベントは同名のページが何本も残っているため、
// 同点なら新しいほうを採る（API の既定が新着順なので先勝ちでよい）。
async function searchOfficialEvent(title) {
  const endpoint = new URL(OFFICIAL_EVENT_API);
  endpoint.searchParams.set('search', title);
  endpoint.searchParams.set('per_page', '5');
  const res = await fetch(endpoint, { headers: { 'User-Agent': UA } });
  if (!res.ok) return null;

  const want = titleKey(title);
  let best = null;
  for (const hit of await res.json()) {
    const score = similarity(want, titleKey(decodeEntities(hit.title?.rendered ?? '')));
    if (score < TITLE_MATCH_THRESHOLD) continue;
    if (!best || score > best.score) best = { score, url: hit.link };
  }
  return best?.url ?? null;
}

// 記事本文の「開催期間」ラベルの直後から日付を読む。
// 次のラベルや注記まで読み進めると関係のない日付を拾う。
// 例: 「開催期間 4月18日〜6月28日 ※… 開催時間※4月18日、19日は日時指定」の
// 後半まで含めると、終了日が翌年4月18日と読まれてしまう。
const PERIOD_LABEL = '開催期間';
const PERIOD_END = /※|開催時間|開催場所|会場|料金|入場|住所|アクセス|主催|チケット/;

async function readEventPeriod(url, publishedAt) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return null;
  const $ = cheerio.load(await res.text());
  const text = $('body').text().replace(/\s+/g, ' ');
  const idx = text.indexOf(PERIOD_LABEL);
  if (idx === -1) return null;

  const after = text.slice(idx + PERIOD_LABEL.length, idx + PERIOD_LABEL.length + 160);
  const cut = after.search(PERIOD_END);
  const { start, end } = detectEventPeriod(cut === -1 ? after : after.slice(0, cut), publishedAt);
  return start ? { start, end } : null;
}

async function enrichMissingDates(items) {
  const searched = new Map(); // 同じ記事を二度探しに行かないための控え
  const filled = { feed: 0, search: 0 };

  for (const item of items) {
    // 利用者が「日程未定」に戻した項目を、本文から埋め直さない
    if (item.eventDate || item.dateEdited) continue;

    let url = null;
    let via = 'feed';
    try {
      if (DATE_ENRICH_SOURCE_IDS.includes(item.sourceId)) {
        url = item.url;
      } else if (item.publisherHost === OFFICIAL_HOST) {
        via = 'search';
        const key = titleKey(item.title);
        if (!searched.has(key)) {
          searched.set(key, await searchOfficialEvent(stripDecoration(item.title)));
          await sleep(POLITE_DELAY_MS);
        }
        url = searched.get(key);
      }
      if (!url) continue;

      const period = await readEventPeriod(url, item.publishedAt);
      await sleep(POLITE_DELAY_MS);
      if (!period) continue;

      item.eventDate = period.start;
      item.eventEndDate = period.end;
      // eventDate を含む altKey を作り直す（重複判定の精度を保つため）
      item.altKey = sha1(`${titleKey(item.title)}|${period.start}`);
      filled[via] += 1;
    } catch {
      // 取れなくても致命的ではないので無視して続行する
    }
  }

  console.log(`開催日の補完: 収集元のページから ${filled.feed} 件 / 公式検索で辿って ${filled.search} 件`);
}

// ── 実行 ──────────────────────────────────────────────────
const raw = await collectAll();

// 利用者が PWA で入れ直した開催日は、自動の読み取りより常に優先する。
// altKey は作り直さない。日付を直しただけで別の記事として扱われ、
// 新着として出直してしまうため。
const dateEdits = await fetchDateEdits();
const applyDateEdit = (item) => {
  const edit = dateEdits.get(item.id);
  if (!edit) return item;
  return { ...item, eventDate: edit.start, eventEndDate: edit.end, dateEdited: true };
};

const normalized = raw.map(normalizeItem).filter(Boolean).map(applyDateEdit);

// 終わったイベント・古すぎる記事は要らない。
// 本文を見に行く前に落としておくと、無駄な取得も減らせる。
const candidates = normalized.filter((i) => !isStale(i));
await enrichMissingDates(candidates);
// 本文から開催日が分かった結果、終了済みと判明したものをもう一度落とす
const fresh = candidates.filter((i) => !isStale(i));
console.log(`\n収集 ${normalized.length} 件 → 対象 ${fresh.length} 件（終了済み・古い記事を除外）`);

const seen = await readJson(SEEN_PATH, { ids: {}, altKeys: {}, titles: [] });
seen.titles ??= [];
const store = await readJson(ITEMS_PATH, { items: [] });

const now = new Date().toISOString();
// 日付だけだと同じ日に2回収集した場合に前回分と合算されてしまうため、
// 実行ごとに一意になるタイムスタンプそのものをバッチIDにする。
const batchId = now;
const newItems = [];
const withinRun = new Set();

// 表記ゆれが大きい場合の保険。直近の既報タイトルと似すぎていれば同一とみなす。
const SIMILARITY_THRESHOLD = 0.75;
const runTitles = [];

const looksDuplicate = (item) => {
  const pool = [...seen.titles, ...runTitles];
  return pool.some((prev) => {
    // 開催日が両方わかっていて食い違うなら別イベント
    if (prev.date && item.eventDate && prev.date !== item.eventDate) return false;
    return similarity(prev.key, item.titleKey) >= SIMILARITY_THRESHOLD;
  });
};

for (const item of fresh) {
  if (withinRun.has(item.id) || withinRun.has(item.altKey)) continue;
  if (seen.ids[item.id] || seen.altKeys[item.altKey]) continue;
  if (looksDuplicate(item)) continue;

  withinRun.add(item.id);
  withinRun.add(item.altKey);
  seen.ids[item.id] = now;
  seen.altKeys[item.altKey] = now;
  runTitles.push({ key: item.titleKey, date: item.eventDate });
  newItems.push({ ...item, firstSeen: now, batch: batchId });
}

// 類似判定の対象は直近 500 件までに抑える（際限なく増やさない）
seen.titles = [...runTitles, ...seen.titles].slice(0, 500);

// 既に溜まっている分の扱い。既報の項目は newItems に入らないので、
// 何もしないと取り込んだ当時の解釈のまま固定されてしまう。
// 突き合わせには終了済みを落とす前の candidates を使う。fresh だと
// 「本文を読んで終了済みと分かった」項目が抜け落ち、保存済みの古い日付を
// 直せないまま残ってしまう。
const freshById = new Map(candidates.map((i) => [i.id, i]));
// ニュース検索の中継URLは張り直されることがあり、同じ記事でも id が変わる。
// 日付が取れたものはタイトルからも引けるようにして、取りこぼしを防ぐ。
const freshByTitle = new Map(candidates.filter((i) => i.eventDate).map((i) => [i.titleKey, i]));

// 保存済みの項目も、いまのルールで日付を取り直す。
// これで日付の読み取りを直したとき、過去に取り込んだ分にも遡って効く。
// 見出しから日付が読めない項目（本文から補ったものなど）は触らない。
const reinterpret = (item) => {
  const { start, end } = detectEventPeriod(`${item.title} ${item.summary ?? ''}`, item.publishedAt);
  return start ? { ...item, eventDate: start, eventEndDate: end } : item;
};

const carried = store.items
  // 関連性の判定も保存済みの分に遡って効かせる。そうしないと、判定を入れる前に
  // 取り込んだ無関係な記事が保持期間いっぱい居座ってしまう。
  .filter((item) => !item.sourceId?.startsWith('news-') || looksRelevant(item))
  .map(reinterpret)
  // 本文から補った日付は見出しから読み直せないので、今回の収集で取れた値を
  // そのまま採る。読み取りを直したとき、補完済みの分にも遡って効くようにする。
  .map((item) => {
    const found = freshById.get(item.id) ?? freshByTitle.get(item.titleKey);
    if (!found?.eventDate) return item;
    return { ...item, eventDate: found.eventDate, eventEndDate: found.eventEndDate ?? null };
  })
  // 手直しは最後に当てる。自動の読み取りにも補完にも上書きされないようにする
  .map(applyDateEdit)
  // 日が過ぎたものはここで落ちていく（上で日付が変わったものも含めて判定する）
  .filter((i) => !isStale(i));

// 保持上限を超えた分は、アーカイブしたものから先に落とす。
// 「もう見た・興味がない」と本人が判断したものなので、残す価値が一番低い。
// どちらの組の中でも落とす順番はこれまでと同じで、並び順の末尾からになる。
// 最後にもう一度全体の並び順に戻すのは、アーカイブを解除したときに
// その記事が本来の位置へ戻るようにするため。
const ordered = sortForDisplay([...newItems, ...carried]);
const archivedIds = await fetchArchivedIds();
const shelved = ordered.filter((i) => archivedIds.has(i.id));
const rest = ordered.filter((i) => !archivedIds.has(i.id));
const room = Math.max(KEEP_ITEMS - rest.length, 0);
const kept = new Set([...rest.slice(0, KEEP_ITEMS), ...shelved.slice(0, room)].map((i) => i.id));
const merged = ordered.filter((i) => kept.has(i.id));

if (ordered.length > KEEP_ITEMS) {
  console.log(
    `保持上限で ${ordered.length - merged.length} 件を除外` +
      `（うちアーカイブ済み ${shelved.length - Math.min(shelved.length, room)} 件）`,
  );
}

await mkdir(path.dirname(ITEMS_PATH), { recursive: true });
await writeFile(
  ITEMS_PATH,
  JSON.stringify({ generatedAt: now, batchId, newCount: newItems.length, items: merged }, null, 2),
);
await writeFile(SEEN_PATH, JSON.stringify(seen, null, 2));

// 利用者が「どこから集めているか」を確認できるように、収集元一覧も書き出す。
// sources.mjs が唯一の情報源なので、ここでは名前とURLを写すだけにする。
const sourceList = SOURCES.map((s) => ({ name: s.name, category: s.category, url: s.url }));
if (RAKUTEN.enabled) {
  sourceList.push({ name: '楽天市場', category: 'sale', url: 'https://www.rakuten.co.jp/' });
}
await writeFile(SOURCES_PATH, JSON.stringify({ generatedAt: now, sources: sourceList }, null, 2));
await writeFile(
  LAST_RUN_PATH,
  JSON.stringify(
    {
      skipped: false,
      generatedAt: now,
      batchId,
      newCount: newItems.length,
      // 通知の本文に使う先頭 3 件
      highlights: sortForDisplay(newItems).slice(0, 3).map((i) => i.title),
    },
    null,
    2,
  ),
);

console.log(`\n新着 ${newItems.length} 件 / 保持 ${merged.length} 件`);
