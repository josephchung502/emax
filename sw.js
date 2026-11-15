// eMAX 학생 관리 — 서비스 워커 (홈 화면 앱·알림용)
// 화면 파일은 저장해 두지 않음 → 앱을 열 때마다 항상 최신 버전

// 매일 12시 알림: Firebase 프로젝트를 만든 뒤 index.html과 같은 값을 채우면 켜짐
const FIREBASE_CONFIG = null; // {apiKey, authDomain, projectId, messagingSenderId, appId}
if (FIREBASE_CONFIG) {
  importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');
  firebase.initializeApp(FIREBASE_CONFIG);
  firebase.messaging(); // 알림 표시·클릭(브리핑 열기)은 Firebase가 처리
}

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
// Firebase가 아닌 알림을 누르면 앱을 열고 브리핑을 띄움
self.addEventListener('notificationclick', function (e) {
  if (e.notification.data && e.notification.data.FCM_MSG) return;
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (const c of list) { if ('focus' in c) { c.navigate('./?brief=1'); return c.focus(); } }
    return self.clients.openWindow('./?brief=1');
  }));
});
