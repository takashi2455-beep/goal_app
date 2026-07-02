from flask import Blueprint, request, jsonify, render_template, make_response
import sqlite3, os, csv, io
from datetime import datetime, date, timedelta
from apscheduler.schedulers.background import BackgroundScheduler

bp = Blueprint('goal', __name__)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH  = os.path.join(BASE_DIR, 'data', 'goals.db')

_scheduler = None


def get_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS bucket_list (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT DEFAULT '',
            category TEXT DEFAULT 'must',
            deadline_year INTEGER DEFAULT 2026,
            deadline_month INTEGER,
            created_at TEXT DEFAULT (datetime('now', 'localtime')),
            completed INTEGER DEFAULT 0,
            completed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            task_type TEXT NOT NULL,
            target_date TEXT,
            target_week TEXT,
            target_month TEXT,
            completed INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now', 'localtime')),
            rolled_over_from INTEGER
        );
        CREATE TABLE IF NOT EXISTS rollover_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rolled_at TEXT DEFAULT (datetime('now', 'localtime')),
            from_date TEXT NOT NULL,
            to_date TEXT NOT NULL,
            count INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS bucket_subitems (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bucket_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            deadline_year INTEGER,
            deadline_month INTEGER,
            deadline_week TEXT,
            deadline_date TEXT,
            completed INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now', 'localtime'))
        );
        CREATE TABLE IF NOT EXISTS life_goals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            parent_id INTEGER,
            title TEXT NOT NULL,
            description TEXT DEFAULT '',
            level INTEGER DEFAULT 1,
            completed INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now', 'localtime'))
        );
    ''')
    for col, defn in [
        ('deadline_year',  'INTEGER DEFAULT 2026'),
        ('deadline_month', 'INTEGER'),
        ('status',         'INTEGER DEFAULT 0'),
        ('time_spent',     'TEXT'),
        ('deadline_week',  'TEXT'),
        ('deadline_date',  'TEXT'),
    ]:
        try:
            conn.execute(f"ALTER TABLE bucket_list ADD COLUMN {col} {defn}")
        except Exception:
            pass
    for col in ['deadline_date TEXT', 'time_spent TEXT', 'parent_id INTEGER']:
        try:
            conn.execute(f"ALTER TABLE bucket_subitems ADD COLUMN {col}")
        except Exception:
            pass
    for col in ['completed_at TEXT', 'time_spent TEXT']:
        try:
            conn.execute(f"ALTER TABLE tasks ADD COLUMN {col}")
        except Exception:
            pass
    try:
        conn.execute("UPDATE bucket_list SET status=1 WHERE completed=1 AND status=0")
    except Exception:
        pass
    conn.commit()
    conn.close()


def next_day(date_str):
    if not date_str:
        return None
    try:
        return (datetime.strptime(date_str, '%Y-%m-%d') + timedelta(days=1)).strftime('%Y-%m-%d')
    except Exception:
        return date_str


def fetch_subitem_descendants(conn, parent_ids):
    if not parent_ids:
        return []
    all_children = []
    to_process = list(parent_ids)
    seen = set(parent_ids)
    while to_process:
        ph = ','.join('?' * len(to_process))
        rows = conn.execute(
            f"""SELECT s.*, b.title AS bucket_title, b.category AS bucket_category
                FROM bucket_subitems s JOIN bucket_list b ON s.bucket_id=b.id
                WHERE s.parent_id IN ({ph})""",
            to_process
        ).fetchall()
        new_ids = []
        for r in rows:
            d = dict(r)
            if d['id'] not in seen:
                all_children.append(d)
                seen.add(d['id'])
                new_ids.append(d['id'])
        to_process = new_ids
    return all_children


def fetch_bucket_and_subitems(conn, bucket_where, bucket_params, sub_where, sub_params):
    b_rows = conn.execute(
        f"SELECT * FROM bucket_list WHERE {bucket_where} AND (status IS NULL OR status != 2) ORDER BY status ASC, created_at ASC",
        bucket_params
    ).fetchall()
    bucket_items = []
    for item in b_rows:
        subs = conn.execute(
            "SELECT * FROM bucket_subitems WHERE bucket_id=? ORDER BY completed ASC, created_at ASC",
            (item['id'],)
        ).fetchall()
        d = dict(item)
        d['subitems'] = [dict(s) for s in subs]
        bucket_items.append(d)
    sub_rows = conn.execute(
        f"""SELECT s.*, b.title AS bucket_title, b.category AS bucket_category
            FROM bucket_subitems s JOIN bucket_list b ON s.bucket_id = b.id
            WHERE {sub_where} AND b.status=0
            ORDER BY s.completed ASC, s.created_at ASC""",
        sub_params
    ).fetchall()
    matched = [dict(r) for r in sub_rows]
    matched_ids = [s['id'] for s in matched]
    return bucket_items, matched + fetch_subitem_descendants(conn, matched_ids), matched_ids


def do_catchup(today=None):
    if not today:
        today = date.today().isoformat()
    conn = get_db()
    try:
        today_dt    = datetime.strptime(today, '%Y-%m-%d')
        today_week  = today_dt.strftime('%G-W%V')
        today_month = today_dt.strftime('%Y-%m')
        conn.execute(
            "UPDATE tasks SET target_date=?, target_week=?, target_month=? WHERE target_date<? AND target_date IS NOT NULL AND completed=0",
            (today, today_week, today_month, today)
        )
        conn.execute(
            "UPDATE bucket_subitems SET deadline_date=? WHERE deadline_date IS NOT NULL AND deadline_date!='' AND deadline_date<? AND completed=0",
            (today, today)
        )
        conn.execute(
            "UPDATE bucket_list SET deadline_date=? WHERE deadline_date IS NOT NULL AND deadline_date!='' AND deadline_date<? AND (status=0 OR status IS NULL)",
            (today, today)
        )
        conn.commit()
    finally:
        conn.close()


def start_scheduler():
    global _scheduler
    if _scheduler is not None:
        return
    do_catchup()
    _scheduler = BackgroundScheduler()
    _scheduler.add_job(do_catchup, 'cron', hour=0, minute=0)
    _scheduler.start()


# ─── Bucket List ──────────────────────────────────────────────────────────────

@bp.route('/api/bucket/<int:item_id>')
def get_bucket_item(item_id):
    conn = get_db()
    item = conn.execute("SELECT * FROM bucket_list WHERE id=?", (item_id,)).fetchone()
    conn.close()
    if not item:
        return jsonify({'error': 'Not found'}), 404
    return jsonify(dict(item))


@bp.route('/api/bucket-with-subitems')
def get_bucket_with_subitems():
    conn = get_db()
    items = conn.execute("SELECT * FROM bucket_list ORDER BY completed ASC, created_at DESC").fetchall()
    result = []
    for item in items:
        subs = conn.execute(
            "SELECT * FROM bucket_subitems WHERE bucket_id=? ORDER BY completed ASC, created_at ASC",
            (item['id'],)
        ).fetchall()
        d = dict(item)
        d['subitems'] = [dict(s) for s in subs]
        result.append(d)
    conn.close()
    return jsonify(result)


@bp.route('/api/bucket', methods=['POST'])
def add_bucket():
    data = request.json
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO bucket_list (title, description, category, deadline_year, deadline_month, deadline_week, deadline_date) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (data['title'], data.get('description', ''), data.get('category', 'must'),
         data.get('deadline_year'), data.get('deadline_month'),
         data.get('deadline_week'), data.get('deadline_date'))
    )
    conn.commit()
    item = conn.execute("SELECT * FROM bucket_list WHERE id=?", (cur.lastrowid,)).fetchone()
    conn.close()
    return jsonify(dict(item)), 201


@bp.route('/api/bucket/<int:item_id>', methods=['PUT'])
def update_bucket(item_id):
    data = request.json
    conn = get_db()
    conn.execute(
        "UPDATE bucket_list SET title=?, description=?, category=?, deadline_year=?, deadline_month=?, deadline_week=?, deadline_date=? WHERE id=?",
        (data['title'], data.get('description', ''), data.get('category', 'must'),
         data.get('deadline_year'), data.get('deadline_month'),
         data.get('deadline_week'), data.get('deadline_date'), item_id)
    )
    conn.commit()
    item = conn.execute("SELECT * FROM bucket_list WHERE id=?", (item_id,)).fetchone()
    conn.close()
    return jsonify(dict(item))


@bp.route('/api/bucket/<int:item_id>/status', methods=['PATCH'])
def set_bucket_status(item_id):
    data = request.json
    status = data.get('status', 0)
    conn = get_db()
    completed_at = datetime.now().strftime('%Y-%m-%d %H:%M:%S') if status == 1 else None
    conn.execute(
        "UPDATE bucket_list SET status=?, completed=?, completed_at=? WHERE id=?",
        (status, 1 if status == 1 else 0, completed_at, item_id)
    )
    conn.commit()
    item = conn.execute("SELECT * FROM bucket_list WHERE id=?", (item_id,)).fetchone()
    conn.close()
    return jsonify(dict(item))


@bp.route('/api/bucket/<int:item_id>/time-spent', methods=['PATCH'])
def set_time_spent(item_id):
    conn = get_db()
    conn.execute("UPDATE bucket_list SET time_spent=? WHERE id=?", (request.json.get('time_spent') or None, item_id))
    conn.commit()
    item = conn.execute("SELECT * FROM bucket_list WHERE id=?", (item_id,)).fetchone()
    conn.close()
    return jsonify(dict(item))


@bp.route('/api/bucket/<int:item_id>', methods=['DELETE'])
def delete_bucket(item_id):
    conn = get_db()
    conn.execute("DELETE FROM bucket_subitems WHERE bucket_id=?", (item_id,))
    conn.execute("DELETE FROM bucket_list WHERE id=?", (item_id,))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


# ─── Bucket Subitems ──────────────────────────────────────────────────────────

@bp.route('/api/bucket/<int:item_id>/subitems', methods=['POST'])
def add_subitem(item_id):
    data = request.json
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO bucket_subitems (bucket_id, title, deadline_year, deadline_month, deadline_week, deadline_date, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (item_id, data['title'], data.get('deadline_year'), data.get('deadline_month'),
         data.get('deadline_week'), data.get('deadline_date'), data.get('parent_id'))
    )
    conn.commit()
    sub = conn.execute("SELECT * FROM bucket_subitems WHERE id=?", (cur.lastrowid,)).fetchone()
    conn.close()
    return jsonify(dict(sub)), 201


@bp.route('/api/subitems/<int:sub_id>', methods=['PUT'])
def update_subitem(sub_id):
    data = request.json
    conn = get_db()
    conn.execute(
        "UPDATE bucket_subitems SET title=?, deadline_year=?, deadline_month=?, deadline_week=?, deadline_date=? WHERE id=?",
        (data['title'], data.get('deadline_year'), data.get('deadline_month'),
         data.get('deadline_week'), data.get('deadline_date'), sub_id)
    )
    conn.commit()
    sub = conn.execute("SELECT * FROM bucket_subitems WHERE id=?", (sub_id,)).fetchone()
    conn.close()
    return jsonify(dict(sub))


@bp.route('/api/subitems/<int:sub_id>/toggle', methods=['PATCH'])
def toggle_subitem(sub_id):
    conn = get_db()
    sub = conn.execute("SELECT * FROM bucket_subitems WHERE id=?", (sub_id,)).fetchone()
    conn.execute("UPDATE bucket_subitems SET completed=? WHERE id=?", (0 if sub['completed'] else 1, sub_id))
    conn.commit()
    sub = conn.execute("SELECT * FROM bucket_subitems WHERE id=?", (sub_id,)).fetchone()
    conn.close()
    return jsonify(dict(sub))


@bp.route('/api/subitems/<int:sub_id>/time-spent', methods=['PATCH'])
def set_subitem_time_spent(sub_id):
    conn = get_db()
    conn.execute("UPDATE bucket_subitems SET time_spent=? WHERE id=?", (request.json.get('time_spent') or None, sub_id))
    conn.commit()
    sub = conn.execute("SELECT * FROM bucket_subitems WHERE id=?", (sub_id,)).fetchone()
    conn.close()
    return jsonify(dict(sub))


@bp.route('/api/subitems/<int:sub_id>', methods=['DELETE'])
def delete_subitem(sub_id):
    conn = get_db()
    conn.execute("DELETE FROM bucket_subitems WHERE id=?", (sub_id,))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


# ─── Combined Endpoints ───────────────────────────────────────────────────────

@bp.route('/api/monthly-combined')
def monthly_combined():
    month = request.args.get('month', '')
    conn = get_db()
    tasks = conn.execute(
        "SELECT * FROM tasks WHERE target_month=? ORDER BY completed ASC, created_at ASC", (month,)
    ).fetchall()
    bucket_items, subitems, root_ids = [], [], []
    if month:
        try:
            y, m = int(month.split('-')[0]), int(month.split('-')[1])
            bucket_items, subitems, root_ids = fetch_bucket_and_subitems(
                conn,
                "deadline_year=? AND deadline_month=?", (y, m),
                "s.deadline_year=? AND s.deadline_month=?", (y, m)
            )
        except Exception:
            pass
    conn.close()
    return jsonify({'tasks': [dict(t) for t in tasks], 'bucket_items': bucket_items,
                    'subitems': subitems, 'root_subitem_ids': root_ids})


@bp.route('/api/weekly-combined')
def weekly_combined():
    week = request.args.get('week', '')
    conn = get_db()
    tasks = conn.execute(
        "SELECT * FROM tasks WHERE target_week=? ORDER BY completed ASC, created_at ASC", (week,)
    ).fetchall()
    bucket_items, subitems, root_ids = [], [], []
    if week:
        bucket_items, subitems, root_ids = fetch_bucket_and_subitems(
            conn, "deadline_week=?", (week,), "s.deadline_week=?", (week,)
        )
    conn.close()
    return jsonify({'tasks': [dict(t) for t in tasks], 'bucket_items': bucket_items,
                    'subitems': subitems, 'root_subitem_ids': root_ids})


@bp.route('/api/daily-combined')
def daily_combined():
    day = request.args.get('date', date.today().isoformat())
    conn = get_db()
    tasks = conn.execute(
        "SELECT * FROM tasks WHERE target_date=? ORDER BY completed ASC, created_at ASC", (day,)
    ).fetchall()
    bucket_items, subitems, root_ids = [], [], []
    if day:
        bucket_items, subitems, root_ids = fetch_bucket_and_subitems(
            conn, "deadline_date=?", (day,), "s.deadline_date=?", (day,)
        )
    conn.close()
    return jsonify({'tasks': [dict(t) for t in tasks], 'bucket_items': bucket_items,
                    'subitems': subitems, 'root_subitem_ids': root_ids})


# ─── Tasks ────────────────────────────────────────────────────────────────────

@bp.route('/api/tasks', methods=['POST'])
def add_task():
    data = request.json
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO tasks (title, task_type, target_date, target_week, target_month) VALUES (?, ?, ?, ?, ?)",
        (data['title'], data['task_type'], data.get('target_date'), data.get('target_week'), data.get('target_month'))
    )
    conn.commit()
    task = conn.execute("SELECT * FROM tasks WHERE id=?", (cur.lastrowid,)).fetchone()
    conn.close()
    return jsonify(dict(task)), 201


@bp.route('/api/tasks/<int:task_id>', methods=['PUT'])
def update_task(task_id):
    data = request.json
    conn = get_db()
    conn.execute("UPDATE tasks SET title=? WHERE id=?", (data['title'], task_id))
    conn.commit()
    task = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    conn.close()
    return jsonify(dict(task))


@bp.route('/api/tasks/<int:task_id>/toggle', methods=['PATCH'])
def toggle_task(task_id):
    conn = get_db()
    task = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    new_completed = 0 if task['completed'] else 1
    completed_at = datetime.now().strftime('%Y-%m-%d %H:%M:%S') if new_completed else None
    conn.execute("UPDATE tasks SET completed=?, completed_at=? WHERE id=?", (new_completed, completed_at, task_id))
    conn.commit()
    task = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    conn.close()
    return jsonify(dict(task))


@bp.route('/api/tasks/<int:task_id>/time-spent', methods=['PATCH'])
def set_task_time_spent(task_id):
    conn = get_db()
    conn.execute("UPDATE tasks SET time_spent=? WHERE id=?", (request.json.get('time_spent') or None, task_id))
    conn.commit()
    task = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    conn.close()
    return jsonify(dict(task))


@bp.route('/api/tasks/<int:task_id>', methods=['DELETE'])
def delete_task(task_id):
    conn = get_db()
    conn.execute("DELETE FROM tasks WHERE id=?", (task_id,))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@bp.route('/api/bucket/<int:item_id>/duplicate', methods=['POST'])
def duplicate_bucket(item_id):
    conn = get_db()
    item = conn.execute("SELECT * FROM bucket_list WHERE id=?", (item_id,)).fetchone()
    if not item:
        conn.close()
        return jsonify({'error': 'not found'}), 404
    d = dict(item)
    cur = conn.execute(
        "INSERT INTO bucket_list (title, description, category, deadline_year, deadline_month, deadline_week, deadline_date) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (d['title'], d.get('description', ''), d.get('category', 'must'),
         d.get('deadline_year'), d.get('deadline_month'), d.get('deadline_week'),
         next_day(d.get('deadline_date')))
    )
    new_id = cur.lastrowid
    subs = conn.execute("SELECT * FROM bucket_subitems WHERE bucket_id=? ORDER BY id ASC", (item_id,)).fetchall()
    id_map = {}
    for s in subs:
        sd = dict(s)
        c2 = conn.execute(
            "INSERT INTO bucket_subitems (bucket_id, title, deadline_year, deadline_month, deadline_week, deadline_date, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (new_id, sd['title'], sd.get('deadline_year'), sd.get('deadline_month'),
             sd.get('deadline_week'), next_day(sd.get('deadline_date')), None)
        )
        id_map[sd['id']] = c2.lastrowid
    for old_id, new_sub_id in id_map.items():
        old_parent = next((dict(s)['parent_id'] for s in subs if s['id'] == old_id), None)
        if old_parent and old_parent in id_map:
            conn.execute("UPDATE bucket_subitems SET parent_id=? WHERE id=?", (id_map[old_parent], new_sub_id))
    conn.commit()
    new_item = conn.execute("SELECT * FROM bucket_list WHERE id=?", (new_id,)).fetchone()
    conn.close()
    return jsonify(dict(new_item)), 201


@bp.route('/api/tasks/<int:task_id>/duplicate', methods=['POST'])
def duplicate_task(task_id):
    conn = get_db()
    task = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    if not task:
        conn.close()
        return jsonify({'error': 'not found'}), 404
    d = dict(task)
    new_date = next_day(d.get('target_date')) if d.get('task_type') == 'daily' else d.get('target_date')
    cur = conn.execute(
        "INSERT INTO tasks (title, task_type, target_date, target_week, target_month) VALUES (?, ?, ?, ?, ?)",
        (d['title'], d['task_type'], new_date, d.get('target_week'), d.get('target_month'))
    )
    conn.commit()
    new_task = conn.execute("SELECT * FROM tasks WHERE id=?", (cur.lastrowid,)).fetchone()
    conn.close()
    return jsonify(dict(new_task)), 201


@bp.route('/api/subitems/<int:sub_id>/duplicate', methods=['POST'])
def duplicate_subitem(sub_id):
    conn = get_db()
    sub = conn.execute("SELECT * FROM bucket_subitems WHERE id=?", (sub_id,)).fetchone()
    if not sub:
        conn.close()
        return jsonify({'error': 'not found'}), 404
    d = dict(sub)
    cur = conn.execute(
        "INSERT INTO bucket_subitems (bucket_id, title, deadline_year, deadline_month, deadline_week, deadline_date, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (d['bucket_id'], d['title'], d.get('deadline_year'), d.get('deadline_month'),
         d.get('deadline_week'), next_day(d.get('deadline_date')), d.get('parent_id'))
    )
    conn.commit()
    new_sub = conn.execute("SELECT * FROM bucket_subitems WHERE id=?", (cur.lastrowid,)).fetchone()
    conn.close()
    return jsonify(dict(new_sub)), 201


@bp.route('/api/catchup', methods=['POST'])
def api_catchup():
    data = request.json or {}
    today = data.get('today') or date.today().isoformat()
    do_catchup(today)
    return jsonify({'ok': True, 'today': today})


# ─── Export ───────────────────────────────────────────────────────────────────

@bp.route('/api/export/text')
def export_text():
    conn = get_db()
    lines = ["=== 目標管理レポート ===", f"出力日時: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}", ""]

    lines += ["━" * 42, "【やりたいことリスト】", "━" * 42, ""]

    CATEGORIES = [
        ('must',          '🔥 must'),
        ('読みたい本',     '📚 読みたい本'),
        ('読みたい教科書', '📖 読みたい教科書'),
        ('趣味',          '🎯 趣味'),
        ('投資',          '📈 投資'),
    ]

    all_bucket = conn.execute("SELECT * FROM bucket_list ORDER BY created_at ASC").fetchall()
    bucket_with_subs = []
    for item in all_bucket:
        subs = conn.execute(
            "SELECT * FROM bucket_subitems WHERE bucket_id=? ORDER BY created_at ASC", (item['id'],)
        ).fetchall()
        d = dict(item)
        d['subitems'] = [dict(s) for s in subs]
        bucket_with_subs.append(d)

    def dl_sort(item):
        return ((item.get('deadline_year') or 9999) * 100 + (item.get('deadline_month') or 99), item.get('title', ''))

    def fmt_dl(y, m):
        return f"  期限: {y}年{m}月" if y and m else (f"  期限: {y}年" if y else "  （期限なし）")

    active = [i for i in bucket_with_subs if (i.get('status') or 0) == 0]
    for cat_key, cat_label in CATEGORIES:
        cat_items = sorted([i for i in active if i.get('category') == cat_key], key=dl_sort)
        lines.append(cat_label)
        if not cat_items:
            lines.append("  （なし）")
        else:
            for item in cat_items:
                lines.append(f"  [○] {item['title']}{fmt_dl(item.get('deadline_year'), item.get('deadline_month'))}")
                if item.get('description'):
                    lines.append(f"       メモ: {item['description']}")
                for s in item['subitems']:
                    parts = []
                    if s.get('deadline_year') and s.get('deadline_month'):
                        parts.append(f"{s['deadline_year']}年{s['deadline_month']}月")
                    elif s.get('deadline_year'):
                        parts.append(f"{s['deadline_year']}年")
                    if s.get('deadline_week'): parts.append(f"（{s['deadline_week']}）")
                    if s.get('deadline_date'): parts.append(f"[{s['deadline_date']}]")
                    sdl = "  期限: " + "".join(parts) if parts else ""
                    sts = f"  所要時間: {s['time_spent']}" if s.get('time_spent') else ""
                    lines.append(f"    ・ {s['title']}{sdl}{sts}")
        lines.append("")

    conn.close()
    response = make_response("\n".join(lines))
    response.headers['Content-Type'] = 'text/plain; charset=utf-8'
    response.headers['Content-Disposition'] = f'attachment; filename=goals_{date.today().isoformat()}.txt'
    return response


@bp.route('/api/export/csv')
def export_csv():
    conn = get_db()
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(['ID', 'タイトル', '説明', 'カテゴリ', '状態', '完了日時', '作成日時'])
    for item in conn.execute("SELECT * FROM bucket_list ORDER BY completed, created_at"):
        writer.writerow([item['id'], item['title'], item['description'], item['category'],
                         '完了' if item['completed'] else '未完了', item['completed_at'] or '', item['created_at']])
    conn.close()
    output.seek(0)
    response = make_response('﻿' + output.getvalue())
    response.headers['Content-Type'] = 'text/csv; charset=utf-8-sig'
    response.headers['Content-Disposition'] = f'attachment; filename=goals_{date.today().isoformat()}.csv'
    return response


# ─── Life Goals ───────────────────────────────────────────────────────────────

@bp.route('/api/life-goals')
def get_life_goals():
    conn = get_db()
    goals = conn.execute("SELECT * FROM life_goals ORDER BY level, parent_id, created_at").fetchall()
    conn.close()
    return jsonify([dict(g) for g in goals])


@bp.route('/api/life-goals', methods=['POST'])
def add_life_goal():
    data = request.json
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO life_goals (parent_id, title, description, level) VALUES (?, ?, ?, ?)",
        (data.get('parent_id'), data['title'], data.get('description', ''), data.get('level', 1))
    )
    conn.commit()
    goal = conn.execute("SELECT * FROM life_goals WHERE id=?", (cur.lastrowid,)).fetchone()
    conn.close()
    return jsonify(dict(goal)), 201


@bp.route('/api/life-goals/<int:gid>', methods=['PUT'])
def update_life_goal(gid):
    data = request.json
    conn = get_db()
    conn.execute("UPDATE life_goals SET title=?, description=? WHERE id=?",
                 (data['title'], data.get('description', ''), gid))
    conn.commit()
    goal = conn.execute("SELECT * FROM life_goals WHERE id=?", (gid,)).fetchone()
    conn.close()
    return jsonify(dict(goal))


@bp.route('/api/life-goals/<int:gid>', methods=['DELETE'])
def delete_life_goal(gid):
    conn = get_db()
    def _del(node_id):
        for c in conn.execute("SELECT id FROM life_goals WHERE parent_id=?", (node_id,)).fetchall():
            _del(c['id'])
        conn.execute("DELETE FROM life_goals WHERE id=?", (node_id,))
    _del(gid)
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@bp.route('/api/life-goals/<int:gid>/toggle', methods=['PATCH'])
def toggle_life_goal(gid):
    conn = get_db()
    conn.execute("UPDATE life_goals SET completed = 1 - completed WHERE id=?", (gid,))
    conn.commit()
    goal = conn.execute("SELECT * FROM life_goals WHERE id=?", (gid,)).fetchone()
    conn.close()
    return jsonify(dict(goal))


@bp.route('/')
def index():
    return render_template('goal/index.html')
