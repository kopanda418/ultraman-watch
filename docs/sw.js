// 通知の受信と、タップしたときの画面遷移だけを担当します。
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* 空でも通知は出す */ }

  event.waitUntil(
    self.registration.showNotification(data.title ?? 'ウルトラマン情報', {
      body: data.body ?? '新しい情報が見つかりました',
      tag: data.tag ?? 'ultraman-watch',
      data: { url: data.url ?? '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url ?? '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => 'focus' in c);
      return open ? open.focus() : clients.openWindow(target);
    })
  );
});
