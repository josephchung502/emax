#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import sys, csv, re, json, math, urllib.request, urllib.parse
from datetime import datetime
from io import StringIO

# Windows 콘솔 UTF-8 출력
sys.stdout = open(sys.stdout.fileno(), mode='w', encoding='utf-8', buffering=1)

CSV_PATH = r'c:\Users\Joseph\Downloads\2026 G6K 숙제 자동화 시트 - point.csv'

def date_to_week(date_str):
    d = datetime.strptime(date_str, '%Y-%m-%d')
    y = d.year
    start = datetime(y, 1, 1)
    diff = (d - start).days
    js_dow = (start.weekday() + 1) % 7
    w = math.ceil((diff + js_dow + 1) / 7)
    return f"{y}-W{w:02d}"

def parse_history(text):
    items = []
    if not text: return items
    pattern = r'\[(\d{2})/(\d{2})/[^\]]*\]\s*([^(+\n]+?)\s*\(\+(\d+)\)'
    for m in re.finditer(pattern, text):
        month, day, memo, pts = m.groups()
        items.append({'date': f"2026-{int(month):02d}-{int(day):02d}",
                      'memo': memo.strip(), 'score': int(pts)})
    return items

def parse_csv(path):
    with open(path, 'r', encoding='utf-8-sig') as f:
        content = f.read()
    rows = list(csv.reader(StringIO(content)))
    students = []
    current_cls = None
    cls_re = re.compile(r'^(G6-\d+[A-Z]+)\(')
    teacher_re = re.compile(r'^Joseph[월화수목금토]')

    def add(cls, name, pts_str, hist):
        if not name or not cls: return
        try: pts = int(pts_str.strip()) if pts_str.strip() else 0
        except: return
        students.append({'cls': cls, 'name': name.strip(), 'cumulative': pts, 'history': hist.strip()})

    for row in rows:
        while len(row) < 7: row.append('')
        l_name, l_pts, l_hist = row[0].strip(), row[1].strip(), row[2].strip()
        r_name, r_pts, r_hist = row[4].strip(), row[5].strip(), row[6].strip()
        m = cls_re.match(l_name)
        if m:
            current_cls = m.group(1)
            add(current_cls, r_name, r_pts, r_hist)
            continue
        if teacher_re.match(l_name):
            add(current_cls, r_name, r_pts, r_hist)
            continue
        add(current_cls, l_name, l_pts, l_hist)
        add(current_cls, r_name, r_pts, r_hist)
    return students

def send_to_gas(gas_url, cls, name, score):
    payload = {
        'action': 'saveScores', 'classGroup': 'KG6',
        'cls': cls, 'name': name, 'week': '2026-W01',
        'scoreData': [{'cls': cls, 'name': name, 'week': '2026-W01',
                       'type': 'MarketDay Points', 'score': score,
                       'date': '2026-01-01', 'memo': '[이전] 누적 이전'}]
    }
    encoded = urllib.parse.quote(json.dumps(payload, ensure_ascii=False))
    url = f"{gas_url}?writeData={encoded}&callback=_cb"
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=20) as r:
            return True, r.read().decode('utf-8')[:60]
    except Exception as e:
        return False, str(e)

def main():
    print("=" * 60)
    print("  eMAX Market Day 포인트 이전 도구")
    print("=" * 60)

    students = parse_csv(CSV_PATH)
    print(f"\nCSV 파싱 완료: {len(students)}명\n")

    print(f"{'반':<12} {'이름':<12} {'누적':>7}  {'이력합':>7}  {'차이':>6}")
    print("-" * 50)
    mismatch = []
    cls_counts = {}
    for s in students:
        items = parse_history(s['history'])
        hist_sum = sum(x['score'] for x in items)
        diff = s['cumulative'] - hist_sum
        diff_str = f"{diff:+d}" if diff != 0 else "  OK"
        if diff != 0 and items:
            mismatch.append(f"  {s['cls']} {s['name']}: 이력={hist_sum} vs 누적={s['cumulative']} (차액 {diff:+d})")
        print(f"{s['cls']:<12} {s['name']:<12} {s['cumulative']:>7}  {hist_sum:>7}  {diff_str:>6}")
        cls_counts[s['cls']] = cls_counts.get(s['cls'], 0) + 1

    print("-" * 50)
    total_pts = sum(s['cumulative'] for s in students)
    print(f"합계: {len(students)}명, 총 {total_pts:,}pt\n")

    if mismatch:
        print(f"[주의] 이력 합계 불일치 {len(mismatch)}건 (누적값 기준으로 저장):")
        for m in mismatch:
            print(m)
        print()

    zero = [s['name'] for s in students if s['cumulative'] == 0]
    if zero:
        print(f"포인트 0 (스킵): {', '.join(zero)}\n")

    targets = [s for s in students if s['cumulative'] > 0]
    print(f"이전 대상: {len(targets)}명")
    print("저장: 각 학생에게 2026-W01 MarketDay Points 단일 레코드")
    print()

    print("=" * 60)
    gas_url = input("GAS URL 붙여넣기: ").strip()
    if not gas_url.startswith('http'):
        print("올바른 URL이 아닙니다. 종료.")
        return

    confirm = input(f"\n{len(targets)}명 이전 실행? (y/n): ").strip().lower()
    if confirm != 'y':
        print("취소됨.")
        return

    print("\n이전 중...\n")
    ok_n, fail_list = 0, []

    for i, s in enumerate(targets, 1):
        ok, msg = send_to_gas(gas_url, s['cls'], s['name'], s['cumulative'])
        mark = "OK" if ok else "XX"
        print(f"  [{i:02d}/{len(targets)}] {mark}  {s['cls']} {s['name']:<12} {s['cumulative']:>6}pt")
        if ok: ok_n += 1
        else: fail_list.append(f"{s['cls']} {s['name']}: {msg}")

    print("\n" + "=" * 60)
    print(f"완료: 성공 {ok_n}명 / 실패 {len(fail_list)}명")
    if fail_list:
        print("\n실패 목록:")
        for f in fail_list:
            print(f"  - {f}")

    print("""
검증:
  앱 -> 학생 관리 -> 학생 이름 클릭 -> MarketDay 숫자 확인
  Sheets -> 성적 시트 -> MarketDay Points / 2026-W01 행 확인
""")

if __name__ == '__main__':
    main()
