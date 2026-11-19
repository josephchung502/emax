/* G5 TFS 숙제 채점 — 학원 성적 엑셀(Subject) + 숙제 묶음 PDF + 답지 → AI 채점 → 같은 엑셀로 저장
   AI: Claude 안에서 열면 내 Claude 사용량(sample), 웹 주소로 열면 내 API 키(이 브라우저에만 저장) */
(function () {
'use strict';

/* ───────── 작은 도구 ───────── */
const $ = (s, el) => (el || document).querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* 없음 */ } }
};
function b64ToBytes(b64) { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
function bytesToB64(u) { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
function blobB64(b) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = () => rej(r.error); r.readAsDataURL(b); }); }
function isPdf(f) { return f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '')); }
function todayYmd() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

let toastT = null;
function toast(msg, kind) {
  const el = $('#toast'); el.textContent = msg; el.className = 'show' + (kind ? ' ' + kind : '');
  clearTimeout(toastT); toastT = setTimeout(() => { el.className = ''; }, 4800);
}
// 브라우저 confirm 대신 (Claude 화면에서는 confirm이 막혀 있음)
function ask(title, body, okLabel, cancelLabel) {
  return new Promise(res => {
    const d = $('#dlg');
    d.innerHTML = '<div class="dlg-box" role="dialog" aria-modal="true" aria-labelledby="dlg-t"><h3 id="dlg-t">' + esc(title) + '</h3>'
      + (body ? '<div class="dlg-body">' + body + '</div>' : '')
      + '<div class="dlg-acts"><button type="button" class="btn ghost" id="dlg-no">' + esc(cancelLabel || '취소') + '</button>'
      + '<button type="button" class="btn primary" id="dlg-ok">' + esc(okLabel || '확인') + '</button></div></div>';
    d.classList.add('open');
    const done = v => { d.classList.remove('open'); d.innerHTML = ''; d.onclick = null; res(v); };
    $('#dlg-ok').onclick = () => done(true);
    $('#dlg-no').onclick = () => done(false);
    d.onclick = e => { if (e.target === d) done(false); };
    $('#dlg-ok').focus();
  });
}

/* ───────── 기본값 (G5 TFS) ───────── */
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const DEFAULT_SUBJ = ['Particip', 'Voc Test', 'Gram HW', 'GraSp', 'Sci HW', 'Sci Test', 'Sci Teaching', 'TFL Reading', 'Grammar Test', 'TFL Speaking', 'Novel', 'Bonus Points'];
const DEFAULT_RULES = {
  'Voc Test': '보기를 고르는 문항은 고른 보기 번호로 채점. 받아쓰기는 철자가 하나라도 틀리면 오답.',
  'Grammar Test': '보기를 여러 개 고르는 문항은 정답 보기를 모두 고르고 다른 보기는 고르지 않아야 정답. 불규칙동사표는 한 줄이 한 문항: 현재·과거·과거분사 철자와 한국어 뜻이 모두 맞아야 정답 (뜻은 정답지에 쉼표로 적은 것 중 하나면 정답).',
  'Sci Test': 'Modified True/False는 T/F만 맞으면 정답 (고쳐 쓴 말은 채점하지 않음).',
  'Novel': '짝짓기 문항은 학생이 쓴 글자나 이은 선으로 판단.'
};
const RARE_SUBJ = {'Particip': 1, 'Sci Teaching': 1, 'TFL Speaking': 1, 'Bonus Points': 1};
const PRICE = {'claude-sonnet-5-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5]};

/* ───────── 채점 계산 (앱 채점 비서와 같은 규칙) ───────── */
function normQ(q) {
  return String(q == null ? '' : q).trim().toLowerCase().replace(/^(q|no\.?|문항)\s*/, '').replace(/[.)\]:：]+$/, '').replace(/\s+/g, '');
}
function keyLines(text) {
  const out = [];
  String(text || '').split(/\r?\n/).forEach(line => {
    const t = line.trim();
    if (!t || t.charAt(0) === '#') return;
    const m = t.match(/^(\S+?)[.):]?\s+(.+)$/);
    if (m) out.push(m);
  });
  return out;
}
function keyItems(text) {
  const out = [], seen = {};
  keyLines(text).forEach(m => {
    const nq = normQ(m[1]);
    if (!nq || seen[nq]) return;
    let a = m[2].trim(), w = 1;
    const pm = a.match(/\((\d+(?:\.\d+)?)\s*점\)/);
    if (pm) { w = Number(pm[1]) || 1; a = a.replace(pm[0], '').trim(); }
    seen[nq] = 1;
    out.push({q: m[1].replace(/[.):]+$/, ''), nq: nq, a: a, w: w});
  });
  return out;
}
function keyDups(text) {
  const seen = {}, dups = [];
  keyLines(text).forEach(m => {
    const nq = normQ(m[1]);
    if (!nq) return;
    if (seen[nq] === 1) dups.push(m[1].replace(/[.):]+$/, ''));
    seen[nq] = (seen[nq] || 0) + 1;
  });
  return dups;
}
function keyTitle(text) { const m = String(text || '').match(/^\s*#\s*제목\s*[:：]\s*(.+)$/m); return m ? m[1].trim() : ''; }
function scoreOf(got, totalW, mode) { const x = got / (totalW || 1) * 100; return mode === 'round' ? Math.round(x) : Math.floor(x + 1e-9); }

// 원생명 "강지유Courtney 주1" · 종이 "Courtney 강지유" → 한글·영어 이름으로 맞춤
function nameParts(s) {
  s = String(s || '').replace(/\(T\)|\[T\]|주\s*\d+|\*/gi, ' ');
  return {ko: (s.match(/[가-힣]+/g) || []).join(''), en: (s.match(/[A-Za-z]+/g) || []).join('').toLowerCase()};
}
function findSid(roster, name) {
  const raw = String(name || '').trim();
  if (!raw || !roster.length) return '';
  const ex = roster.find(r => r.name === raw);
  if (ex) return ex.sid;
  const p = nameParts(raw);
  const one = arr => arr.length === 1 ? arr[0].sid : '';
  let hit = '';
  if (p.ko && p.en && (hit = one(roster.filter(r => r.ko === p.ko && r.en === p.en)))) return hit;
  if (p.ko && (hit = one(roster.filter(r => r.ko === p.ko)))) return hit;
  if (p.en && (hit = one(roster.filter(r => r.en === p.en)))) return hit;
  if (p.ko.length >= 2 && (hit = one(roster.filter(r => r.ko.length > p.ko.length && r.ko.slice(-p.ko.length) === p.ko)))) return hit;
  return '';
}
function unkKey(nm) { const p = nameParts(nm); return 'unk:' + (p.ko || p.en || String(nm || '').trim()); }

// 쪽들을 학생별로 묶고, 학생 안에서 숙제별 점수 계산
// assign {쪽: 원생코드 | 'unk:이름' | 'skip'} · passign {쪽: 숙제id | 'none'} · toggles {'주인|숙제id|문항': true/false}
function groupPages(job, assign, toggles, passign) {
  assign = assign || {}; toggles = toggles || {}; passign = passign || {};
  const parts = job.parts, pmap = {}, keys = {}, roster = job.roster || [], mode = job.scoring || 'floor';
  parts.forEach(p => {
    const ks = keyItems(p.key), inKey = {};
    ks.forEach(k => { inKey[k.nq] = 1; });
    pmap[p.id] = p;
    keys[p.id] = {items: ks, inKey: inKey, totalW: ks.reduce((s, k) => s + k.w, 0) || 1};
  });
  const single = parts.length === 1 ? parts[0].id : '';
  const groups = [], idx = {};
  let cur = null, curPart = '';
  (job.pages || []).forEach((pg, i) => {
    const r = pg && pg.st === 'ok' ? pg.res : null;
    let owner;
    const a = assign[i];
    if (a) owner = a === 'skip' ? 'skip' : a.indexOf('unk:') === 0 ? a : 'sid:' + a;
    else if (r) {
      const sid = findSid(roster, r.roster_name) || findSid(roster, r.name_on_page);
      const nm = String(r.name_on_page || '').trim();
      owner = sid ? 'sid:' + sid : nm ? unkKey(nm) : (cur ? cur.owner : 'unk:');
    } else owner = cur ? cur.owner : 'unk:';
    let g = idx[owner];
    if (!g) { g = idx[owner] = {owner: owner, pages: [], parts: {}, unpart: [], pp: {}, raw: ''}; groups.push(g); }
    g.pages.push(i);
    if (!g.raw && r && r.name_on_page) g.raw = String(r.name_on_page).trim();
    if (owner === 'skip') return;
    if (!cur || cur.owner !== owner) curPart = '';
    cur = g;
    let pid = '';
    if (passign[i] === 'none') pid = 'none';
    else if (passign[i] && pmap[passign[i]]) pid = passign[i];
    else if (single) pid = r && r.part === 'none' && !(r.items || []).length ? 'none' : single;
    else if (r && r.part === 'none') pid = 'none';
    else if (r && pmap[r.part]) pid = r.part;
    else if (curPart && r && (!String(r.name_on_page || '').trim() || r.continues_previous)) pid = curPart;
    g.pp[i] = pid;
    if (!pid) { if (r) g.unpart.push(i); return; }
    if (pid === 'none') return;
    curPart = pid;
    const gp = g.parts[pid] || (g.parts[pid] = {pages: [], items: {}});
    gp.pages.push(i);
    if (r) (r.items || []).forEach(it => {
      const nq = normQ(it.q);
      if (!keys[pid].inKey[nq]) return;
      const ex = gp.items[nq];
      if (!ex || (!ex.sure && it.sure)) gp.items[nq] = {read: String(it.read == null ? '' : it.read), correct: !!it.correct, sure: !!it.sure, note: String(it.note || ''), p: i};
    });
  });
  groups.forEach(g => {
    const sid = g.owner.indexOf('sid:') === 0 ? g.owner.slice(4) : '';
    const st = sid ? roster.find(r => r.sid === sid) : null;
    g.sid = st ? sid : '';
    g.name = st ? st.name : g.owner === 'skip' ? '' : (g.raw || g.owner.slice(4));
    g.list = [];
    parts.forEach(p => {
      const gp = g.parts[p.id];
      if (!gp) return;
      const K = keys[p.id];
      let got = 0, right = 0, unsure = 0, missing = 0;
      const rows = K.items.map(k => {
        const it = gp.items[k.nq], t = toggles[g.owner + '|' + p.id + '|' + k.nq];
        const set = t === true || t === false;
        const ok = set ? t : !!(it && it.correct);
        const flag = !set && !!it && !it.sure;
        if (ok) { got += k.w; right++; }
        if (flag) unsure++;
        if (!it && !set) missing++;
        return {q: k.q, nq: k.nq, a: k.a, w: k.w, read: it ? it.read : null, ok: ok, flag: flag, note: it ? it.note : '', p: it ? it.p : -1, set: set};
      });
      g.list.push({pid: p.id, name: p.name, pages: gp.pages, rows: rows, right: right, total: K.items.length, unsure: unsure, missing: missing, score: scoreOf(got, K.totalW, mode)});
    });
    g.unsure = g.list.reduce((s, x) => s + x.unsure, 0);
    g.missing = g.list.reduce((s, x) => s + x.missing, 0);
    g.check = g.unsure + g.list.filter(x => x.missing).length + g.unpart.length;
  });
  return groups;
}

/* ───────── 엑셀 (학원 프로그램 Subject 형식 그대로) ───────── */
function colIdx(ref) { const m = /^([A-Z]+)/.exec(ref); let n = 0; for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }
function colRef(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
function rowCells(rowEl) {
  const out = [];
  let col = -1;
  for (const c of Array.from(rowEl.childNodes)) {
    if (c.nodeType !== 1 || c.localName !== 'c') continue;
    const r = c.getAttribute('r');
    col = r ? colIdx(r) : col + 1;
    out.push({el: c, col: col});
  }
  return out;
}
function cellVal(c, shared) {
  const t = c.getAttribute('t');
  if (t === 'inlineStr') { const is = c.getElementsByTagName('is')[0]; return is ? is.textContent : ''; }
  const v = c.getElementsByTagName('v')[0], txt = v ? v.textContent : '';
  if (t === 's') return shared[Number(txt)] || '';
  if (t === 'str' || t === 'e') return txt;
  if (t === 'b') return txt === '1';
  if (txt === '') return '';
  const n = Number(txt);
  return isNaN(n) ? txt : n;
}
function numOf(v) { if (typeof v === 'number') return v; if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v); return null; }
async function sheetPath(zip) {
  try {
    const wb = await zip.file('xl/workbook.xml').async('string');
    const rid = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb);
    const relsF = zip.file('xl/_rels/workbook.xml.rels');
    if (rid && relsF) {
      const rels = await relsF.async('string');
      const rel = (rels.match(/<Relationship\b[^>]*>/g) || []).find(x => x.indexOf('Id="' + rid[1] + '"') >= 0);
      const tg = rel && /Target="([^"]+)"/.exec(rel);
      if (tg) { let p = tg[1].replace(/^\//, ''); if (p.indexOf('xl/') !== 0) p = 'xl/' + p; if (zip.file(p)) return p; }
    }
  } catch (e) { /* 아래 기본값 */ }
  return 'xl/worksheets/sheet1.xml';
}
async function sharedStrings(zip) {
  const f = zip.file('xl/sharedStrings.xml');
  if (!f) return [];
  const d = new DOMParser().parseFromString(await f.async('string'), 'application/xml');
  return Array.from(d.getElementsByTagName('si')).map(si => Array.from(si.getElementsByTagName('t')).map(t => t.textContent).join(''));
}
async function xlOpen(bytes) {
  await ensureLibs();
  if (typeof JSZip === 'undefined') throw new Error('엑셀 도구를 불러오지 못했어요 — 새로고침해 주세요');
  let zip;
  try { zip = await JSZip.loadAsync(bytes); } catch (e) { throw new Error('엑셀(.xlsx) 파일이 아니에요'); }
  const path = await sheetPath(zip);
  if (!zip.file(path)) throw new Error('엑셀 시트를 찾지 못했어요');
  const shared = await sharedStrings(zip);
  const doc = new DOMParser().parseFromString(await zip.file(path).async('string'), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('엑셀 시트를 읽지 못했어요');
  // 새로 만드는 칸의 모양: 학원 양식이면 1 = 가운데, 2 = 오른쪽(총점·평균)
  let def = null;
  const sf = zip.file('xl/styles.xml');
  if (sf) {
    const sd = new DOMParser().parseFromString(await sf.async('string'), 'application/xml');
    const cx = sd.getElementsByTagName('cellXfs')[0];
    const xfs = cx ? Array.from(cx.childNodes).filter(n => n.nodeType === 1 && n.localName === 'xf') : [];
    const hz = i => { const a = xfs[i] && xfs[i].getElementsByTagName('alignment')[0]; return a ? a.getAttribute('horizontal') : ''; };
    if (hz(1) === 'center') def = {cell: '1', num: hz(2) === 'right' ? '2' : '1'};
  }
  return {zip: zip, path: path, shared: shared, doc: doc, def: def};
}
function xlLayout(doc, shared) {
  const rows = Array.from(doc.getElementsByTagName('row'));
  if (!rows.length) throw new Error('엑셀이 비어 있어요');
  const hdr = {};
  rowCells(rows[0]).forEach(x => { hdr[x.col] = String(cellVal(x.el, shared)).trim(); });
  const find = n => { const k = Object.keys(hdr).find(c => hdr[c] === n); return k == null ? -1 : Number(k); };
  const L = {hdr: hdr, rows: rows, codeCol: find('원생코드'), nameCol: find('원생명'), gubunCol: find('구분'), checkCol: find("<input type='checkbox'/>"),
    totCol: find('총점'), avgCol: find('평균'), rankCol: find('반석차'), cntCol: find('반응시인원')};
  if (L.nameCol < 0) throw new Error('원생명 칸이 없는 엑셀이에요 — 학원 프로그램에서 내려받은 성적(Subject) 엑셀을 올려 주세요');
  const start = Math.max(find('출결상태코드'), find('수업태도코드'), find('수정'), L.gubunCol, L.nameCol);
  const end = L.totCol >= 0 ? L.totCol : Math.max.apply(null, Object.keys(hdr).map(Number)) + 1;
  L.subj = Object.keys(hdr).map(Number).filter(c => c > start && c < end && hdr[c]).sort((a, b) => a - b).map(c => ({col: c, name: hdr[c]}));
  return L;
}
async function xlModel(bytes, fileName) {
  const o = await xlOpen(bytes), L = xlLayout(o.doc, o.shared);
  const roster = [];
  L.rows.slice(1).forEach(rowEl => {
    const vals = {};
    rowCells(rowEl).forEach(x => { vals[x.col] = cellVal(x.el, o.shared); });
    const nm = String(vals[L.nameCol] == null ? '' : vals[L.nameCol]).trim();
    if (!nm) return;
    const code = L.codeCol >= 0 ? String(vals[L.codeCol] == null ? '' : vals[L.codeCol]).trim() : '';
    const p = nameParts(nm);
    roster.push({sid: code || 'row' + rowEl.getAttribute('r'), name: nm, ko: p.ko, en: p.en});
  });
  return {name: fileName, bytes: bytes, subj: L.subj, roster: roster};
}
// 반 엑셀이 없을 때 쓰는 빈 양식 (머리글 한 줄 — template.js)
async function makeTemplate() {
  await ensureLibs();
  const T = window.G5_TEMPLATE;
  if (!T || typeof JSZip === 'undefined') throw new Error('빈 엑셀 양식을 불러오지 못했어요 — 새로고침해 주세요');
  const z = new JSZip();
  Object.keys(T).sort((a, b) => (b === '[Content_Types].xml') - (a === '[Content_Types].xml')).forEach(p => z.file(p, T[p], {createFolders: false}));
  return z.generateAsync({type: 'uint8array', compression: 'DEFLATE'});
}
function rowVals(X, rowEl) { const v = {}; rowCells(rowEl).forEach(x => { v[x.col] = cellVal(x.el, X.shared); }); return v; }
function styleFor(X, rowEl, col) {
  for (const r of X.rows) {
    if (r === rowEl || r === X.rows[0]) continue;
    const hit = rowCells(r).find(x => x.col === col);
    if (hit && hit.el.getAttribute('s')) return hit.el.getAttribute('s');
  }
  if (X.def) return col === X.L.totCol || col === X.L.avgCol ? X.def.num : X.def.cell;
  return '';
}
function fixRefs(rowEl) { const r = rowEl.getAttribute('r'); rowCells(rowEl).forEach(x => x.el.setAttribute('r', colRef(x.col) + r)); }
function ensureCell(X, rowEl, col) {
  const r = rowEl.getAttribute('r'), cells = rowCells(rowEl);
  const hit = cells.find(x => x.col === col);
  if (hit) return hit.el;
  const c = X.doc.createElementNS(NS, 'c');
  c.setAttribute('r', colRef(col) + r);
  const s = styleFor(X, rowEl, col);
  if (s) c.setAttribute('s', s);
  const next = cells.find(x => x.col > col);
  rowEl.insertBefore(c, next ? next.el : null);
  return c;
}
function setNum(X, rowEl, col, num) {
  const c = ensureCell(X, rowEl, col);
  c.removeAttribute('t');
  while (c.firstChild) c.removeChild(c.firstChild);
  const v = X.doc.createElementNS(NS, 'v'); v.textContent = String(num); c.appendChild(v);
}
function setStr(X, rowEl, col, str) {
  const c = ensureCell(X, rowEl, col);
  c.setAttribute('t', 'inlineStr');
  while (c.firstChild) c.removeChild(c.firstChild);
  const is = X.doc.createElementNS(NS, 'is'), t = X.doc.createElementNS(NS, 't');
  t.textContent = str; is.appendChild(t); c.appendChild(is);
}
// 총점 = 점수가 있는 과목의 합 · 평균 = 총점 ÷ 그 과목 수 (소수 둘째 자리 반올림)
function recalcRow(X, rowEl) {
  const L = X.L;
  if (L.totCol < 0) return;
  const v = rowVals(X, rowEl);
  let tot = 0, n = 0;
  L.subj.forEach(s => { const x = numOf(v[s.col]); if (x != null) { tot += x; n++; } });
  if (!n) return;
  setNum(X, rowEl, L.totCol, Math.round(tot * 100) / 100);
  if (L.avgCol >= 0) setNum(X, rowEl, L.avgCol, Math.round(tot * 100 / n) / 100);
}
// 반석차 = 총점 높은 순 (같은 점수는 같은 등수: 1, 2, 2, 4)
function recalcRanks(X, setCount) {
  const L = X.L;
  if (L.totCol < 0 || L.rankCol < 0) return;
  const data = X.rows.filter(r => r !== X.rows[0]).map(r => {
    const hit = rowCells(r).find(x => x.col === L.totCol);
    return {r: r, t: hit ? numOf(cellVal(hit.el, X.shared)) : null};
  }).filter(x => x.t != null);
  data.forEach(x => {
    fixRefs(x.r);
    setNum(X, x.r, L.rankCol, 1 + data.filter(y => y.t > x.t).length);
    if (setCount && L.cntCol >= 0) setNum(X, x.r, L.cntCol, data.length);
  });
}
// 점수를 넣은 엑셀 만들기. scores {원생코드: {과목이름: 점수}} 또는 newRows [{name, cols: {과목이름: 점수}}]
async function xlBuild(base, scores, newRows) {
  const o = await xlOpen(base), doc = o.doc, L = xlLayout(doc, o.shared);
  const X = {doc: doc, rows: L.rows, L: L, shared: o.shared, def: o.def};
  const colByName = {}, lost = {};
  L.subj.forEach(s => { colByName[s.name] = s.col; });
  const put = (rowEl, cols) => Object.keys(cols).forEach(nm => { const c = colByName[nm]; if (c == null) { lost[nm] = 1; return; } setNum(X, rowEl, c, cols[nm]); });
  let changed = 0;
  if (newRows) {
    const sheetData = doc.getElementsByTagName('sheetData')[0];
    let r = X.rows.reduce((m, el) => Math.max(m, Number(el.getAttribute('r')) || 0), 0) + 1;
    newRows.forEach(nr => {
      const rowEl = doc.createElementNS(NS, 'row');
      rowEl.setAttribute('r', String(r++));
      sheetData.appendChild(rowEl);
      X.rows.push(rowEl);
      if (L.checkCol >= 0) setStr(X, rowEl, L.checkCol, 'false');
      setStr(X, rowEl, L.nameCol, nr.name);
      if (L.gubunCol >= 0) setStr(X, rowEl, L.gubunCol, 'O');
      put(rowEl, nr.cols);
      recalcRow(X, rowEl);
      changed++;
    });
  } else {
    X.rows.slice(1).forEach(rowEl => {
      const v = rowVals(X, rowEl);
      const nm = String(v[L.nameCol] == null ? '' : v[L.nameCol]).trim();
      if (!nm) return;
      const code = L.codeCol >= 0 ? String(v[L.codeCol] == null ? '' : v[L.codeCol]).trim() : '';
      const cols = scores[code || 'row' + rowEl.getAttribute('r')];
      if (!cols) return;
      fixRefs(rowEl);
      put(rowEl, cols);
      recalcRow(X, rowEl);
      changed++;
    });
  }
  if (changed) recalcRanks(X, !!newRows);
  let xml = new XMLSerializer().serializeToString(doc);
  if (!/^<\?xml/.test(xml)) xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + xml;
  o.zip.file(o.path, xml, {createFolders: false});
  // 폴더 항목은 빼고 파일만 (엑셀이 만드는 xlsx와 같게)
  Object.keys(o.zip.files).forEach(k => { if (o.zip.files[k].dir) delete o.zip.files[k]; });
  return {data: await o.zip.generateAsync({type: 'uint8array', compression: 'DEFLATE'}), changed: changed, lost: Object.keys(lost)};
}

/* ───────── AI (Claude 사용량 또는 내 API 키) ───────── */
const AI = {mode: 'wait', sample: null, limits: null, dl: null, inClaude: false};
const FATAL = {not_granted: 1, sampling_disabled: 1, not_declared: 1, capability_disabled: 1, capability_removed: 1, images_unavailable: 1, session_expired: 1, bad_key: 1, no_credit: 1, no_key: 1, no_engine: 1, queue_overflow: 1};
function apiKey() { return store.get('g5g:apikey', ''); }
function pickMode() {
  if (AI.sample && AI.limits && AI.limits.images) return 'claude';
  if (apiKey()) return 'api';
  if (AI.sample) return 'noimg';
  return AI.inClaude ? 'none' : 'needkey';
}
function safeUse(name) { try { return Promise.resolve(window.claude.use(name)).catch(() => null); } catch (e) { return Promise.resolve(null); } }
async function aiInit() {
  // Claude 안에서 열면 window.claude가 있어요 (웹 주소로 열면 없어요)
  const web = /(^|\.)github\.io$/.test(location.hostname) || location.protocol === 'file:';
  for (let t = 0; t < 20 && !web; t++) { if (window.claude && typeof window.claude.use === 'function') break; await sleep(100); }
  AI.inClaude = !!(window.claude && typeof window.claude.use === 'function');
  if (AI.inClaude) {
    renderTop();
    const got = await Promise.all([safeUse('sample'), safeUse('downloads')]);
    AI.sample = got[0]; AI.dl = got[1];
    if (AI.sample) { try { AI.limits = await AI.sample.limits(); } catch (e) { AI.limits = null; } }
  }
  AI.mode = pickMode();
  renderAll();
}
function aiReady() { return AI.mode === 'claude' || AI.mode === 'api'; }
function notReadyCode() { return AI.mode === 'needkey' ? 'no_key' : AI.mode === 'noimg' ? 'images_unavailable' : AI.mode === 'wait' ? 'wait' : 'no_engine'; }
function perCall(forKey) {
  const mx = AI.mode === 'claude' ? ((AI.limits && AI.limits.images && AI.limits.images.maxCount) || 1) : 8;
  return Math.max(1, Math.min(forKey ? 6 : 3, mx));
}
function errText(e) {
  const c = e && e.code;
  if (e && e.mine) return e.message;
  return ({
    not_granted: 'Claude 사용을 허용해야 채점할 수 있어요 — 페이지를 새로 열고 허용을 눌러 주세요',
    sampling_disabled: '이 계정에서는 이 페이지가 Claude를 부를 수 없어요',
    not_declared: '이 페이지가 Claude를 부를 수 없게 되어 있어요', capability_disabled: '이 화면에서는 Claude를 부를 수 없어요', capability_removed: '이 화면에서는 Claude를 부를 수 없어요',
    images_unavailable: '이 화면에서는 사진을 Claude에게 보낼 수 없어요', image_rejected: '사진을 보내지 못했어요 (파일이 너무 크거나 열 수 없어요)',
    session_expired: 'Claude에 다시 로그인해 주세요',
    rate_limited: 'Claude 사용량이 몰렸거나 한도에 닿았어요 — 잠시 뒤 [이어서 채점]을 눌러 주세요',
    invalid_json: 'AI 답을 읽지 못했어요', refused: 'AI가 이 쪽을 채점하지 않았어요', empty_completion: 'AI 답이 비어 있어요',
    prompt_too_large: '정답지가 너무 길어요 — 숙제 수를 줄여 주세요', upstream_error: '연결이 잠깐 끊겼어요',
    bad_key: 'API 키가 맞지 않아요 — ⚙ 설정에서 다시 넣어 주세요', no_credit: 'API 크레딧이 부족해요 (Console > Billing)', no_key: 'API 키를 먼저 넣어 주세요 (⚙ 설정)',
    no_engine: 'Claude에 연결되지 않았어요 — ⚙ 설정에서 API 키를 넣으면 쓸 수 있어요', wait: 'Claude 연결을 확인하는 중이에요 — 잠시 뒤 다시 눌러 주세요',
    no_file: '숙제 파일을 다시 골라 주세요 (3번)'
  })[c] || (e && e.message) || 'AI 오류';
}
function parseLoose(t) {
  t = String(t || '').trim();
  try { return JSON.parse(t); } catch (e) { /* 아래 */ }
  const f = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (f) { try { return JSON.parse(f[1]); } catch (e) { /* 아래 */ } }
  const a = t.search(/[[{]/), b = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { /* 없음 */ } }
  return null;
}
async function aiJson(prompt, blobs, signal) {
  if (AI.mode === 'claude') {
    const opt = {modelTier: S.tier === 'quick' ? 'quick' : 'default'};
    if (blobs && blobs.length) opt.images = blobs;
    if (signal) opt.signal = signal;
    try { return await AI.sample.json(prompt, opt); }
    catch (e) { if (e && e.code === 'invalid_json' && e.text) { const v = parseLoose(e.text); if (v != null) return v; } throw e; }
  }
  if (AI.mode === 'api') return apiJson(prompt, blobs || [], signal);
  throw {code: notReadyCode()};
}
async function apiJson(prompt, blobs, signal) {
  const key = apiKey();
  if (!key) throw {code: 'no_key'};
  const model = S.tier === 'quick' ? 'claude-haiku-5-5' : 'claude-sonnet-5-5';
  const content = [];
  for (const b of blobs) content.push({type: 'image', source: {type: 'base64', media_type: 'image/jpeg', data: await blobB64(b)}});
  content.push({type: 'text', text: prompt});
  const body = JSON.stringify({model: model, max_tokens: 8000, messages: [{role: 'user', content: content}]});
  for (let t = 0; t < 5; t++) {
    let r, txt;
    try {
      r = await fetch('https://api.anthropic.com/v1/messages', {method: 'POST', signal: signal, body: body,
        headers: {'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true'}});
      txt = await r.text();
    } catch (e) {
      if (signal && signal.aborted) throw {code: 'cancelled'};
      if (t < 4) { await sleep(3000 * (t + 1)); continue; }
      throw {code: 'upstream_error'};
    }
    let j = null;
    try { j = JSON.parse(txt); } catch (e) { j = null; }
    if (r.ok && j) {
      if (j.usage) { const pr = PRICE[model]; S.cost += ((j.usage.input_tokens || 0) * pr[0] + (j.usage.output_tokens || 0) * pr[1]) / 1e6; }
      const out = (j.content || []).filter(b => b && b.type === 'text').map(b => b.text).join('');
      const v = parseLoose(out);
      if (v == null) throw {code: j.stop_reason === 'max_tokens' ? 'invalid_json' : out.trim() ? 'invalid_json' : 'empty_completion', text: out};
      return v;
    }
    const msg = j && j.error ? String(j.error.message || j.error.type || '') : String(txt || '').slice(0, 200);
    if (r.status === 401 || r.status === 403) throw {code: 'bad_key'};
    if (/credit|balance|billing/i.test(msg)) throw {code: 'no_credit'};
    if (r.status === 429 || r.status === 529 || r.status >= 500) {
      if (t < 4) { await sleep(6000 * (t + 1)); continue; }
      throw {code: 'rate_limited'};
    }
    throw {code: 'api_error', mine: true, message: '오류 ' + r.status + (msg ? ': ' + msg.slice(0, 120) : '')};
  }
  throw {code: 'upstream_error'};
}

/* ───────── 사진 만들기 (PDF·사진 → 여백 자르고 약 1.2MP JPEG) ───────── */
// PDF·엑셀 도구: jsDelivr(무결성 확인)에서 못 받으면 cdnjs에서 한 번 더
const LIB_SRC = {
  pdfjsLib: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  pdfjsWorker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  JSZip: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'
};
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }
let libsReady = null;
function ensureLibs() {
  if (!libsReady) libsReady = (async () => {
    for (const g of Object.keys(LIB_SRC)) if (!window[g]) { try { await loadScript(LIB_SRC[g]); } catch (e) { /* 아래에서 알림 */ } }
    // 워커 코드가 이 페이지에 있으면 pdf.js가 페이지 안에서 바로 씀 (별도 워커 없음)
    if (window.pdfjsLib) window.pdfjsLib.GlobalWorkerOptions.workerSrc = LIB_SRC.pdfjsWorker;
    if (!window.pdfjsLib || !window.JSZip) toast('PDF·엑셀 도구를 불러오지 못했어요 — 인터넷 연결을 확인하고 새로고침해 주세요', 'bad');
  })();
  return libsReady;
}
async function openPdf(file) {
  await ensureLibs();
  if (!window.pdfjsLib) throw {mine: true, message: 'PDF 도구를 불러오지 못했어요 — 새로고침해 주세요'};
  return window.pdfjsLib.getDocument({data: new Uint8Array(await file.arrayBuffer())}).promise;
}
async function renderPdfPage(doc, n) {
  const page = await doc.getPage(n), v1 = page.getViewport({scale: 1});
  const v = page.getViewport({scale: Math.min(4, 2000 / Math.max(v1.width, v1.height))});
  const c = document.createElement('canvas');
  c.width = Math.round(v.width); c.height = Math.round(v.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({canvasContext: ctx, viewport: v}).promise;
  try { page.cleanup(); } catch (e) { /* 무시 */ }
  return c;
}
async function renderImageFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej({mine: true, message: file.name + ': 사진을 열지 못했어요 (HEIC면 JPG로 바꿔 주세요)'}); im.src = url; });
    const sc = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * sc); c.height = Math.round(img.naturalHeight * sc);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally { URL.revokeObjectURL(url); }
}
// 글씨가 있는 곳만 남기고 여백을 잘라 AI가 보는 해상도를 아낌
function cropBox(src) {
  const W = src.width, H = src.height, sw = 240, sh = Math.max(1, Math.round(240 * H / W));
  const t = document.createElement('canvas'); t.width = sw; t.height = sh;
  const ctx = t.getContext('2d', {willReadFrequently: true});
  ctx.drawImage(src, 0, 0, sw, sh);
  const d = ctx.getImageData(0, 0, sw, sh).data, mx = Math.round(sw * 0.015), my = Math.round(sh * 0.015);
  let x0 = sw, y0 = sh, x1 = -1, y1 = -1;
  for (let y = my; y < sh - my; y++) for (let x = mx; x < sw - mx; x++) {
    const o = (y * sw + x) * 4;
    if (0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2] < 165) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0 || (x1 - x0) * (y1 - y0) < sw * sh * 0.15) return null;
  const px = Math.round(sw * 0.035), py = Math.round(sh * 0.035);
  x0 = Math.max(0, x0 - px); y0 = Math.max(0, y0 - py); x1 = Math.min(sw - 1, x1 + px); y1 = Math.min(sh - 1, y1 + py);
  const f = W / sw, box = {x: Math.round(x0 * f), y: Math.round(y0 * f), w: Math.round((x1 - x0 + 1) * f), h: Math.round((y1 - y0 + 1) * (H / sh))};
  box.w = Math.min(box.w, W - box.x); box.h = Math.min(box.h, H - box.y);
  return box.w * box.h > W * H * 0.9 ? null : box;
}
async function finishCanvas(src) {
  const b = cropBox(src) || {x: 0, y: 0, w: src.width, h: src.height};
  const sc = Math.min(1, Math.sqrt(1.15e6 / (b.w * b.h)));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(b.w * sc)); c.height = Math.max(1, Math.round(b.h * sc));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, b.x, b.y, b.w, b.h, 0, 0, c.width, c.height);
  const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.86));
  src.width = src.height = 0; c.width = c.height = 0;
  if (!blob) throw {mine: true, message: '사진을 만들지 못했어요'};
  return blob;
}

/* ───────── 상태 ───────── */
const S = {
  xl: null,                 // 반 엑셀 {name, bytes, subj:[{col,name}], roster:[{sid,name,ko,en}]}
  sel: [],                  // 고른 숙제 (과목 칸 이름)
  parts: {},                // 이름 → {id, name, key, prevKey, rules, note, busy, open}
  files: [],                // 숙제 파일 [{file, kind, n, doc}]
  filesMeta: null,          // 이어서 볼 때: 지난 파일 이름·쪽 수
  pages: [],                // [{st:'wait'|'busy'|'ok'|'err', res, err, force, solo, blob, url}]
  job: null,                // 채점을 시작할 때 굳힌 숙제·명단 {parts:[{id,name,key,rules}], roster}
  assign: {}, passign: {}, toggles: {}, rename: {}, rot: {},
  scoring: store.get('g5g:scoring', 'floor'), tier: store.get('g5g:tier', 'default'),
  run: null, cost: 0, sel1: '', zoom: false, restored: null, reviewDirty: false
};
function subjList() { return S.xl ? S.xl.subj : DEFAULT_SUBJ.map((n, i) => ({col: 8 + i, name: n})); }
function pid(name) { return String(name).toLowerCase().replace(/[^a-z0-9]/g, '') || 'p'; }
function part(name) {
  if (!S.parts[name]) {
    const rules = store.get('g5g:rules', {});
    S.parts[name] = {id: pid(name), name: name, key: '', prevKey: null, rules: rules[name] != null ? rules[name] : (DEFAULT_RULES[name] || ''), note: '', busy: false, open: false};
  }
  return S.parts[name];
}
function jobView() {
  return {parts: S.job ? S.job.parts : [], roster: S.job ? S.job.roster : [], scoring: S.scoring,
    pages: S.pages.map(p => ({st: p.st === 'ok' ? 'ok' : p.st === 'err' ? 'err' : 'wait', res: p.res}))};
}
function groupsNow() { return groupPages(jobView(), S.assign, S.toggles, S.passign); }
function displayName(g) { return S.rename[g.owner] || g.name || '이름 없음'; }

/* ───────── 저장 (이 브라우저에만 · 새로고침해도 결과 유지) ───────── */
let saveT = null;
function save() { clearTimeout(saveT); saveT = setTimeout(saveNow, 400); }
function saveNow() {
  clearTimeout(saveT);
  if (!S.pages.length && !S.xl) return;
  const parts = {};
  Object.keys(S.parts).forEach(n => { const p = S.parts[n]; parts[n] = {id: p.id, name: p.name, key: p.key, rules: p.rules}; });
  const ok = store.set('g5g:session', {v: 1, at: Date.now(), xl: S.xl ? {name: S.xl.name, b64: bytesToB64(S.xl.bytes)} : null, sel: S.sel, parts: parts, job: S.job,
    files: (S.files.length ? S.files.map(f => ({name: f.file.name, n: f.n})) : S.filesMeta) || [],
    pages: S.pages.map(p => ({st: p.st === 'busy' ? 'wait' : p.st, res: p.res || null, err: p.err || '', force: p.force || '', solo: !!p.solo})),
    assign: S.assign, passign: S.passign, toggles: S.toggles, rename: S.rename});
  if (!ok) toast('이 브라우저에 저장하지 못했어요 — 페이지를 닫기 전에 엑셀로 저장해 두세요', 'warn');
  else if (S.restored) { S.restored = null; renderBanner(); }
}
async function restore(sess) {
  try {
    if (sess.xl) S.xl = await xlModel(b64ToBytes(sess.xl.b64), sess.xl.name);
  } catch (e) { S.xl = null; }
  S.sel = sess.sel || [];
  S.parts = {};
  Object.keys(sess.parts || {}).forEach(n => { S.parts[n] = Object.assign({prevKey: null, note: '', busy: false, open: false}, sess.parts[n]); });
  S.job = sess.job || null;
  S.filesMeta = sess.files || [];
  S.files = [];
  S.pages = (sess.pages || []).map(p => ({st: p.st, res: p.res, err: p.err, force: p.force, solo: p.solo}));
  S.assign = sess.assign || {}; S.passign = sess.passign || {}; S.toggles = sess.toggles || {}; S.rename = sess.rename || {};
  S.restored = null;
  renderBanner();
  renderAll();
  toast('지난 채점을 불러왔어요 — 사진을 보거나 남은 쪽을 채점하려면 같은 숙제 파일을 다시 골라 주세요');
}
function clearAll() {
  if (S.run && S.run.active) stopRun();
  store.del('g5g:session');
  S.pages.forEach(p => { if (p.url) URL.revokeObjectURL(p.url); });
  Object.assign(S, {xl: null, sel: [], parts: {}, files: [], filesMeta: null, pages: [], job: null, assign: {}, passign: {}, toggles: {}, rename: {}, rot: {}, run: null, cost: 0, sel1: '', restored: null});
}

/* ───────── 1. 반 엑셀 ───────── */
async function onXlFile(f) {
  if (!f) return;
  try {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const m = await xlModel(bytes, f.name);
    if (S.job) {
      if (S.pages.some(p => p.st === 'ok') && !(await ask('반 엑셀을 바꿀까요?', '<p>이미 채점한 결과는 그대로 두고, 학생 이름을 새 명단으로 다시 맞춰요.</p>', '바꾸기'))) return;
      S.job.roster = m.roster.map(r => ({sid: r.sid, name: r.name, ko: r.ko, en: r.en}));
      S.assign = {};
    }
    S.xl = m;
    if (!S.job) S.sel = S.sel.filter(n => m.subj.some(s => s.name === n));
    renderAll(); save();
    toast('반 엑셀을 읽었어요 — 학생 ' + m.roster.length + '명', 'ok');
  } catch (e) { toast(e.message || errText(e), 'bad'); }
}

/* ───────── 2. 숙제·답지 ───────── */
function keyPrompt(name, from, total) {
  return [
    'You make an answer key for the assignment "' + name + '" of an English academy in Korea (grade 5), from the images.',
    'The images are an answer key page, or a copy already marked by the teacher (use the teacher\'s corrections and marks to decide the correct answers), or a question sheet without answers (then work out the correct answers yourself).',
    total > 1 ? 'These are images ' + (from + 1) + '–' + Math.min(total, from + perCall(true)) + ' of ' + total + ' of the same answer key, in order.' : '',
    'Rules:',
    '- q must be unique. Use the printed number ("1", "12"). When numbering restarts (sections A/B, Part 1/2, exercises), put the section in front: "A-1", "B-1". For a table filled in row by row (e.g. irregular verbs: present, past, past participle, meaning), make one item per row labelled "표1", "표2", … with the cells joined by " - " in column order.',
    '- a: the correct answer exactly as printed (spelling, wording); for multiple choice the option as printed (e.g. "c", "③"), and when several options must all be chosen list them (e.g. "③ ④ (둘 다)"); several accepted answers joined with " / ".',
    '- sure: false when you worked the answer out yourself and are not certain, or it is hard to read; otherwise true.',
    '- Skip headings, instructions, explanations and translations.',
    'title: the title printed at the top (e.g. "eMAX Vocabulary 5.0 Quiz Week 11-B"), "" if none. note: a short Korean note if something was unreadable or unclear, otherwise "".',
    'Reply with only one JSON object like {"title": "", "items": [{"q": "1", "a": "b", "sure": true}], "note": ""}'
  ].filter(Boolean).join('\n');
}
async function readKey(name, files) {
  const p = part(name);
  if (p.busy) return;
  if (!aiReady()) { toast(errText({code: notReadyCode()}), 'bad'); if (AI.mode === 'needkey' || AI.mode === 'none') openSettings(); return; }
  p.busy = true; p.note = '답지 사진을 만드는 중…'; renderParts();
  try {
    const blobs = [];
    for (const f of files) {
      if (blobs.length >= 12) break;
      if (isPdf(f)) { const doc = await openPdf(f); for (let n = 1; n <= doc.numPages && blobs.length < 12; n++) blobs.push(await finishCanvas(await renderPdfPage(doc, n))); }
      else blobs.push(await finishCanvas(await renderImageFile(f)));
    }
    if (!blobs.length) throw {mine: true, message: '답지 파일을 열지 못했어요'};
    const per = perCall(true), items = [], notes = [];
    let title = '';
    for (let k = 0; k < blobs.length; k += per) {
      p.note = 'AI가 답지를 읽는 중…' + (blobs.length > per ? ' (' + (k / per + 1) + '/' + Math.ceil(blobs.length / per) + ')' : '') + ' — 보통 20초~1분';
      renderParts();
      const out = await aiJson(keyPrompt(name, k, blobs.length), blobs.slice(k, k + per));
      if (!title && out && out.title) title = String(out.title).trim().replace(/\s*\n\s*/g, ' ');
      (out && Array.isArray(out.items) ? out.items : []).forEach(x => {
        if (!x || !String(x.q || '').trim() || !String(x.a == null ? '' : x.a).trim()) return;
        // 여러 장을 나눠 읽을 때 같은 번호·같은 답이 또 나오면 한 번만
        if (items.some(y => normQ(y.q) === normQ(x.q) && String(y.a).trim() === String(x.a).trim())) return;
        items.push(x);
      });
      if (out && out.note) notes.push(String(out.note));
    }
    if (!items.length) throw {mine: true, message: '답지에서 문항을 찾지 못했어요 — 답이 보이게 다시 찍어 주세요'};
    const text = (title ? '# 제목: ' + title + '\n' : '') + items.map(x => String(x.q).trim().replace(/\s+/g, '') + ' ' + String(x.a).trim().replace(/\s*\n\s*/g, ' ')).join('\n');
    if (p.key.trim() && p.key.trim() !== text.trim()) p.prevKey = p.key;
    p.key = text;
    const unsure = items.filter(x => x.sure === false).map(x => String(x.q).trim());
    p.note = '✓ ' + items.length + '문항을 읽었어요 — 번호와 답을 한 번 봐 주세요' + (unsure.length ? ' · 확실하지 않은 답: ' + unsure.slice(0, 12).join(', ') : '') + (notes.length ? ' · ' + notes.join(' ') : '');
    p.open = true;
  } catch (e) {
    p.note = '✗ ' + errText(e);
  }
  p.busy = false;
  renderParts(); renderRun(); save();
}
function toggleSubj(name) {
  const i = S.sel.indexOf(name);
  if (i >= 0) S.sel.splice(i, 1);
  else { S.sel.push(name); part(name); }
  const order = subjList().map(s => s.name);
  S.sel.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  store.set('g5g:lastsel', S.sel);
  renderParts(); renderRun(); save();
}

/* ───────── 3. 숙제 파일 ───────── */
async function onHwFiles(list) {
  const add = Array.from(list || []);
  if (!add.length) return;
  const fresh = [];
  for (const f of add) {
    const it = {file: f, kind: isPdf(f) ? 'pdf' : 'img', n: 1};
    if (it.kind === 'pdf') { try { it.doc = await openPdf(f); it.n = it.doc.numPages; } catch (e) { toast(f.name + ': PDF를 열지 못했어요', 'bad'); continue; } }
    else if (!/^image\//.test(f.type || '') && !/\.(jpe?g|png|webp|gif|bmp)$/i.test(f.name || '')) { toast(f.name + ': PDF나 사진만 올릴 수 있어요', 'bad'); continue; }
    fresh.push(it);
  }
  if (!fresh.length) return;
  const total = fresh.reduce((s, f) => s + f.n, 0);
  // 지난 채점을 이어서 볼 때: 쪽 수가 같으면 결과는 그대로 두고 파일만 붙임
  if (!S.files.length && S.pages.length && S.pages.length === total) {
    S.files = fresh; S.filesMeta = null;
    renderAll();
    toast('숙제 파일을 다시 붙였어요 — 사진이 보이고, 남은 쪽도 채점할 수 있어요', 'ok');
    return;
  }
  if (S.pages.length && S.pages.some(p => p.st === 'ok' || p.st === 'err')) {
    if (S.run && S.run.active) { toast('채점 중에는 파일을 바꿀 수 없어요 — 먼저 멈춰 주세요', 'warn'); return; }
    if (!(await ask('새 숙제로 채점할까요?', '<p>지금 채점 결과(' + S.pages.length + '쪽)는 지워져요. 엑셀로 저장했는지 먼저 확인해 주세요.</p>', '새로 시작'))) return;
    S.files = [];
    S.pages.forEach(p => { if (p.url) URL.revokeObjectURL(p.url); });
    S.pages = []; S.job = null; S.assign = {}; S.passign = {}; S.toggles = {}; S.rename = {}; S.rot = {}; S.sel1 = ''; S.cost = 0; S.run = null;
  }
  if (S.job && S.run && S.run.active) { toast('채점 중에는 파일을 더할 수 없어요', 'warn'); return; }
  S.files = S.files.concat(fresh); S.filesMeta = null;
  const n = S.files.reduce((s, f) => s + f.n, 0);
  while (S.pages.length < n) S.pages.push({st: 'wait'});
  renderAll(); save();
}
function removeFile(i) {
  if (S.job) return;
  S.files.splice(i, 1);
  S.pages = []; const n = S.files.reduce((s, f) => s + f.n, 0);
  for (let k = 0; k < n; k++) S.pages.push({st: 'wait'});
  renderAll(); save();
}
function pageSrc(i) { let k = i; for (const f of S.files) { if (k < f.n) return {f: f, n: k + 1}; k -= f.n; } return null; }
async function pageBlob(i) {
  const p = S.pages[i];
  if (p.blob) return p.blob;
  const src = pageSrc(i);
  if (!src) throw {code: 'no_file'};
  let c;
  if (src.f.kind === 'pdf') { if (!src.f.doc) src.f.doc = await openPdf(src.f.file); c = await renderPdfPage(src.f.doc, src.n); }
  else c = await renderImageFile(src.f.file);
  p.blob = await finishCanvas(c);
  p.url = URL.createObjectURL(p.blob);
  return p.blob;
}

/* ───────── 4. 채점 ───────── */
function gradePrompt(a, b, total, force) {
  const parts = S.job.parts, roster = S.job.roster;
  const ctx = parts.map(p => {
    const t = keyTitle(p.key);
    const lines = String(p.key || '').split(/\r?\n/).filter(l => l.trim() && l.trim().charAt(0) !== '#').join('\n');
    return '[' + p.id + '] ' + p.name + (t ? ' · 제목: ' + t : '') + '\n선생님 채점 규칙: ' + (p.rules ? p.rules : '없음 (기본 규칙대로)') + '\n정답지 (번호 정답):\n' + lines;
  }).join('\n\n');
  const hints = [];
  for (let i = a; i <= b; i++) if (force[i - a]) { const fp = parts.find(x => x.id === force[i - a]); if (fp) hints.push('The teacher says page ' + (i + 1) + ' belongs to [' + fp.id + '] ' + fp.name + ': use part "' + fp.id + '" and its answer key for that page.'); }
  const n = b - a + 1;
  return [
    'You grade scanned homework and quizzes for an English academy in Korea (grade 5 students).',
    'The ' + n + ' image' + (n > 1 ? 's are pages ' + (a + 1) + '–' + (b + 1) : ' is page ' + (a + 1)) + ' of ' + total + ' scanned pages, in order (image 1 = page ' + (a + 1) + ').',
    'Each student usually has a bundle: pages of several different assignments one after another, and question numbers restart in every assignment. A student writes the name on the first page of an assignment; a page without a name usually continues the previous page.',
    '',
    'For EACH image return one object:',
    '- page: its page number given above.',
    '- name_on_page: the student name written on the page, copied exactly ("" if none).',
    '- roster_name: the exact roster entry below that this student is (match Korean or English names; ignore suffixes like 주1, (T), *, digits), "" if unsure or no roster.',
    '- continues_previous: true when the page has no name and continues the previous page of the same student.',
    '- part: the id (in square brackets below) of the assignment this page belongs to — decide from the printed title, the kind of questions and the answer keys. A page without a title usually continues the assignment of the previous page (pick the one whose key has those question numbers and fits the subject). "none" for a blank page or a page that is none of them; "" only if you really cannot tell.',
    '- upside_down: true if the image is upside down or sideways (backs of double-sided sheets often are). Read it in the right orientation either way.',
    '- items: one item for every question of that assignment\'s key that appears on this page: {"q": the label exactly as in the key, "read": the student\'s own answer exactly as written (keep their spelling; "" if left blank; for multiple choice the option(s) they chose; for a table row the cells joined with " - "), "correct": judged against the key and the rules, "sure": false if the handwriting is unclear, the answer is only partly right, or the key/rules do not clearly decide it, "note": a short Korean note for the teacher when sure is false or a mistake is worth pointing out (e.g. "철자 1자 틀림: recieve"), otherwise ""}. A key line can stand for a whole table row: then the row is one item, correct only if every cell is right unless the rules say otherwise. Answers separated by " / " in the key are all accepted. No items when part is "none" or "".',
    '- page_note: a short Korean note if the page is blank, not homework, cut off or unreadable; otherwise "".',
    'Ignore teacher marks (red or colored pen, check marks, circles, X marks, corrections, scores): judge only what the student wrote.',
    'Default rules unless the teacher\'s rules say otherwise: spelling must be exact; capitalization and a missing final period do not matter; for sentence answers the meaning and the grammar point being tested must be right.',
    hints.join('\n'),
    '',
    '이번 숙제 (id는 [ ] 안):',
    ctx,
    '',
    '반 명단 (원생명): ' + (roster.length ? roster.map(r => r.name).join(', ') : '없음'),
    '',
    'Reply with only one JSON object {"pages": [...]} holding ' + n + ' object' + (n > 1 ? 's' : '') + ' in page order, like: {"pages": [{"page": ' + (a + 1) + ', "name_on_page": "Irene 최유나", "roster_name": "", "continues_previous": false, "part": "' + (parts[0] ? parts[0].id : 'voctest') + '", "upside_down": false, "items": [{"q": "1", "read": "③", "correct": true, "sure": true, "note": ""}], "page_note": ""}]}'
  ].join('\n');
}
function cleanRes(r, force) {
  const items = (Array.isArray(r.items) ? r.items : []).filter(it => it && it.q != null && String(it.q).trim()).map(it => ({
    q: String(it.q).trim(), read: String(it.read == null ? '' : it.read), correct: it.correct === true, sure: it.sure !== false, note: String(it.note || '')}));
  return {name_on_page: String(r.name_on_page || '').trim(), roster_name: String(r.roster_name || '').trim(), continues_previous: r.continues_previous === true,
    part: force || String(r.part == null ? '' : r.part).trim().replace(/^\[|\]$/g, ''), upside_down: r.upside_down === true, items: items, page_note: String(r.page_note || '')};
}
function readyProblems() {
  const out = [];
  if (!aiReady()) out.push(errText({code: notReadyCode()}));
  if (!S.sel.length) out.push('채점할 숙제를 하나 이상 골라 주세요 (2번)');
  S.sel.forEach(n => { if (!keyItems(part(n).key).length) out.push(n + ' 정답지가 비어 있어요 (2번)'); });
  if (!S.pages.length) out.push('학생 숙제 파일을 올려 주세요 (3번)');
  return out;
}
function startRun() {
  if (S.run && S.run.active) return;
  if (!S.job) {
    const probs = readyProblems();
    if (probs.length) { toast(probs[0], 'bad'); return; }
  }
  if (!aiReady()) { toast(errText({code: notReadyCode()}), 'bad'); return; }
  if (!S.files.length && S.pages.some(p => p.st === 'wait')) { toast(errText({code: 'no_file'}), 'bad'); return; }
  if (!S.job) {
    S.job = {parts: S.sel.map(n => { const p = part(n); return {id: p.id, name: n, key: p.key, rules: p.rules}; }),
      roster: S.xl ? S.xl.roster.map(r => ({sid: r.sid, name: r.name, ko: r.ko, en: r.en})) : []};
  }
  S.run = {active: true, paused: false, ctls: new Set(), inflight: 0, msg: ''};
  renderParts(); renderRun();
  pump();
}
function takeGroup() {
  const n = S.pages.length, per = perCall(false);
  const i = S.pages.findIndex(p => p.st === 'wait');
  if (i < 0) return null;
  const g = [i];
  const alone = p => p.force || p.solo;
  if (!alone(S.pages[i])) for (let k = i + 1; k < n && g.length < per && S.pages[k].st === 'wait' && !alone(S.pages[k]); k++) g.push(k);
  g.forEach(k => { S.pages[k].st = 'busy'; });
  return g;
}
function pump() {
  const run = S.run;
  if (!run || !run.active || run.paused) { renderRun(); return; }
  const conc = AI.mode === 'claude' ? 2 : 3;
  while (run.active && !run.paused && run.inflight < conc) {
    const g = takeGroup();
    if (!g) break;
    run.inflight++;
    runGroup(g, run).finally(() => {
      run.inflight--;
      save(); renderRun(); renderReview(true);
      if (run.active && !run.paused) pump();
    });
  }
  if (run.active && !run.inflight && !S.pages.some(p => p.st === 'wait' || p.st === 'busy')) finishRun();
  renderRun();
}
async function runGroup(idx, run) {
  const ctl = new AbortController();
  run.ctls.add(ctl);
  try {
    const blobs = [];
    for (const i of idx) blobs.push(await pageBlob(i));
    const out = await aiJson(gradePrompt(idx[0], idx[idx.length - 1], S.pages.length, idx.map(i => S.pages[i].force || '')), blobs, ctl.signal);
    const arr = Array.isArray(out) ? out : out && Array.isArray(out.pages) ? out.pages : out && typeof out === 'object' && idx.length === 1 && out.items ? [out] : null;
    if (!arr) throw {code: 'invalid_json'};
    idx.forEach((i, k) => {
      const r = arr.find(x => x && Number(x.page) === i + 1) || arr[k];
      const p = S.pages[i];
      if (!r || typeof r !== 'object') { p.st = 'err'; p.err = 'AI 답에 이 쪽이 없어요'; return; }
      p.res = cleanRes(r, p.force); p.st = 'ok'; p.err = '';
    });
  } catch (e) {
    const code = e && e.code;
    if (ctl.signal.aborted || code === 'cancelled') { idx.forEach(i => { if (S.pages[i].st === 'busy') S.pages[i].st = 'wait'; }); return; }
    if (code === 'rate_limited') { idx.forEach(i => { S.pages[i].st = 'wait'; }); run.paused = true; run.msg = errText(e); return; }
    if (FATAL[code] || code === 'no_file') { idx.forEach(i => { S.pages[i].st = 'wait'; }); run.msg = errText(e); stopRun(true); return; }
    // 답이 길어 잘렸을 수 있음 → 한 쪽씩 다시
    if ((code === 'invalid_json' || code === 'empty_completion') && idx.length > 1) { idx.forEach(i => { S.pages[i].st = 'wait'; S.pages[i].solo = true; }); return; }
    idx.forEach(i => { S.pages[i].st = 'err'; S.pages[i].err = errText(e); });
  } finally { run.ctls.delete(ctl); }
}
function stopRun(keepMsg) {
  const run = S.run;
  if (!run) return;
  run.active = false;
  run.ctls.forEach(c => { try { c.abort(); } catch (e) { /* 무시 */ } });
  S.pages.forEach(p => { if (p.st === 'busy') p.st = 'wait'; });
  if (!keepMsg) run.msg = '멈췄어요 — [이어서 채점]으로 남은 쪽을 계속해요';
  renderRun(); save();
}
function finishRun() {
  const run = S.run;
  if (!run || !run.active) return;
  run.active = false;
  const err = S.pages.filter(p => p.st === 'err').length;
  run.msg = '채점이 끝났어요' + (err ? ' — 못 읽은 쪽 ' + err + '개는 [못 읽은 쪽 다시]로 다시 해 보세요' : ' — 5번에서 확인하고 엑셀로 저장해요');
  renderRun(); renderReview(true); saveNow();
  toast(run.msg, err ? 'warn' : 'ok');
}
function resumeRun() { if (S.run && S.run.active && S.run.paused) { S.run.paused = false; S.run.msg = ''; pump(); return; } S.run = null; startRun(); }
function retryErr() {
  if (!S.files.length) { toast(errText({code: 'no_file'}), 'bad'); return; }
  S.pages.forEach(p => { if (p.st === 'err') { p.st = 'wait'; p.err = ''; p.solo = true; } });
  if (!(S.run && S.run.active)) { S.run = null; startRun(); } else pump();
}
function repage(i) {
  const pidv = S.passign[i];
  if (!pidv || pidv === 'none') return;
  if (!pageSrc(i)) { toast(errText({code: 'no_file'}), 'bad'); return; }
  if (!aiReady()) { toast(errText({code: notReadyCode()}), 'bad'); return; }
  const p = S.pages[i];
  p.st = 'wait'; p.force = pidv; p.res = null; p.err = '';
  delete S.passign[i];
  if (!(S.run && S.run.active)) { S.run = null; startRun(); } else pump();
  renderReview(); save();
  toast((i + 1) + '쪽을 고른 숙제의 정답지로 다시 읽어요');
}

/* ───────── 5. 확인 · 엑셀 ───────── */
async function exportXlsx() {
  if (!S.job) { toast('먼저 채점해 주세요', 'bad'); return; }
  const gs = groupsNow(), hasRoster = S.job.roster.length > 0;
  const named = gs.filter(g => g.sid && g.list.length), unk = gs.filter(g => !g.sid && g.owner !== 'skip' && g.list.length);
  const colsOf = g => { const c = {}; g.list.forEach(x => { c[x.name] = x.score; }); return c; };
  const left = gs.filter(g => g.owner !== 'skip').reduce((s, g) => s + g.check, 0);
  const msg = [];
  if (left) msg.push('아직 확인하지 않은 칸이 ' + left + '개 있어요 — AI가 읽은 대로 들어가요.');
  let base = null, scores = null, rows = null;
  if (S.xl && hasRoster) {
    if (!named.length) { toast('반 명단과 맞춘 학생이 없어요 — 명단에서 못 찾은 묶음에서 학생을 골라 주세요', 'bad'); return; }
    if (unk.length) msg.push('명단에서 못 찾은 묶음 ' + unk.length + '개는 엑셀에 들어가지 않아요: ' + unk.map(displayName).slice(0, 5).join(', '));
    scores = {};
    named.forEach(g => { scores[g.sid] = colsOf(g); });
    base = S.xl.bytes;
  } else {
    if (!unk.length) { toast('저장할 점수가 없어요', 'bad'); return; }
    if (!S.xl) msg.push('반 엑셀 없이 저장하면 원생코드 칸이 비어요. 학원 프로그램에 바로 올리려면 1번에 반 엑셀을 넣고 저장해 주세요.');
    rows = unk.map(g => ({name: displayName(g), cols: colsOf(g)}));
    base = S.xl ? S.xl.bytes : null;
  }
  if (msg.length && !(await ask('엑셀로 저장할까요?', msg.map(m => '<p>' + esc(m) + '</p>').join(''), '저장'))) return;
  let res;
  try { res = await xlBuild(base || await makeTemplate(), scores, rows); }
  catch (e) { toast('엑셀을 만들지 못했어요: ' + (e.message || errText(e)), 'bad'); return; }
  if (res.lost.length) toast('엑셀에 ' + res.lost.join(', ') + ' 칸이 없어서 그 점수는 빠졌어요', 'warn');
  const fname = (S.xl ? S.xl.name.replace(/\.xlsx$/i, '') : 'Subject_' + todayYmd()) + '_채점.xlsx';
  await saveFile(fname, res.data, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', res.changed + '명 점수를 넣은 엑셀');
}
async function saveFile(fname, data, mime, what) {
  const blob = new Blob([data], {type: mime});
  if (AI.dl) {
    try { await AI.dl.save({filename: fname, data: blob}); toast(what + ' — ' + fname, 'ok'); }
    catch (e) {
      if (e && e.code === 'declined') return;
      toast('파일을 내려받지 못했어요' + (e && e.code ? ' (' + e.code + ')' : '') + ' — [결과 표 복사]를 써 주세요', 'bad');
    }
    return;
  }
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = fname; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast(what + ' — ' + fname + (AI.inClaude ? ' (안 받아지면 [결과 표 복사]를 써 주세요)' : ''), 'ok');
}
async function copyTsv() {
  if (!S.job) return;
  const gs = groupsNow().filter(g => g.owner !== 'skip' && g.list.length), parts = S.job.parts;
  const lines = [['원생명'].concat(parts.map(p => p.name)).join('\t')].concat(gs.map(g => [displayName(g)].concat(parts.map(p => { const x = g.list.find(y => y.pid === p.id); return x ? x.score : ''; })).join('\t')));
  try { await navigator.clipboard.writeText(lines.join('\n')); toast('결과 표를 복사했어요 — 엑셀에 붙여넣으면 돼요', 'ok'); }
  catch (e) { toast('복사하지 못했어요', 'bad'); }
}

/* ───────── 그리기 ───────── */
function modeChip() {
  const m = AI.mode;
  if (m === 'claude') return '<span class="chip-mode ok" title="Claude 안에서 열어 내 Claude 사용량으로 채점해요">Claude로 채점 · ' + (S.tier === 'quick' ? '빠르게' : '정확하게') + '</span>';
  if (m === 'api') return '<span class="chip-mode ok">내 API 키로 채점 · ' + (S.tier === 'quick' ? 'Haiku' : 'Sonnet') + '</span>';
  if (m === 'needkey') return '<button type="button" class="chip-mode warn" data-act="settings">API 키를 넣어 주세요</button>';
  if (m === 'wait') return '<span class="chip-mode">연결 확인 중…</span>';
  if (m === 'noimg') return '<span class="chip-mode bad">이 화면은 사진을 보낼 수 없어요</span>';
  return '<button type="button" class="chip-mode bad" data-act="settings">Claude에 연결되지 않았어요 · API 키로 쓰기</button>';
}
function renderTop() { $('#mode').innerHTML = modeChip(); }
function renderSteps() {
  const keysOk = S.sel.length > 0 && S.sel.every(n => keyItems(part(n).key).length > 0);
  const n = S.pages.length;
  [['#s1', !!S.xl], ['#s2', keysOk || !!S.job], ['#s3', n > 0], ['#s4', !!S.job && n > 0 && S.pages.every(p => p.st === 'ok')]].forEach(x => { const el = $(x[0]); if (el) el.classList.toggle('done', !!x[1]); });
}
function renderXl() {
  const el = $('#s1-body');
  if (!S.xl) {
    el.innerHTML = '<label class="drop" for="xl-in"><input type="file" id="xl-in" accept=".xlsx" class="vh"><b>반 성적 엑셀 고르기</b><span>학원 프로그램에서 내려받은 Subject 엑셀(.xlsx) — 학생 명단과 과목 칸을 그대로 써요</span></label>'
      + '<p class="hint">엑셀 없이도 채점할 수 있어요. 그때는 종이에 적힌 이름으로 같은 형식의 새 엑셀을 만들어요 (원생코드는 빈칸).</p>';
  } else {
    const r = S.xl.roster;
    el.innerHTML = '<div class="xl-card"><div class="xl-main"><b>' + esc(S.xl.name) + '</b><span class="muted">학생 ' + r.length + '명 · 과목 칸 ' + S.xl.subj.length + '개</span></div>'
      + '<label class="btn ghost sm" for="xl-in"><input type="file" id="xl-in" accept=".xlsx" class="vh">다른 엑셀</label></div>'
      + (r.length ? '<div class="roster">' + r.map(x => '<span>' + esc(x.name) + '</span>').join('') + '</div>' : '<p class="hint">이 엑셀에는 학생이 없어요 — 종이에 적힌 이름으로 줄을 만들어 저장해요.</p>');
  }
  renderSteps();
}
function kheadHtml(n) {
  const p = part(n), items = keyItems(p.key), dups = keyDups(p.key), title = keyTitle(p.key);
  return '<b>' + esc(n) + '</b><span class="' + (items.length ? 'okt' : 'muted') + '">' + (items.length ? '정답지 ' + items.length + '문항' : '정답지 없음') + '</span>'
    + (dups.length ? '<span class="badt">같은 번호 ' + esc(dups.slice(0, 3).join(', ')) + (dups.length > 3 ? ' 외' : '') + ' — 처음 것만 채점해요</span>' : '')
    + (title ? '<span class="muted ttl">' + esc(title) + '</span>' : '');
}
function renderParts() {
  const el = $('#s2-body'), subj = subjList(), lock = !!S.job;
  let h = '<div class="chips" role="group" aria-label="채점할 숙제">' + subj.map(s => {
    const on = S.sel.indexOf(s.name) >= 0;
    return '<button type="button" class="chip' + (on ? ' on' : '') + (RARE_SUBJ[s.name] && !on ? ' rare' : '') + '" aria-pressed="' + on + '" data-act="subj" data-name="' + esc(s.name) + '"' + (lock ? ' disabled' : '') + '>' + esc(s.name) + '</button>';
  }).join('') + '</div>';
  if (!S.sel.length) h += '<p class="hint">이번 숙제 묶음에 든 숙제를 모두 고르세요. 숙제마다 답지를 올리면 AI가 정답지로 바꿔 줘요.</p>';
  if (lock) h += '<p class="hint">채점을 시작해서 숙제와 정답지는 잠겼어요. 바꾸려면 4번의 [처음부터]로 새로 시작해 주세요.</p>';
  h += S.sel.map(n => {
    const p = part(n), items = keyItems(p.key), id = p.id;
    return '<div class="kcard' + (items.length ? ' ok' : '') + '"><div class="khead">' + kheadHtml(n) + '</div>'
      + (lock ? '' :
        '<div class="kacts"><label class="btn ' + (items.length ? 'ghost' : 'primary') + ' sm' + (p.busy ? ' busy' : '') + '" for="kf-' + id + '"><input type="file" id="kf-' + id + '" accept="image/*,application/pdf" multiple class="vh" data-key="' + esc(n) + '"' + (p.busy ? ' disabled' : '') + '>' + (p.busy ? '읽는 중…' : items.length ? '답지 다시 올리기' : '답지 올리기') + '</label>'
        + '<button type="button" class="btn ghost sm" data-act="kopen" data-name="' + esc(n) + '" aria-expanded="' + !!p.open + '">' + (p.open ? '정답지 접기' : '정답지 보기·고치기') + '</button>'
        + (p.prevKey != null && !p.busy ? '<button type="button" class="linkb" data-act="undo" data-name="' + esc(n) + '">이전 정답지로 되돌리기</button>' : '') + '</div>')
      + (p.note && !lock ? '<p class="knote' + (p.note.charAt(0) === '✗' ? ' bad' : '') + '">' + esc(p.note) + '</p>' : '')
      + (p.open && !lock ? '<label class="lbl" for="kt-' + id + '">정답지 — 한 줄에 “번호 정답” · 맨 위 “# 제목: …” · 여러 정답은 “ / ” · 배점은 “(2점)”</label>'
        + '<textarea id="kt-' + id + '" class="ktext" rows="10" spellcheck="false" data-ktext="' + esc(n) + '">' + esc(p.key) + '</textarea>' : '')
      + (lock ? '' : '<label class="lbl" for="kr-' + id + '">채점 규칙 (이 숙제만 · 다음에도 기억해요)</label><textarea id="kr-' + id + '" class="krule" rows="2" data-krule="' + esc(n) + '" placeholder="예: 철자 하나 틀리면 오답">' + esc(p.rules) + '</textarea>')
      + '</div>';
  }).join('');
  el.innerHTML = h;
  renderSteps();
}
function renderFiles() {
  const el = $('#s3-body'), n = S.pages.length;
  let h = '';
  if (!S.files.length && S.filesMeta && S.filesMeta.length) h += '<div class="note warn">지난 채점의 숙제 파일: ' + esc(S.filesMeta.map(f => f.name + ' (' + f.n + '쪽)').join(', ')) + ' — 사진을 보거나 남은 쪽을 채점하려면 같은 파일을 다시 골라 주세요.</div>';
  h += '<label class="drop" for="hw-in"><input type="file" id="hw-in" accept="image/*,application/pdf" multiple class="vh"><b>숙제 PDF·사진 고르기</b><span>반 전체를 복사기로 스캔한 PDF 하나가 제일 좋아요 · 학생마다 숙제 묶음을 차례로</span></label>';
  if (S.files.length) h += '<div class="files">' + S.files.map((f, i) => '<span class="file">' + esc(f.file.name) + ' <b>' + f.n + '쪽</b>' + (S.job ? '' : '<button type="button" class="x" aria-label="' + esc(f.file.name) + ' 빼기" data-act="rmfile" data-i="' + i + '">✕</button>') + '</span>').join('') + '</div>';
  if (n) {
    const calls = Math.ceil(n / perCall(false));
    h += '<p class="est">모두 <b>' + n + '쪽</b> · ' + (AI.mode === 'api' ? '예상 약 $' + (n * (S.tier === 'quick' ? 0.002 : 0.012)).toFixed(2) + ' (API 크레딧)' : 'Claude에게 약 ' + calls + '번 물어봐요 (내 Claude 사용량)')
      + ' · 약 ' + Math.max(1, Math.round(calls * (S.tier === 'quick' ? 10 : 40) / (AI.mode === 'claude' ? 2 : 3) / 60)) + '분</p>';
  }
  h += '<p class="hint">이름은 숙제마다 첫 쪽에만 있어도 돼요. 거꾸로 스캔된 뒷장도 괜찮고, 선생님 빨간 펜 표시는 빼고 학생 글씨만 봐요.</p>';
  el.innerHTML = h;
  renderSteps();
}
function renderRun() {
  const el = $('#s4-body');
  if (!el) return;
  const n = S.pages.length, done = S.pages.filter(p => p.st === 'ok').length, err = S.pages.filter(p => p.st === 'err').length, busy = S.pages.filter(p => p.st === 'busy').length;
  const run = S.run, active = run && run.active, paused = active && run.paused;
  const probs = S.job ? [] : readyProblems();
  let h = '';
  if (!S.job && probs.length) h += '<ul class="todo">' + probs.map(p => '<li>' + esc(p) + '</li>').join('') + '</ul>';
  if (n && (S.job || !probs.length)) {
    const pct = Math.round((done + err) / n * 100);
    h += '<div class="prog" role="progressbar" aria-label="채점한 쪽" aria-valuemin="0" aria-valuemax="' + n + '" aria-valuenow="' + (done + err) + '"><i style="width:' + pct + '%"></i></div>'
      + '<p class="progt"><b>' + done + '</b> / ' + n + '쪽 채점' + (busy ? ' · 읽는 중 ' + busy + '쪽' : '') + (err ? ' · <span class="badt">못 읽은 쪽 ' + err + '</span>' : '') + (AI.mode === 'api' && S.cost ? ' · 지금까지 약 $' + S.cost.toFixed(3) : '') + '</p>';
  }
  if (run && run.msg) h += '<p class="runmsg' + (paused || /못|않|끊|한도|허용|연결/.test(run.msg) ? ' warn' : '') + '">' + esc(run.msg) + '</p>';
  const acts = [];
  if (active && !paused) acts.push('<button type="button" class="btn ghost" data-act="stop">멈추기</button>');
  else if (S.job && S.pages.some(p => p.st === 'wait')) acts.push('<button type="button" class="btn primary" data-act="resume">이어서 채점</button>');
  else if (!S.job) acts.push('<button type="button" class="btn primary" data-act="start"' + (probs.length ? ' disabled' : '') + '>채점 시작</button>');
  if (!active && err) acts.push('<button type="button" class="btn ghost" data-act="retry">못 읽은 쪽 다시</button>');
  if (S.job && !active) acts.push('<button type="button" class="btn ghost" data-act="reset">처음부터</button>');
  h += '<div class="acts">' + acts.join('') + '</div>';
  if (!S.job && !probs.length) h += '<p class="hint">' + (AI.mode === 'claude' ? '처음 한 번은 Claude가 이 페이지에서 쓸지 물어봐요 — 허용을 눌러 주세요. ' : '') + '채점하는 동안 이 페이지를 열어 두세요. 닫았다 열어도 결과는 이 브라우저에 남아요.</p>';
  el.innerHTML = h;
  renderSteps();
}
function pcChips(g) {
  return g.list.map(x => '<span class="pc' + (x.unsure || x.missing ? ' chk' : '') + '">' + esc(x.name) + ' <b>' + x.score + '</b></span>').join('')
    + (g.unpart.length ? '<span class="pc chk">숙제 못 가린 쪽 ' + g.unpart.length + '</span>' : '');
}
function ownerOptions(cur, groups) {
  const roster = (S.job ? S.job.roster : []).slice().sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  const unks = groups.filter(g => !g.sid && g.owner !== 'skip' && g.owner !== 'unk:');
  const known = cur === 'skip' || roster.some(r => cur === 'sid:' + r.sid) || unks.some(g => g.owner === cur);
  return (known ? '' : '<option value="" selected>누구 숙제인지 고르기…</option>')
    + (roster.length ? '<optgroup label="반 명단">' + roster.map(r => '<option value="' + esc(r.sid) + '"' + (cur === 'sid:' + r.sid ? ' selected' : '') + '>' + esc(r.name) + '</option>').join('') + '</optgroup>' : '')
    + (unks.length ? '<optgroup label="종이에 적힌 이름">' + unks.map(g => '<option value="' + esc(g.owner) + '"' + (cur === g.owner ? ' selected' : '') + '>' + esc(displayName(g)) + '</option>').join('') + '</optgroup>' : '')
    + '<option value="skip"' + (cur === 'skip' ? ' selected' : '') + '>(채점 안 함)</option>';
}
function partOptions(cur) {
  const ps = S.job.parts, known = cur === 'none' || ps.some(p => p.id === cur);
  return (known ? '' : '<option value="" selected>어느 숙제인지 고르기…</option>')
    + ps.map(p => '<option value="' + esc(p.id) + '"' + (p.id === cur ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('')
    + '<option value="none"' + (cur === 'none' ? ' selected' : '') + '>(숙제 아님 · 빈 쪽)</option>';
}
function partName(id) { const p = S.job.parts.find(x => x.id === id); return p ? p.name : ''; }
function detailHtml(g, groups) {
  const multi = S.job.parts.length > 1, unk = !g.sid && g.owner !== 'skip';
  let h = '<div class="dh"><b>' + esc(g.owner === 'skip' ? '채점 안 하는 쪽' : displayName(g)) + '</b>'
    + (unk ? '<label class="ren">엑셀에 넣을 이름 <input type="text" value="' + esc(displayName(g)) + '" data-rename="' + esc(g.owner) + '"></label>' : '')
    + (g.unsure || g.missing ? '<button type="button" class="btn ghost sm" data-act="acceptall" data-owner="' + esc(g.owner) + '">노란 칸 AI대로 확인</button>' : '') + '</div>';
  if (g.owner !== 'skip') {
    g.list.forEach(x => {
      h += '<div class="ph"><b>' + esc(x.name) + '</b><span class="big">' + x.score + '</span><span class="muted">' + x.right + '/' + x.total + ' 맞음'
        + (x.unsure ? ' · 확인 ' + x.unsure : '') + (x.missing ? ' · 못 찾음 ' + x.missing : '') + ' · ' + x.pages.map(i => i + 1).join(', ') + '쪽</span></div>'
        + '<div class="grid">' + x.rows.map(r => {
          const miss = r.read == null && !r.set;
          return '<button type="button" class="gi ' + (r.ok ? 'ok' : 'ng') + (r.flag ? ' flag' : '') + (miss ? ' miss' : '') + '" data-act="tog" data-owner="' + esc(g.owner) + '" data-pid="' + esc(x.pid) + '" data-nq="' + esc(r.nq) + '" aria-label="' + esc(r.q + '번 ' + (r.ok ? '맞음' : '틀림') + (r.flag ? ', 확인 필요' : '')) + '">'
            + '<span class="q">' + esc(r.q) + '</span><span class="r">' + esc(r.read == null ? '(못 찾음)' : (r.read || '(빈칸)')) + '</span><span class="m" aria-hidden="true">' + (r.ok ? '✓' : '✗') + '</span>'
            + ((!r.ok || r.flag || miss) ? '<span class="a">정답 ' + esc(r.a) + (r.w !== 1 ? ' (' + r.w + '점)' : '') + '</span>' : '')
            + (r.note ? '<span class="n">' + esc(r.note) + '</span>' : '') + '</button>';
        }).join('') + '</div>';
    });
    if (g.unpart.length) h += '<div class="note warn">어느 숙제인지 못 가린 쪽: ' + g.unpart.map(i => i + 1).join(', ') + '쪽 — 아래 사진 위 칸에서 숙제를 골라 주세요</div>';
    if (!g.list.length && !g.unpart.length) h += '<p class="muted">채점할 문항이 없는 쪽이에요</p>';
  }
  h += '<div class="pages">' + g.pages.map(i => {
    const pg = S.pages[i] || {}, res = pg.res || {}, pp = g.pp[i] || '';
    const rot = !!res.upside_down !== !!S.rot[i];
    const note = res.page_note ? ' · ' + res.page_note : pg.st === 'err' ? ' · ⚠ ' + (pg.err || '못 읽음') : pg.st === 'wait' || pg.st === 'busy' ? ' · 채점 전' : '';
    const re = multi && pg.st === 'ok' && S.passign[i] && S.passign[i] !== 'none' && S.passign[i] !== res.part;
    return '<div class="pg"><div class="pgh"><span>' + (i + 1) + '쪽' + (multi && pp && pp !== 'none' ? ' · ' + esc(partName(pp)) : '') + esc(note) + (res.upside_down ? ' · 거꾸로 스캔' : '') + '</span>'
      + '<span class="pgs"><select aria-label="' + (i + 1) + '쪽은 누구 숙제" data-assign="' + i + '">' + ownerOptions(g.owner, groups) + '</select>'
      + (multi && g.owner !== 'skip' ? '<select aria-label="' + (i + 1) + '쪽은 어느 숙제"' + (pp ? '' : ' class="need"') + ' data-passign="' + i + '">' + partOptions(pp) + '</select>' : '')
      + '<button type="button" class="btn ghost sm" data-act="rot" data-i="' + i + '" aria-label="' + (i + 1) + '쪽 사진 돌리기">↻</button></span>'
      + (re ? '<div class="repage"><span>AI가 고른 숙제와 달라요 — ' + esc(partName(S.passign[i])) + ' 정답지로 이 쪽을 다시 읽어야 정확해요</span><button type="button" class="btn primary sm" data-act="repage" data-i="' + i + '">이 숙제로 다시 읽기</button></div>' : '')
      + '</div><div class="img' + (S.zoom ? ' zoom' : '') + (rot ? ' rot' : '') + '" id="img-' + i + '" data-act="zoom" title="눌러서 크게·작게">' + (pg.url ? '<img src="' + pg.url + '" alt="' + (i + 1) + '쪽">' : '<span class="muted">' + (pageSrc(i) ? '사진 만드는 중…' : '사진을 보려면 3번에서 숙제 파일을 다시 골라 주세요') + '</span>') + '</div></div>';
  }).join('') + '</div>';
  return h;
}
let imgWant = [], imgBusy = false;
async function loadImgs(pages) {
  imgWant = pages.slice();
  if (imgBusy) return;
  imgBusy = true;
  try {
    while (imgWant.length) {
      const i = imgWant.shift(), p = S.pages[i];
      if (!p || p.url || !pageSrc(i)) continue;
      try { await pageBlob(i); } catch (e) { continue; }
      const el = document.getElementById('img-' + i);
      if (el && p.url) el.innerHTML = '<img src="' + p.url + '" alt="' + (i + 1) + '쪽">';
    }
  } finally { imgBusy = false; }
}
function renderReview(auto) {
  const el = $('#s5-body');
  if (!el) return;
  const ae = document.activeElement;
  if (auto && ae && el.contains(ae) && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) { S.reviewDirty = true; return; }
  S.reviewDirty = false;
  if (!S.job || !S.pages.some(p => p.st === 'ok')) {
    el.innerHTML = '<p class="hint">채점이 끝나면 학생별·숙제별 점수가 여기에 나와요. 노란 칸(AI가 확신하지 못한 답)만 확인하고 엑셀로 저장하면 돼요.</p>'
      + '<div class="acts"><button type="button" class="btn primary" disabled>엑셀로 저장</button></div>';
    return;
  }
  const gs = groupsNow(), wide = window.matchMedia('(min-width: 1100px)').matches;
  const named = gs.filter(g => g.sid).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  const unk = gs.filter(g => !g.sid && g.owner !== 'skip'), skip = gs.find(g => g.owner === 'skip');
  const errPages = S.pages.map((p, i) => ({p: p, i: i})).filter(x => x.p.st === 'err');
  const roster = S.job.roster.length > 0;
  const check = named.reduce((s, g) => s + g.check, 0) + unk.reduce((s, g) => s + (roster ? 1 : g.check), 0);
  const avgs = S.job.parts.map(p => {
    const sc = []; (roster ? named : unk).forEach(g => g.list.forEach(x => { if (x.pid === p.id) sc.push(x.score); }));
    return sc.length ? '<span class="pc">' + esc(p.name) + ' 평균 <b>' + Math.round(sc.reduce((s, v) => s + v, 0) / sc.length) + '</b></span>' : '';
  }).join('');
  if (!S.sel1 || !gs.some(g => g.owner === S.sel1)) S.sel1 = wide ? ((roster ? unk[0] : null) || named.find(g => g.check) || named[0] || unk[0] || {}).owner || '' : S.sel1;
  let h = '<div class="sum"><span><b>' + (roster ? named.length : unk.length) + '명</b> 채점 · ' + (check ? '<span class="warnt">확인할 곳 ' + check + '</span>' : '확인할 곳 없음 ✓') + '</span>'
    + (avgs ? '<span class="pcs">' + avgs + '</span>' : '') + '</div>'
    + '<p class="legend"><i class="dot" aria-hidden="true"></i>노란 칸 = AI가 확신하지 못한 답 · 문항 칸을 누르면 ✓와 ✗가 바뀌어요</p>';
  if (roster) unk.forEach(g => {
    h += '<div class="ucard' + (S.sel1 === g.owner ? ' on' : '') + '"><div><b>명단에서 못 찾은 이름</b> ' + (g.name ? '“' + esc(g.name) + '”' : '(이름 없음)') + ' · ' + g.pages.map(i => i + 1).join(', ') + '쪽</div>'
      + '<div class="pcs">' + pcChips(g) + '</div>'
      + '<div class="uacts"><select aria-label="이 묶음은 누구 숙제" data-assigngroup="' + esc(g.owner) + '">' + ownerOptions('', gs) + '</select>'
      + '<button type="button" class="btn ghost sm" data-act="sel" data-owner="' + esc(g.owner) + '">쪽 보기</button></div>'
      + (!wide && S.sel1 === g.owner ? '<div class="det">' + detailHtml(g, gs) + '</div>' : '') + '</div>';
  });
  if (errPages.length) h += '<div class="note bad">못 읽은 쪽 ' + errPages.length + '개 (' + errPages.map(x => x.i + 1).join(', ') + '쪽) — ' + esc(errPages[0].p.err || '') + ' <button type="button" class="btn ghost sm" data-act="retry">다시 채점</button></div>';
  const list = roster ? named : unk;
  const row = g => '<button type="button" class="st' + (S.sel1 === g.owner ? ' on' : '') + '" data-act="sel" data-owner="' + esc(g.owner) + '" aria-expanded="' + (S.sel1 === g.owner) + '"><span class="nm">' + esc(displayName(g)) + '</span>'
    + '<span class="pcs">' + pcChips(g) + '</span>' + (g.check ? '<span class="cnt">확인 ' + g.check + '</span>' : '<span class="cnt ok">✓</span>') + '</button>'
    + (!wide && S.sel1 === g.owner ? '<div class="det">' + detailHtml(g, gs) + '</div>' : '');
  const have = {}; named.forEach(g => { have[g.sid] = 1; });
  const none = roster ? S.job.roster.filter(r => !have[r.sid]) : [];
  const tail = (none.length ? '<p class="muted none">숙제가 없는 학생 ' + none.length + '명 (엑셀 그대로 둬요): ' + esc(none.map(r => r.name).join(', ')) + '</p>' : '')
    + (skip ? '<p class="muted none">채점 안 하는 쪽: ' + skip.pages.map(i => i + 1).join(', ') + '쪽 <button type="button" class="linkb" data-act="sel" data-owner="skip">보기</button></p>' : '');
  const sel = gs.find(g => g.owner === S.sel1);
  if (wide) h += '<div class="split"><div class="list">' + list.map(row).join('') + tail + '</div><div class="side">' + (sel ? detailHtml(sel, gs) : '<p class="muted">왼쪽에서 학생을 누르면 문항과 사진이 보여요</p>') + '</div></div>';
  else h += '<div class="list">' + list.map(row).join('') + tail + (S.sel1 === 'skip' && skip ? '<div class="det">' + detailHtml(skip, gs) + '</div>' : '') + '</div>';
  h += '<div class="acts end"><button type="button" class="btn ghost" data-act="copy">결과 표 복사</button><button type="button" class="btn primary" data-act="export">엑셀로 저장 (' + (roster ? named.filter(g => g.list.length).length : unk.filter(g => g.list.length).length) + '명)</button></div>';
  const side = el.querySelector('.side'), sideY = side ? side.scrollTop : 0, y = window.scrollY;
  el.innerHTML = h;
  const side2 = el.querySelector('.side');
  if (side2) side2.scrollTop = sideY;
  window.scrollTo(0, y);
  if (sel) loadImgs(sel.pages);
}
function renderAll() { renderTop(); renderXl(); renderParts(); renderFiles(); renderRun(); renderReview(); }

/* ───────── 설정 ───────── */
function openSettings() {
  const d = $('#dlg'), key = apiKey(), showKey = !(AI.mode === 'claude' || (AI.inClaude && AI.mode === 'wait'));
  d.innerHTML = '<div class="dlg-box" role="dialog" aria-modal="true" aria-labelledby="set-t"><h3 id="set-t">설정</h3><div class="dlg-body">'
    + '<div class="setrow"><span class="lbl">채점 모델</span><div class="chips">'
    + '<button type="button" class="chip' + (S.tier !== 'quick' ? ' on' : '') + '" data-tier="default">정확하게 (Sonnet급)</button>'
    + '<button type="button" class="chip' + (S.tier === 'quick' ? ' on' : '') + '" data-tier="quick">빠르게 (Haiku급)</button></div>'
    + '<p class="muted">처음에는 정확하게로 선생님 점수와 비교해 보세요. 단어시험처럼 답이 짧으면 빠르게도 충분할 수 있어요.</p></div>'
    + '<div class="setrow"><span class="lbl">100점 환산</span><div class="chips">'
    + '<button type="button" class="chip' + (S.scoring !== 'round' ? ' on' : '') + '" data-scoring="floor">버림 (7/15 → 46)</button>'
    + '<button type="button" class="chip' + (S.scoring === 'round' ? ' on' : '') + '" data-scoring="round">반올림 (7/15 → 47)</button></div></div>'
    + (!showKey ? '<div class="setrow"><span class="lbl">AI 연결</span><p class="muted">Claude 안에서 열었으니 내 Claude 사용량으로 채점해요. API 키는 필요 없어요.</p></div>'
      : '<div class="setrow"><label class="lbl" for="api-in">내 Claude API 키</label><input type="password" id="api-in" autocomplete="off" spellcheck="false" placeholder="sk-ant-…" value="">'
        + '<p class="muted">' + (key ? '저장된 키: …' + esc(key.slice(-4)) + ' · ' : '') + '키는 이 브라우저에만 저장되고 Anthropic 말고는 어디에도 보내지 않아요. Claude Console(platform.claude.com) → API Keys에서 만들 수 있어요.</p>'
        + (key ? '<button type="button" class="btn ghost sm" id="api-del">이 브라우저에서 키 지우기</button>' : '') + '</div>')
    + '</div><div class="dlg-acts"><button type="button" class="btn primary" id="set-ok">닫기</button></div></div>';
  d.classList.add('open');
  d.onclick = e => {
    const t = e.target.closest('[data-tier],[data-scoring]');
    if (t) {
      if (t.dataset.tier) { S.tier = t.dataset.tier; store.set('g5g:tier', S.tier); }
      if (t.dataset.scoring) { S.scoring = t.dataset.scoring; store.set('g5g:scoring', S.scoring); }
      t.parentNode.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c === t));
      renderTop(); renderFiles(); renderReview();
      return;
    }
    if (e.target === d) closeSettings();
  };
  $('#set-ok').onclick = closeSettings;
  const del = $('#api-del');
  if (del) del.onclick = () => { store.del('g5g:apikey'); const inp = $('#api-in'); if (inp) inp.value = ''; closeSettings(); toast('키를 지웠어요'); };
  const inp = $('#api-in');
  if (inp) { inp.focus(); inp.onkeydown = e => { if (e.key === 'Enter') closeSettings(); }; }
}
function closeSettings() {
  const inp = $('#api-in');
  if (inp && inp.value.trim()) {
    const v = inp.value.trim();
    store.set('g5g:apikey', v);
    toast(/^sk-ant-/.test(v) ? 'API 키를 이 브라우저에 저장했어요' : 'API 키는 보통 sk-ant- 로 시작해요 — 다시 확인해 주세요', /^sk-ant-/.test(v) ? 'ok' : 'warn');
  }
  const d = $('#dlg'); d.classList.remove('open'); d.innerHTML = ''; d.onclick = null;
  if (AI.mode !== 'wait') AI.mode = pickMode();
  renderAll();
}

/* ───────── 누르기·고르기 ───────── */
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-act]');
  if (!t || t.disabled) return;
  const a = t.dataset.act;
  if (a === 'settings') openSettings();
  else if (a === 'subj') toggleSubj(t.dataset.name);
  else if (a === 'kopen') { const p = part(t.dataset.name); p.open = !p.open; renderParts(); }
  else if (a === 'undo') { const p = part(t.dataset.name); if (p.prevKey != null) { const cur = p.key; p.key = p.prevKey; p.prevKey = cur; p.note = '정답지를 바꿨어요'; renderParts(); renderRun(); save(); } }
  else if (a === 'rmfile') removeFile(Number(t.dataset.i));
  else if (a === 'start') startRun();
  else if (a === 'stop') stopRun();
  else if (a === 'resume') resumeRun();
  else if (a === 'retry') retryErr();
  else if (a === 'reset') {
    if (await ask('처음부터 새로 시작할까요?', '<p>채점 결과·숙제 파일·정답지가 지워져요. 반 엑셀과 채점 규칙은 남아요. 엑셀로 저장했는지 먼저 확인해 주세요.</p>', '새로 시작')) {
      const xl = S.xl, sel = S.sel.slice(); clearAll(); S.xl = xl; S.sel = sel; renderAll(); save();
    }
  }
  else if (a === 'sel') { S.sel1 = S.sel1 === t.dataset.owner && !window.matchMedia('(min-width: 1100px)').matches ? '' : t.dataset.owner; renderReview(); }
  else if (a === 'tog') {
    const g = groupsNow().find(x => x.owner === t.dataset.owner), x = g && g.list.find(y => y.pid === t.dataset.pid), r = x && x.rows.find(y => y.nq === t.dataset.nq);
    if (r) { S.toggles[t.dataset.owner + '|' + t.dataset.pid + '|' + t.dataset.nq] = !r.ok; renderReview(); save(); }
  }
  else if (a === 'acceptall') {
    const g = groupsNow().find(x => x.owner === t.dataset.owner);
    if (g) { g.list.forEach(x => x.rows.forEach(r => { if (r.flag || (r.read == null && !r.set)) S.toggles[g.owner + '|' + x.pid + '|' + r.nq] = r.ok; })); renderReview(); save(); }
  }
  else if (a === 'rot') { const i = Number(t.dataset.i); S.rot[i] = !S.rot[i]; renderReview(); }
  else if (a === 'zoom') { S.zoom = !S.zoom; renderReview(); }
  else if (a === 'repage') repage(Number(t.dataset.i));
  else if (a === 'export') exportXlsx();
  else if (a === 'copy') copyTsv();
  else if (a === 'restore') { const s = S.restored; if (s) restore(s); }
  else if (a === 'forget') { store.del('g5g:session'); S.restored = null; renderBanner(); }
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'xl-in') { const f = t.files[0]; t.value = ''; onXlFile(f); }
  else if (t.id === 'hw-in') { const fs = Array.from(t.files || []); t.value = ''; onHwFiles(fs); }
  else if (t.dataset.key) { const fs = Array.from(t.files || []); t.value = ''; if (fs.length) readKey(t.dataset.key, fs); }
  else if (t.dataset.assign != null) { const i = Number(t.dataset.assign); if (t.value) S.assign[i] = t.value; else delete S.assign[i]; renderReview(); save(); }
  else if (t.dataset.passign != null) { const i = Number(t.dataset.passign); if (t.value) S.passign[i] = t.value; else delete S.passign[i]; renderReview(); save(); }
  else if (t.dataset.assigngroup) {
    const g = groupsNow().find(x => x.owner === t.dataset.assigngroup);
    if (g && t.value) { g.pages.forEach(i => { S.assign[i] = t.value; }); S.sel1 = t.value === 'skip' ? '' : (t.value.indexOf('unk:') === 0 ? t.value : 'sid:' + t.value); renderReview(); save(); }
  }
  else if (t.dataset.rename) { const v = t.value.trim(); if (v) S.rename[t.dataset.rename] = v; else delete S.rename[t.dataset.rename]; renderReview(); save(); }
});
document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.ktext != null) {
    const n = t.dataset.ktext, p = part(n);
    p.key = t.value;
    const card = t.closest('.kcard');
    if (card) { const head = card.querySelector('.khead'); if (head) head.innerHTML = kheadHtml(n); card.classList.toggle('ok', keyItems(p.key).length > 0); }
    renderRun(); save();
  } else if (t.dataset.krule != null) {
    const n = t.dataset.krule;
    part(n).rules = t.value;
    const rules = store.get('g5g:rules', {}); rules[n] = t.value; store.set('g5g:rules', rules);
    save();
  }
});
document.addEventListener('focusout', e => {
  if (S.reviewDirty && $('#s5-body').contains(e.target)) setTimeout(() => { if (S.reviewDirty) renderReview(true); }, 0);
});
let resizeT = null, wasWide = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { const w = window.matchMedia('(min-width: 1100px)').matches; if (w !== wasWide) { wasWide = w; renderReview(true); } }, 200);
});
window.addEventListener('pagehide', () => { if (saveT) saveNow(); });

function renderBanner() {
  const el = $('#banner'), s = S.restored;
  if (!s) { el.innerHTML = ''; el.hidden = true; return; }
  const ok = (s.pages || []).filter(p => p.st === 'ok').length, d = new Date(s.at);
  el.hidden = false;
  el.innerHTML = '<span>이 브라우저에 지난 채점이 남아 있어요 — ' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
    + ' · ' + ok + '/' + (s.pages || []).length + '쪽 채점' + (s.xl ? ' · ' + esc(s.xl.name) : '') + '. 새로 시작하면 지워져요.</span>'
    + '<span class="bacts"><button type="button" class="btn primary sm" data-act="restore">이어서 보기</button><button type="button" class="btn ghost sm" data-act="forget">지우기</button></span>';
}

/* ───────── 시작 ───────── */
(function boot() {
  const s = store.get('g5g:session', null);
  if (s && s.v === 1 && ((s.pages && s.pages.length) || s.xl)) S.restored = s;
  else S.sel = (store.get('g5g:lastsel', []) || []).filter(n => DEFAULT_SUBJ.indexOf(n) >= 0);
  wasWide = window.matchMedia('(min-width: 1100px)').matches;
  renderBanner();
  renderAll();
  ensureLibs();
  aiInit();
})();

// 시험용 (페이지 밖에서 상태를 볼 때만)
window.__g5 = {S: S, AI: AI, groupsNow: groupsNow, xlBuild: xlBuild, xlModel: xlModel, keyItems: keyItems, findSid: findSid, makeTemplate: makeTemplate};
})();
