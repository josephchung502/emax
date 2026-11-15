// eMAX 학생 관리 — 서비스 워커 (홈 화면 앱·알림용)
// 화면 파일은 저장해 두지 않음 → 앱을 열 때마다 항상 최신 버전

// 알림을 누르면 알림이 안내한 화면으로 — 이미 열려 있는 앱도 그 화면으로 바꿈
// (Firebase 기본 동작은 열린 앱을 앞으로만 가져와서, Firebase보다 먼저 등록하고 기본 동작을 막음)
self.addEventListener('notificationclick', function (e) {
  e.stopImmediatePropagation();
  e.notification.close();
  const d = e.notification.data || {}, m = d.FCM_MSG || {};
  const link = (m.fcmOptions && m.fcmOptions.link) || (m.fcm_options && m.fcm_options.link)
    || (m.notification && m.notification.click_action) || d.link || './?brief=1';
  const url = new URL(link, self.registration.scope).href, t = Date.now(), key = self.registration.scope + '__nav';
  e.waitUntil(caches.open('emax-nav')
    .then(function (c) { return c.put(key, new Response(JSON.stringify({url: url, t: t}), {headers: {'Content-Type': 'application/json'}})); })
    .catch(function () {})
    .then(function () { return self.clients.matchAll({type: 'window', includeUncontrolled: true}); })
    .then(function (list) {
      const c = list.filter(function (x) { return x.url.indexOf(self.registration.scope) === 0; })[0];
      if (c) {
        c.postMessage({type: 'emax-open', url: url, t: t});
        return c.focus ? c.focus().catch(function () {}) : null;
      }
      return self.clients.openWindow(url);
    }));
});

// 매일 12시 알림: Firebase 프로젝트를 만든 뒤 index.html과 같은 값을 채우면 켜짐
const FIREBASE_CONFIG = {apiKey:'AIzaSyDPJOLnMkYBkLEHkpI34zlhBpB5hZOd5wI', authDomain:'emax-student-app.firebaseapp.com', projectId:'emax-student-app', messagingSenderId:'712333583681', appId:'1:712333583681:web:80f37ef87655ee8015edc0'}; // 공개용 웹 설정값 (비밀 아님)
if (FIREBASE_CONFIG) {
  importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');
  firebase.initializeApp(FIREBASE_CONFIG);
  firebase.messaging(); // 알림 표시는 Firebase, 누르면 위의 처리로
}

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
