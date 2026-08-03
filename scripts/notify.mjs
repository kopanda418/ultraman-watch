import { readFile } from 'node:fs/promises';
import path from 'node:path';
import webpush from 'web-push';

const ROOT = path.resolve(import.meta.dirname, '..');
const lastRun = JSON.parse(await readFile(path.join(ROOT, 'state', 'last-run.json'), 'utf8'));

if (lastRun.skipped || lastRun.newCount === 0) {
  console.log('新着がないため通知しません。');
  process.exit(0);
}

const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, PUSH_SUBSCRIPTIONS, SITE_URL } =
  process.env;

if (!VAPID_PRIVATE_KEY || !PUSH_SUBSCRIPTIONS) {
  console.log('通知の設定が未登録なのでスキップします。');
  process.exit(0);
}

webpush.setVapidDetails(VAPID_SUBJECT ?? 'mailto:you@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// PUSH_SUBSCRIPTIONS は購読情報の配列。
// [{ "label": "自分", "subscription": { ... } }, { "label": "妻", "subscription": { ... } }]
// 端末を増やすときはこの配列に足すだけで済みます。
let targets;
try {
  const parsed = JSON.parse(PUSH_SUBSCRIPTIONS);
  targets = (Array.isArray(parsed) ? parsed : [parsed]).map((t, i) =>
    t.subscription ? t : { label: `端末${i + 1}`, subscription: t },
  );
} catch (err) {
  console.error(`PUSH_SUBSCRIPTIONS の形式が不正です: ${err.message}`);
  process.exit(1);
}

const payload = JSON.stringify({
  title: `ウルトラマン情報 新着 ${lastRun.newCount} 件`,
  body: lastRun.highlights.join('\n') || '新しい情報が見つかりました',
  url: SITE_URL ?? '/',
  tag: `ultraman-${lastRun.batchId}`,
});

// 1台が失効していても、もう1台への通知は必ず届ける。
const results = await Promise.allSettled(
  targets.map((t) => webpush.sendNotification(t.subscription, payload)),
);

const expired = [];
let sent = 0;

results.forEach((res, i) => {
  const label = targets[i].label;
  if (res.status === 'fulfilled') {
    sent += 1;
    console.log(`✓ ${label} へ送信しました`);
    return;
  }
  const code = res.reason?.statusCode;
  if (code === 404 || code === 410) {
    expired.push(label);
    console.error(`✗ ${label}: 購読が失効しています`);
  } else {
    console.error(`✗ ${label}: ${code ?? ''} ${res.reason?.body ?? res.reason?.message ?? ''}`);
  }
});

if (expired.length) {
  console.error(
    `\n${expired.join('・')} の購読が切れています。該当の iPhone で PWA を開き、` +
      '「通知を有効にする」を押し直して PUSH_SUBSCRIPTIONS を更新してください。',
  );
}

// 全滅したときだけワークフローを失敗させ、気づけるようにする。
if (sent === 0) process.exit(1);
