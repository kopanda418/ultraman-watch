import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import Parser from 'rss-parser';
import { SOURCES, RAKUTEN } from './sources.mjs';
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

const KEEP_ITEMS = 300;          // items.json に残す最大件数
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

const rss = new Parser({ headers: { 'User-Agent': UA }, timeout: 20000 });

async function fetchRss(src) {
  const feed = await rss.parseURL(src.url);
  return (feed.items ?? []).map((it) => ({
    url: it.link,
    title: it.title,
    summary: (it.contentSnippet ?? it.content ?? '').replace(/<[^>]+>/g, ''),
    publishedAt: it.isoDate ?? null,
    sourceId: src.id,
    sourceName: src.name,
    category: src.category,
  }));
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
      const got = src.kind === 'rss' ? await fetchRss(src) : await fetchHtml(src);
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

async function enrichMissingDates(items) {
  const targets = items.filter((i) => !i.eventDate && DATE_ENRICH_SOURCE_IDS.includes(i.sourceId));
  for (const item of targets) {
    try {
      const res = await fetch(item.url, { headers: { 'User-Agent': UA } });
      if (res.ok) {
        const $ = cheerio.load(await res.text());
        const text = $('body').text().replace(/\s+/g, ' ');
        const idx = text.indexOf('開催期間');
        if (idx !== -1) {
          const { start, end } = detectEventPeriod(text.slice(idx, idx + 60));
          if (start) {
            item.eventDate = start;
            item.eventEndDate = end;
            // eventDate を含む altKey を作り直す（重複判定の精度を保つため）
            item.altKey = sha1(`${titleKey(item.title)}|${start}`);
          }
        }
      }
    } catch {
      // 取れなくても致命的ではないので無視して続行する
    }
    await sleep(POLITE_DELAY_MS);
  }
}

// ── 実行 ──────────────────────────────────────────────────
const raw = await collectAll();
const normalized = raw.map(normalizeItem).filter(Boolean);

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

// 既に溜まっている分の扱い。
// 既報の項目は newItems に入らないため、あとから開催日が分かっても
// 放っておくと「日程未確定」のまま残ってしまう。今回の収集で日付が
// 取れていれば、ここで既存分にも反映する。
const freshById = new Map(fresh.map((i) => [i.id, i]));
const carried = store.items
  .map((item) => {
    const found = freshById.get(item.id);
    if (!found?.eventDate || item.eventDate) return item;
    return { ...item, eventDate: found.eventDate, eventEndDate: found.eventEndDate ?? null };
  })
  // 日が過ぎたものはここで落ちていく（上で日付が判明したものも含めて判定する）
  .filter((i) => !isStale(i));

const merged = sortForDisplay([...newItems, ...carried]).slice(0, KEEP_ITEMS);

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
