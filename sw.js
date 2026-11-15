// eMAX 학생 관리 — 서비스 워커 (홈 화면 앱·알림용)
// 화면 파일은 저장해 두지 않음 → 앱을 열 때마다 항상 최신 버전
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
// 알림을 누르면 앱을 열고 브리핑을 띄움
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (const c of list) { if ('focus' in c) { c.navigate('./?brief=1'); return c.focus(); } }
    return self.clients.openWindow('./?brief=1');
  }));
});
