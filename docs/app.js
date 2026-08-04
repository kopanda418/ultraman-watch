import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── 設定 ────────────────────────────────────────────────
// anon キーは公開される前提のキーです。行レベルセキュリティ側で守ります。
const SUPABASE_URL = 'https://ijtywsqdudtqfkliwigo.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_IXW1ziW7LmN46R8YZznXmw_bY_4Jd6O';
// `npx web-push generate-vapid-keys` で出た公開鍵。
const VAPID_PUBLIC_KEY = 'BAt9oygC3Y1-rXA0ieOxmXUHrAhfiu58r5-QHhC0Mm90QD4CjGs0_Ovy6oom2UixyspU4PLVT4jnhhUSVTPXDro';

const supabase =
  SUPABASE_URL && SUPABASE_ANON_KEY ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

const $ = (sel) => document.querySelector(sel);

// ── ピック・アーカイブの保存 ────────────────────────────
// 正は Supabase。IndexedDB は圏外でも見られるようにするための控えです。
// 2つは「誰がいつ」の列名が違うだけで中身は同じなので、置き場所として同じに扱う。
const SHELVES = {
  picks: { table: 'picks', by: 'picked_by', at: 'picked_at' },
  archives: { table: 'archives', by: 'archived_by', at: 'archived_at' },
};

const DB_NAME = 'ultraman-watch';
// archives を足したときに 1 から上げた。以後ストアを増やすたびに上げること。
const DB_VERSION = 2;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      for (const name of Object.keys(SHELVES)) {
        if (!req.result.objectStoreNames.contains(name)) {
          req.result.createObjectStore(name, { keyPath: 'id' });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

const cacheAll = async (store, rows) => {
  await tx(store, 'readwrite', (s) => s.clear());
  await tx(store, 'readwrite', (s) => rows.forEach((r) => s.put(r)));
};
const cached = (store) => tx(store, 'readonly', (s) => s.getAll());

const toRow = (shelf, item, by) => ({
  id: item.id,
  url: item.url,
  title: item.title,
  summary: item.summary ?? null,
  source_name: item.sourceName ?? null,
  event_date: item.eventDate ?? null,
  prefectures: item.prefectures ?? [],
  is_kanto: Boolean(item.isKanto),
  [shelf.by]: by,
});

const fromRow = (shelf, row) => ({
  id: row.id,
  url: row.url,
  title: row.title,
  summary: row.summary ?? '',
  sourceName: row.source_name ?? '',
  eventDate: row.event_date ?? null,
  prefectures: row.prefectures ?? [],
  isKanto: row.is_kanto,
  savedBy: row[shelf.by] ?? '',
  savedAt: row[shelf.at] ?? '',
});

// ── 絞り込み ────────────────────────────────────────────
// タグを増やしたいときは TAGS に1行足すだけでよい。
// match が真になるものだけが残る。id は保存用の識別子なので変えないこと。
const TAGS = [
  // 「新着」はタブではなく絞り込みで見る。直近の収集で見つかった項目のこと。
  { id: 'new', label: '新着', match: (i) => i.batch === store.batchId },
  { id: 'kanto', label: '関東', match: (i) => i.isKanto },
  { id: 'other', label: '関東以外', match: (i) => !i.isKanto },
  { id: 'official', label: '公式', match: (i) => i.category === 'official' },
  { id: 'sale', label: 'グッズ・セール', match: (i) => i.category === 'sale' },
];

const pad2 = (n) => String(n).padStart(2, '0');
// 端末のローカル日付。toISOString() は UTC になり日本時間とずれるので使わない。
const localDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const daysFromNow = (n) => localDate(new Date(Date.now() + n * 86_400_000));

const DATE_FILTERS = [
  { id: 'all', label: 'すべての日程', match: () => true },
  { id: 'soon', label: '3か月以内', match: (i) => i.eventDate && i.eventDate <= daysFromNow(90) },
  { id: 'dated', label: '日程が分かるもの', match: (i) => Boolean(i.eventDate) },
];

// ── 開催日の手直し ──────────────────────────────────────
// 自動の読み取りが違っていたとき、利用者が入れ直した日付。2人で共有する。
// 表示のたびに自動の値へ上書きするので、手直しが常に勝つ。
let dateEdits = new Map(); // id → { eventDate, eventEndDate }

async function fetchDateEdits() {
  if (!supabase || !session) return;
  const { data, error } = await supabase.from('event_dates').select('*');
  if (error) {
    console.warn(error.message);
    return; // 読めなければ自動の値のまま出す
  }
  dateEdits = new Map(
    data.map((r) => [r.id, { eventDate: r.event_date, eventEndDate: r.event_end_date }]),
  );
}

async function saveDateEdit(id, eventDate, eventEndDate) {
  const { error } = await supabase.from('event_dates').upsert({
    id,
    event_date: eventDate,
    event_end_date: eventEndDate,
    edited_by: displayName(),
    edited_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

const withEdit = (item) => {
  const edit = dateEdits.get(item.id);
  return edit ? { ...item, ...edit, dateEdited: true } : item;
};

// 並び順は収集側の sortForDisplay（normalize.mjs）と同じ規則。
// 手直しした日付で並びが変わるので、こちらでも並べ直す必要がある。
// 片方だけ直すと順番が食い違うため、変えるときは両方そろえること。
const sortForDisplay = (items) =>
  [...items].sort((a, b) => {
    if (a.isKanto !== b.isKanto) return a.isKanto ? -1 : 1;
    if (a.eventDate && b.eventDate) return b.eventDate.localeCompare(a.eventDate);
    if (a.eventDate) return -1;
    if (b.eventDate) return 1;
    return (b.firstSeen ?? '').localeCompare(a.firstSeen ?? '');
  });

// ── 元記事の開き方 ──────────────────────────────────────
// ホーム画面から起動した PWA では、普通のリンクはアプリ内ブラウザで開いてしまう。
// x-safari-https: は Safari 本体を開くための URL スキーム。Apple が公開して
// いる仕組みではなく、効く iOS と効かない iOS がある（iOS 16 では効かないと
// いう報告がある）ため、次の二段構えにしている。
//   1. まずスキームで開こうとする。成功すれば画面が Safari に移る
//   2. 一定時間たっても画面が残っていたら効かなかったとみなし、普通に開き直す
// それでも具合が悪い端末のために、設定から切れるようにしてある。
const SAFARI_KEY = 'open-in-safari';
// Safari が立ち上がるまでの待ち時間。短くすると、立ち上がる前に保険が走って
// アプリ内ブラウザまで開き、戻ったときに同じページが二重に開いた状態になる。
// 実機で確かめられた値なので、詰めないこと（internal/pwa-external-browser.md）。
const SAFARI_FALLBACK_MS = 900;

const opensInSafari = () => localStorage.getItem(SAFARI_KEY) !== 'off';

// iPadOS は UA が Mac を名乗るので、タッチ点数で拾い直す。
const isIosStandalone = () => {
  const ua = navigator.userAgent || '';
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  return ios && standalone;
};

// リンク1本ずつに付けて回らず、document で1回だけ受ける。
// あとから描き足したカードのリンクにも自動で効き、付け忘れが起きない。
function setupExternalLinks() {
  if (!isIosStandalone()) return;

  document.addEventListener('click', (e) => {
    if (!opensInSafari()) return;
    const a = e.target.closest('a');
    // ファイルの保存は Safari に渡すと壊れるので触らない
    if (!a || a.hasAttribute('download')) return;
    const href = a.getAttribute('href') ?? '';
    // tel: や blob:、アプリ内の相対リンクはそのまま通す
    if (!/^https?:\/\//i.test(href)) return;

    e.preventDefault();
    window.location.href = `x-safari-${href}`;
    // Safari が立ち上がればこのアプリは背面に回る。前面のままならスキームが
    // 効いていないので、通常の別タブで開き直す。
    setTimeout(() => {
      if (document.visibilityState === 'visible') window.open(href, '_blank', 'noopener');
    }, SAFARI_FALLBACK_MS);
  });
}

// ── 未読・既読 ──────────────────────────────────────────
// 元記事へ一度でも飛べば既読。既定は未読。
// これは端末ごとの状態で、2人の間では共有しない。相手が読んだかどうかは
// こちらが読むかどうかの判断に関係しないため（ピックやアーカイブとは違う）。
const READ_KEY = 'read-ids';
const READ_KEEP = 2000; // 際限なく溜めない。古いものから捨てる
let readIds = new Set();

function loadRead() {
  try {
    readIds = new Set(JSON.parse(localStorage.getItem(READ_KEY) ?? '[]'));
  } catch {
    readIds = new Set(); // 壊れていたら未読からやり直す
  }
}

// Set は入れた順に並ぶので、末尾から数えれば新しいものが残る
const saveRead = () => localStorage.setItem(READ_KEY, JSON.stringify([...readIds].slice(-READ_KEEP)));

const READ_FILTERS = [
  { id: 'all', label: 'すべて', match: () => true },
  { id: 'unread', label: '未読', match: (i) => !readIds.has(i.id) },
  { id: 'read', label: '既読', match: (i) => readIds.has(i.id) },
];

// ── 状態 ────────────────────────────────────────────────
let store = { items: [], batchId: null, generatedAt: null };
let pickIds = new Set();
let archiveIds = new Set();
let view = 'all';
let session = null;
let activeTag = null; // null は「すべて」
let activeDate = 'all';
let activeRead = 'all';

const displayName = () => localStorage.getItem('display-name') || session?.user?.email || '不明';

// 置き場所（picks / archives）ごとに同じ形の読み書きをする。
async function fetchShelf(name) {
  const shelf = SHELVES[name];
  if (!supabase || !session) return { rows: await cached(name), offline: true };
  const { data, error } = await supabase
    .from(shelf.table)
    .select('*')
    .order(shelf.at, { ascending: false });
  if (error) {
    console.warn(error.message);
    return { rows: await cached(name), offline: true };
  }
  const rows = data.map((row) => fromRow(shelf, row));
  await cacheAll(name, rows);
  return { rows, offline: false };
}

async function addTo(name, item) {
  const shelf = SHELVES[name];
  const { error } = await supabase.from(shelf.table).upsert(toRow(shelf, item, displayName()));
  if (error) throw new Error(error.message);
}

async function removeFrom(name, id) {
  const { error } = await supabase.from(SHELVES[name].table).delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// ── 描画 ────────────────────────────────────────────────
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const isFiltered = () => activeTag !== null || activeDate !== 'all' || activeRead !== 'all';

// カードの操作ボタンの絵。文字だけだと3つが1行に収まらず2段になっていた。
// currentColor で描くので、色は CSS 側の状態（押した／押していない）に従う。
const svg = (d) =>
  `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">${d}</svg>`;

const ICON = {
  // 旗（ピック）
  pick: svg('<path d="M4 1.5v13M4 2.5h8l-2 2.5 2 2.5H4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>'),
  // 箱に入れる（アーカイブ）
  archive: svg('<path d="M1.8 4.5h12.4v9H1.8zM1 2h14v2.5H1zM6.3 7.5h3.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>'),
  // 箱から戻す
  unarchive: svg('<path d="M1.8 4.5h12.4v9H1.8zM1 2h14v2.5H1zM8 11V7.2M6.2 8.8L8 7l1.8 1.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>'),
  // 外へ開く
  open: svg('<path d="M6.5 2.5H2.5v11h11V9.5M9.5 2.5h4v4M13.5 2.5L7 9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>'),
};

// ピック・アーカイブは Supabase 側に category や batch を持たせていないので、
// 手元の一覧から補う。一覧から消えた古いものは補えないが、
// その場合はカテゴリ・新着の絞り込みに出てこないだけ。
const withListData = (item) => {
  const found = store.items.find((s) => s.id === item.id);
  return found ? { ...item, category: found.category, batch: found.batch } : item;
};

// 絞り込みまで済ませた一覧。タブの件数も表示する中身もここから採るので、
// 「見えている件数」と「タブに出る数字」が食い違わない。
function filteredFor(currentView, picks, archives) {
  const base =
    currentView === 'picks'
      ? picks.map(withListData)
      : currentView === 'archive'
        ? archives.map(withListData)
        // 一覧はアーカイブしたものを除く。戻せばまたここに現れる。
        : store.items.filter((i) => !archiveIds.has(i.id));

  const conditions = [
    TAGS.find((t) => t.id === activeTag),
    DATE_FILTERS.find((d) => d.id === activeDate),
    READ_FILTERS.find((r) => r.id === activeRead),
  ].filter(Boolean);
  // 手直しした日付を当ててから絞り込む
  return base.map(withEdit).filter((i) => conditions.every((c) => c.match(i)));
}

// 並びは手直しした日付で変わるので、表示の直前に並べ直す
const itemsFor = (currentView, picks, archives) =>
  sortForDisplay(filteredFor(currentView, picks, archives));

// 絞り込みのチップを描く。TAGS / DATE_FILTERS を増やせばそのまま増える。
function renderChips() {
  const build = (container, options, active, onPick, allLabel) => {
    container.textContent = '';
    const entries = allLabel ? [{ id: null, label: allLabel }, ...options] : options;
    for (const opt of entries) {
      const btn = document.createElement('button');
      btn.className = 'chip';
      btn.type = 'button';
      btn.textContent = opt.label;
      btn.setAttribute('aria-pressed', String(opt.id === active));
      btn.addEventListener('click', () => {
        onPick(opt.id);
        renderChips();
        render();
      });
      container.append(btn);
    }
  };

  build($('#tag-filters'), TAGS, activeTag, (id) => { activeTag = id; }, 'すべて');
  build($('#date-filters'), DATE_FILTERS, activeDate, (id) => { activeDate = id; });
  build($('#read-filters'), READ_FILTERS, activeRead, (id) => { activeRead = id; });
  renderFilterToggle();
}

// たたんでいる間も、絞り込みが効いていることが分かるようにする。
// 条件名まで出すとボタンが伸びてタブを押し潰すので、件数だけを添える。
function renderFilterToggle() {
  const count =
    (activeTag === null ? 0 : 1) + (activeDate === 'all' ? 0 : 1) + (activeRead === 'all' ? 0 : 1);

  $('#filter-tally').textContent = count > 0 ? String(count) : '';
  $('#filter-toggle').classList.toggle('is-on', count > 0);
  $('#filter-clear').hidden = count === 0;
}

function setFiltersOpen(open) {
  $('#filters').hidden = !open;
  $('#filter-toggle').setAttribute('aria-expanded', String(open));
}

$('#filter-toggle').addEventListener('click', () => {
  setFiltersOpen($('#filters').hidden);
});

$('#filter-clear').addEventListener('click', () => {
  activeTag = null;
  activeDate = 'all';
  activeRead = 'all';
  setFiltersOpen(false);
  renderChips();
  render();
});

function card(item) {
  const el = document.createElement('article');
  el.className = 'card';

  const picked = pickIds.has(item.id);
  const archived = archiveIds.has(item.id);
  const where = item.prefectures?.length ? item.prefectures.join('・') : '地域不明';
  const when = item.eventDate
    ? `${item.eventDate}${item.eventEndDate ? `〜${item.eventEndDate}` : ''} 開催`
    : '日程未確定';
  const isNew = item.batch != null && item.batch === store.batchId;

  const archiveLabel = archived ? '一覧に戻す' : 'アーカイブ';

  el.innerHTML = `
    <div class="card-swipe" aria-hidden="true">← ${archiveLabel}</div>
    <div class="card-face">
      <h3><a href="${item.url}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a></h3>
      ${item.summary ? `<p>${escapeHtml(item.summary)}</p>` : ''}
      <!-- タグは本文の情報と混ぜない。混ぜると何が付いているのか一目で読めない。
           並びは常に 未読 → 新着 → 関東 → 手直し → 誰が の順で固定する。 -->
      <div class="tags">
        ${readIds.has(item.id) ? '' : '<span class="badge badge-unread">未読</span>'}
        ${isNew ? '<span class="badge badge-new">新着</span>' : ''}
        ${item.isKanto ? '<span class="badge badge-kanto">関東</span>' : ''}
        ${item.dateEdited ? '<span class="badge badge-edited">日程を手直し</span>' : ''}
        ${item.savedBy ? `<span class="badge">${escapeHtml(item.savedBy)}が${view === 'archive' ? 'アーカイブ' : 'ピック'}</span>` : ''}
      </div>
      <div class="meta">
        <span>${escapeHtml(item.sourceName)}</span>
        <button class="when" type="button"${session ? '' : ' disabled'} aria-label="開催日を直す">${when}</button>
        <span>${escapeHtml(where)}</span>
      </div>
      <div class="card-foot">
        <button class="act pick" aria-pressed="${picked}" aria-label="${picked ? 'ピックを外す' : 'ピックする'}"${session ? '' : ' disabled'}>
          ${ICON.pick}<span>${picked ? 'ピック済み' : 'ピック'}</span>
        </button>
        <button class="act archive" aria-label="${archiveLabel}"${session ? '' : ' disabled'}>
          ${archived ? ICON.unarchive : ICON.archive}<span>${archived ? '戻す' : 'アーカイブ'}</span>
        </button>
        <a class="act" href="${item.url}" target="_blank" rel="noopener" aria-label="元記事を開く">
          ${ICON.open}<span>元記事</span>
        </a>
      </div>
    </div>`;

  // ピックとアーカイブは押したあとの処理が同じなので、まとめて面倒を見る。
  const bind = (sel, name, ids, label) =>
    el.querySelector(sel).addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        if (ids.has(item.id)) await removeFrom(name, item.id);
        else await addTo(name, item);
        await render();
      } catch (err) {
        $('#sync-state').textContent = `${label}を保存できませんでした: ${err.message}`;
        e.target.disabled = false;
      }
    });

  bind('.pick', 'picks', pickIds, 'ピック');
  bind('.archive', 'archives', archiveIds, 'アーカイブ');
  bindSwipe(el);

  el.querySelector('.when').addEventListener('click', () => openDateEditor(item));

  // 元記事へ飛んだら既読にする。タイトルと「元記事を開く」のどちらからでもよい。
  // ここで再描画すると、読みに行った瞬間にカードが消えることがある（未読で
  // 絞り込んでいる場合）ので、バッジだけその場で外す。並びは次の描画で揃う。
  const markRead = () => {
    if (readIds.has(item.id)) return;
    readIds.add(item.id);
    saveRead();
    el.querySelector('.badge-unread')?.remove();
  };

  // Safari で開く処理は document 側でまとめて受けている（setupExternalLinks）。
  // ここは既読にするだけ。リンクの <a> で先に走るので、横取りされても取りこぼさない。
  for (const a of el.querySelectorAll('.card-face a[href]')) {
    a.addEventListener('click', markRead);
    // 長押しから「新規タブで開く」を選んだ場合など、click が来ない経路の保険
    a.addEventListener('auxclick', markRead);
  }

  return el;
}

// ── 左スワイプ ──────────────────────────────────────────
// 左へ一定量引いて指を離すと、アーカイブのボタンを押したのと同じことが起きる
// （アーカイブタブでは一覧に戻る）。少し触れただけで消えると事故になるので、
// 成立には SWIPE_COMMIT 以上引くことを要求する。
const SWIPE_START = 12;   // これを超えるまでは縦か横かを決めない
const SWIPE_COMMIT = 88;  // ここまで引いて離せば成立

function bindSwipe(el) {
  const face = el.querySelector('.card-face');
  const button = el.querySelector('.archive');
  let startX = 0;
  let startY = 0;
  let shift = 0;
  let tracking = false;
  let horizontal = false;

  el.addEventListener('pointerdown', (e) => {
    // ボタンやリンクの上から始まったものは、その操作を邪魔しない
    if (button.disabled || e.target.closest('a, button')) return;
    startX = e.clientX;
    startY = e.clientY;
    shift = 0;
    tracking = true;
    horizontal = false;
    el.classList.remove('is-settling');
  });

  el.addEventListener('pointermove', (e) => {
    if (!tracking) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (!horizontal) {
      if (Math.abs(dx) < SWIPE_START && Math.abs(dy) < SWIPE_START) return;
      // 縦のほうが大きければ、ページを読むためのスクロールとみなして手を引く
      if (Math.abs(dy) >= Math.abs(dx)) {
        tracking = false;
        return;
      }
      horizontal = true;
      // 指がカードの外へ出ても追い続けるための指定。
      // 既に離されているなど、受け付けられない状況では例外になる。
      // 捕まえられなくても追従自体はできるので、握りつぶして続ける。
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* 捕まえられないときはそのまま続ける */
      }
    }

    shift = Math.min(dx, 0); // 右へは動かさない。戻す操作は用意していない
    face.style.transform = `translateX(${shift}px)`;
    el.classList.toggle('is-armed', shift <= -SWIPE_COMMIT);
  });

  const settle = () => {
    if (!tracking) return;
    const commit = shift <= -SWIPE_COMMIT;
    tracking = false;
    horizontal = false;
    el.classList.add('is-settling');
    el.classList.remove('is-armed');
    face.style.transform = '';
    // ボタンを押したことにする。保存も再描画も失敗時の表示もそちらに任せる
    if (commit) button.click();
  };

  el.addEventListener('pointerup', settle);
  el.addEventListener('pointercancel', settle);
}

// ── 開催日を直すカレンダー ──────────────────────────────
// 1回目のタップで開始日、2回目で終了日。3回目はやり直しで開始日に戻る。
// 開始日だけで保存すれば、終了日なし（1日だけの予定）になる。
// 入れやすさを第一にしているので、時刻や曜日の細かい指定は用意しない。
let editing = null; // 編集中の項目
let pickStart = null;
let pickEnd = null;
let calendarMonth = null; // その月の1日

const monthStart = (iso) => {
  const d = iso ? new Date(`${iso}T00:00:00`) : new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
};

function openDateEditor(item) {
  editing = item;
  pickStart = item.eventDate ?? null;
  pickEnd = item.eventEndDate ?? null;
  calendarMonth = monthStart(pickStart);
  $('#date-title').textContent = item.title;
  $('#date-state').textContent = '';
  $('#date-editor').hidden = false;
  renderCalendar();
}

const closeDateEditor = () => {
  $('#date-editor').hidden = true;
  editing = null;
};

function renderCalendar() {
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  $('#date-month').textContent = `${year}年${month + 1}月`;

  const grid = $('#date-grid');
  grid.textContent = '';
  // 週の頭を日曜に合わせるため、1日の曜日ぶんだけ空きを置く
  for (let i = 0; i < new Date(year, month, 1).getDay(); i += 1) {
    grid.append(document.createElement('span'));
  }

  const lastDay = new Date(year, month + 1, 0).getDate();
  for (let day = 1; day <= lastDay; day += 1) {
    const iso = `${year}-${pad2(month + 1)}-${pad2(day)}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'day';
    btn.textContent = String(day);
    if (iso === pickStart || iso === pickEnd) btn.classList.add('is-edge');
    else if (pickStart && pickEnd && iso > pickStart && iso < pickEnd) btn.classList.add('is-between');
    btn.addEventListener('click', () => {
      // 開始日が未定、または既に期間が決まっているなら、そこから引き直す
      if (!pickStart || pickEnd || iso < pickStart) {
        pickStart = iso;
        pickEnd = null;
      } else if (iso === pickStart) {
        pickEnd = null; // 同じ日をもう一度押したら1日だけに戻す
      } else {
        pickEnd = iso;
      }
      renderCalendar();
    });
    grid.append(btn);
  }

  $('#date-chosen').textContent = pickStart
    ? `${pickStart}${pickEnd ? `〜${pickEnd}` : '（1日だけ）'}`
    : '日程未定';
}

$('#date-prev').addEventListener('click', () => {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
  renderCalendar();
});
$('#date-next').addEventListener('click', () => {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
  renderCalendar();
});
$('#date-cancel').addEventListener('click', closeDateEditor);

$('#date-clear').addEventListener('click', () => {
  pickStart = null;
  pickEnd = null;
  renderCalendar();
});

$('#date-save').addEventListener('click', async (e) => {
  if (!editing) return;
  e.target.disabled = true;
  try {
    await saveDateEdit(editing.id, pickStart, pickEnd);
    closeDateEditor();
    await render();
  } catch (err) {
    $('#date-state').textContent = `保存できませんでした: ${err.message}`;
  } finally {
    e.target.disabled = false;
  }
});

const EMPTY = {
  all: 'まだ情報がありません。',
  picks: '気になる記事の「ピックする」を押すと、2人のどちらの端末からも見られます。',
  archive: '「アーカイブ」を押した記事がここに入ります。一覧からは外れます。',
};

async function render() {
  const [pickResult, archiveResult] = await Promise.all([
    fetchShelf('picks'),
    fetchShelf('archives'),
    fetchDateEdits(),
  ]);
  const picks = pickResult.rows;
  const archives = archiveResult.rows;
  pickIds = new Set(picks.map((p) => p.id));
  archiveIds = new Set(archives.map((a) => a.id));

  $('#sync-state').textContent = !session
    ? 'サインインするとピックとアーカイブを共有できます。'
    : pickResult.offline || archiveResult.offline
      ? '同期できていません。手元の控えを表示しています。'
      : `ピック ${picks.length} 件・アーカイブ ${archives.length} 件を共有中`;
  // 「新着」はタブから絞り込みに移したので、注記もその絞り込み中だけ出す
  $('#new-hint').hidden = activeTag !== 'new';
  $('#archive-hint').hidden = view !== 'archive';

  const list = $('#list');
  list.textContent = '';
  const items = itemsFor(view, picks, archives);

  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = isFiltered() ? '絞り込みに合う情報はありませんでした。' : EMPTY[view];
    list.append(empty);
  } else {
    for (const item of items) list.append(card(item));
  }

  // タブの件数は絞り込みを通したあとの数。絞っていないときは全件と一致する。
  // 総数のままだと、開いたタブに出てくる件数と数字が食い違う。
  const tally = (v) => filteredFor(v, picks, archives).length;
  $('#tally-list').textContent = tally('all');
  $('#tally-picks').textContent = tally('picks');
  $('#tally-archive').textContent = tally('archive');
}

// ── サインイン ──────────────────────────────────────────
async function refreshSession() {
  if (!supabase) return;
  const { data } = await supabase.auth.getSession();
  session = data.session;
  // 一覧は未サインインでも見られる（DECISIONS.md）。案内を一覧の手前に出すだけ。
  $('#signin-panel').hidden = Boolean(session);
  $('#signout').hidden = !session;
  $('#account').textContent = session
    ? `${displayName()} としてサインイン中`
    : 'サインインしていません。ピックとアーカイブは共有されません。';
}

// ── 設定画面 ────────────────────────────────────────────
const setSettingsOpen = (open) => {
  $('#settings').hidden = !open;
};
$('#settings-open').addEventListener('click', () => setSettingsOpen(true));
$('#settings-close').addEventListener('click', () => setSettingsOpen(false));

$('#open-in-safari').checked = opensInSafari();
$('#open-in-safari').addEventListener('change', (e) => {
  localStorage.setItem(SAFARI_KEY, e.target.checked ? 'on' : 'off');
});

$('#signin').addEventListener('click', async () => {
  // 表示名を入れた直後にそのままボタンを押しても取りこぼさないよう、ここでも拾う
  const typedName = $('#signin-panel .display-name').value.trim();
  if (typedName) setDisplayName(typedName);

  const { error } = await supabase.auth.signInWithPassword({
    email: $('#email').value.trim(),
    password: $('#password').value,
  });
  if (error) {
    $('#signin-state').textContent = 'サインインできませんでした。入力を確認してください。';
    return;
  }
  $('#signin-state').textContent = '';
  $('#password').value = '';
  await refreshSession();
  await render();
  watchShelves();
});

$('#signout').addEventListener('click', async () => {
  await supabase.auth.signOut();
  session = null;
  await refreshSession();
  await render();
});

// 表示名の入力欄は、サインイン画面と設定画面の2か所にある。
// どちらで直しても同じ値になるよう、まとめて面倒を見る。
const displayNameInputs = () => document.querySelectorAll('.display-name');

const setDisplayName = (value) => {
  localStorage.setItem('display-name', value);
  for (const input of displayNameInputs()) input.value = value;
  refreshSession();
};

for (const input of displayNameInputs()) {
  input.addEventListener('change', (e) => setDisplayName(e.target.value.trim()));
}

// 相手がピック・アーカイブした瞬間に自分の画面へ反映する
let watching = false;
function watchShelves() {
  if (!supabase || !session || watching) return;
  watching = true;
  const channel = supabase.channel('shelves');
  for (const table of [...Object.values(SHELVES).map((s) => s.table), 'event_dates']) {
    channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => render());
  }
  channel.subscribe();
}

// ── 起動 ────────────────────────────────────────────────
async function load() {
  try {
    const res = await fetch(`data/items.json?t=${Date.now()}`);
    store = await res.json();
  } catch {
    $('#stamp').textContent = '情報を読み込めませんでした。通信状況を確認してください。';
    return;
  }

  const newCount = store.items.filter((i) => i.batch === store.batchId).length;
  const at = new Date(store.generatedAt);
  $('#stamp').textContent = `最終更新 ${at.toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' })}`;
  $('#timer').classList.toggle('is-alert', newCount > 0);

  for (const input of displayNameInputs()) input.value = localStorage.getItem('display-name') ?? '';
  loadRead();
  renderChips();
  await refreshSession();
  await render();
  watchShelves();
  loadSources();
  setupExternalLinks();
}

// ── 情報源の表示 ────────────────────────────────────────
async function loadSources() {
  try {
    const res = await fetch(`data/sources.json?t=${Date.now()}`);
    const { sources } = await res.json();
    const list = $('#sources-list');
    list.textContent = '';
    for (const s of sources) {
      const li = document.createElement('li');
      li.innerHTML = `<a href="${s.url}" target="_blank" rel="noopener">${escapeHtml(s.name)}</a>`;
      list.append(li);
    }
  } catch {
    // 情報源一覧は補助的な表示なので、失敗しても本体の動作は止めない
  }
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => {
      t.classList.remove('is-active');
      t.setAttribute('aria-selected', 'false');
    });
    tab.classList.add('is-active');
    tab.setAttribute('aria-selected', 'true');
    view = tab.dataset.view;
    render();
  });
});

$('#export-picks').addEventListener('click', async () => {
  const picks = await cached('picks');
  const blob = new Blob([JSON.stringify(picks, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ultraman-picks-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// ── 通知の購読 ──────────────────────────────────────────
const urlBase64ToUint8Array = (base64) => {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
};

const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;

if (!isStandalone) {
  $('#push-state').textContent =
    '共有メニューから「ホーム画面に追加」し、そこから開き直すと通知を有効にできます。';
  $('#enable-push').disabled = true;
}

// 許可ダイアログはタップ操作の中でしか出せないため、必ずボタン経由で呼びます。
$('#enable-push').addEventListener('click', async () => {
  if (!VAPID_PUBLIC_KEY) {
    $('#push-state').textContent = 'app.js の VAPID_PUBLIC_KEY が未設定です。';
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    $('#push-state').textContent = '通知が許可されませんでした。iPhone の設定から変更できます。';
    return;
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  });
  $('#push-state').textContent = '通知を有効にしました。';
  $('#show-subscription').hidden = false;
  $('#share-subscription').hidden = !navigator.share;
  $('#subscription-box').value = JSON.stringify(sub.toJSON(), null, 2);
});

$('#show-subscription').addEventListener('click', () => {
  const box = $('#subscription-box');
  box.hidden = !box.hidden;
  $('#subscription-help').hidden = box.hidden;
  if (!box.hidden) box.select();
});

// 相手の端末で登録した購読情報を、LINE や AirDrop で管理者に渡せるようにする。
$('#share-subscription').addEventListener('click', async () => {
  const text = $('#subscription-box').value;
  if (!text) return;
  try {
    await navigator.share({ title: 'ウルトラマン情報 購読情報', text });
  } catch {
    /* 共有をやめた場合は何もしない */
  }
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');

load();
