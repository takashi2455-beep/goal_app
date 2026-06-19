from flask import Flask, request, jsonify, render_template, make_response
from flask_cors import CORS
import sqlite3
import os
import socket
import csv
import io
from datetime import datetime, date, timedelta
from apscheduler.schedulers.background import BackgroundScheduler

app = Flask(__name__)
CORS(app)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, 'data', 'goals.db')


def next_day(date_str):
    """Return the next calendar day, or None if input is falsy."""
    if not date_str:
        return None
    try:
        return (datetime.strptime(date_str, '%Y-%m-%d') + timedelta(days=1)).strftime('%Y-%m-%d')
    except Exception:
        return date_str


def fetch_subitem_descendants(conn, parent_ids):
    """Recursively fetch all descendant subitems (with bucket info) for the given parent ids."""
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
    ''')
    # Migration: add new columns to existing databases
    for col, defn in [
        ('deadline_year',  'INTEGER DEFAULT 2026'),
        ('deadline_month', 'INTEGER'),
        ('status',         'INTEGER DEFAULT 0'),   # 0=active 1=done 2=dropped
        ('time_spent',     'TEXT'),
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
    for col in ['deadline_week TEXT', 'deadline_date TEXT']:
        try:
            conn.execute(f"ALTER TABLE bucket_list ADD COLUMN {col}")
        except Exception:
            pass
    # Migrate existing completed=1 rows to status=1
    try:
        conn.execute("UPDATE bucket_list SET status=1 WHERE completed=1 AND status=0")
    except Exception:
        pass
    conn.commit()
    conn.close()


def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return 'unknown'


def do_rollover(from_date_str, to_date_str):
    conn = get_db()
    try:
        already = conn.execute(
            "SELECT id FROM rollover_log WHERE from_date=?", (from_date_str,)
        ).fetchone()
        if already:
            return 0

        unfinished = conn.execute(
            "SELECT * FROM tasks WHERE task_type='daily' AND target_date=? AND completed=0",
            (from_date_str,)
        ).fetchall()

        count = 0
        for task in unfinished:
            existing = conn.execute(
                "SELECT id FROM tasks WHERE task_type='daily' AND target_date=? AND rolled_over_from=?",
                (to_date_str, task['id'])
            ).fetchone()
            if not existing:
                conn.execute(
                    "INSERT INTO tasks (title, task_type, target_date, rolled_over_from) VALUES (?, 'daily', ?, ?)",
                    (task['title'], to_date_str, task['id'])
                )
                count += 1

        # Roll over uncompleted subitems with deadline_date
        sub_count = conn.execute(
            "UPDATE bucket_subitems SET deadline_date=? WHERE deadline_date=? AND completed=0",
            (to_date_str, from_date_str)
        ).rowcount
        count += sub_count

        conn.execute(
            "INSERT INTO rollover_log (from_date, to_date, count) VALUES (?, ?, ?)",
            (from_date_str, to_date_str, count)
        )
        conn.commit()
        if count > 0:
            print(f"[ロールオーバー] {from_date_str} → {to_date_str}: {count}件繰り越し")
        return count
    finally:
        conn.close()


def scheduled_rollover():
    today = date.today().isoformat()
    tomorrow = (date.today() + timedelta(days=1)).isoformat()
    do_rollover(today, tomorrow)


def do_catchup(today=None):
    """過去日付の未完了タスク・サブ項目をすべて今日に移動する。"""
    if not today:
        today = date.today().isoformat()
    conn = get_db()
    try:
        today_dt    = datetime.strptime(today, '%Y-%m-%d')
        today_week  = today_dt.strftime('%G-W%V')
        today_month = today_dt.strftime('%Y-%m')
        t_count = conn.execute(
            "UPDATE tasks SET target_date=?, target_week=?, target_month=? WHERE target_date<? AND target_date IS NOT NULL AND completed=0",
            (today, today_week, today_month, today)
        ).rowcount
        s_count = conn.execute(
            "UPDATE bucket_subitems SET deadline_date=? "
            "WHERE deadline_date IS NOT NULL AND deadline_date!='' AND deadline_date<? AND completed=0",
            (today, today)
        ).rowcount
        b_count = conn.execute(
            "UPDATE bucket_list SET deadline_date=? "
            "WHERE deadline_date IS NOT NULL AND deadline_date!='' AND deadline_date<? AND (status=0 OR status IS NULL)",
            (today, today)
        ).rowcount
        conn.commit()
        total = t_count + s_count + b_count
        if total > 0:
            print(f"[キャッチアップ] {today}: タスク{t_count}件・サブ項目{s_count}件を今日に移動")
        return total
    finally:
        conn.close()


def startup_catchup():
    do_catchup()


# ─── Bucket List ──────────────────────────────────────────────────────────────

@app.route('/api/bucket', methods=['GET'])
def get_bucket():
    conn = get_db()
    items = conn.execute(
        "SELECT * FROM bucket_list ORDER BY completed ASC, created_at DESC"
    ).fetchall()
    conn.close()
    return jsonify([dict(i) for i in items])


@app.route('/api/bucket/<int:item_id>', methods=['GET'])
def get_bucket_item(item_id):
    conn = get_db()
    item = conn.execute("SELECT * FROM bucket_list WHERE id=?", (item_id,)).fetchone()
    conn.close()
    if not item:
        return jsonify({'error': 'Not found'}), 404
    return jsonify(dict(item))


@app.route('/api/bucket-with-subitems', methods=['GET'])
def get_bucket_with_subitems():
    conn = get_db()
    items = conn.execute(
        "SELECT * FROM bucket_list ORDER BY completed ASC, created_at DESC"
    ).fetchall()
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


@app.route('/api/bucket', methods=['POST'])
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


@app.route('/api/bucket/<int:item_id>', methods=['PUT'])
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


@app.route('/api/bucket/<int:item_id>/status', methods=['PATCH'])
def set_bucket_status(item_id):
    data = request.json
    status = data.get('status', 0)   # 0=active 1=done 2=dropped
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


@app.route('/api/bucket/<int:item_id>/time-spent', methods=['PATCH'])
def set_time_spent(item_id):
    data = request.json
    time_spent = data.get('time_spent', '') or None
    conn = get_db()
    conn.execute("UPDATE bucket_list SET time_spent=? WHERE id=?", (time_spent, item_id))
    conn.commit()
    item = conn.execute("SELECT * FROM bucket_list WHERE id=?", (item_id,)).fetchone()
    conn.close()
    return jsonify(dict(item))


@app.route('/api/bucket/<int:item_id>', methods=['DELETE'])
def delete_bucket(item_id):
    conn = get_db()
    conn.execute("DELETE FROM bucket_subitems WHERE bucket_id=?", (item_id,))
    conn.execute("DELETE FROM bucket_list WHERE id=?", (item_id,))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


# ─── Bucket Subitems ──────────────────────────────────────────────────────────

@app.route('/api/bucket/<int:item_id>/subitems', methods=['POST'])
def add_subitem(item_id):
    data = request.json
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO bucket_subitems (bucket_id, title, deadline_year, deadline_month, deadline_week, deadline_date, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (item_id, data['title'], data.get('deadline_year'), data.get('deadline_month'), data.get('deadline_week'), data.get('deadline_date'), data.get('parent_id'))
    )
    conn.commit()
    sub = conn.execute("SELECT * FROM bucket_subitems WHERE id=?", (cur.lastrowid,)).fetchone()
    conn.close()
    return jsonify(dict(sub)), 201


@app.route('/api/subitems/<int:sub_id>', methods=['PUT'])
def update_subitem(sub_id):
    data = request.json
    conn = get_db()
    conn.execute(
        "UPDATE bucket_subitems SET title=?, deadline_year=?, deadline_month=?, deadline_week=?, deadline_date=? WHERE id=?",
        (data['title'], data.get('deadline_year'), data.get('deadline_month'), data.get('deadline_week'), data.get('deadline_date'), sub_id)
    )
    conn.commit()
    sub = conn.execute("SELECT * FROM bucket_subitems WHERE id=?", (sub_id,)).fetchone()
    conn.close()
    return jsonify(dict(sub))


@app.route('/api/subitems/<int:sub_id>/toggle', methods=['PATCH'])
def toggle_subitem(sub_id):
    conn = get_db()
    sub = conn.execute("SELECT * FROM bucket_subitems WHERE id=?", (sub_id,)).fetchone()
    conn.execute("UPDATE bucket_subitems SET completed=? WHERE id=?", (0 if sub['completed'] else 1, sub_id))
    conn.commit()
    sub = conn.execute("SELECT * FROM bucket_subitems WHERE id=?", (sub_id,)).fetchone()
    conn.close()
    return jsonify(dict(sub))


@app.route('/api/subitems/<int:sub_id>/time-spent', methods=['PATCH'])
def set_subitem_time_spent(sub_id):
    data = request.json
    time_spent = data.get('time_spent', '') or None
    conn = get_db()
    conn.execute("UPDATE bucket_subitems SET time_spent=? WHERE id=?", (time_spent, sub_id))
    conn.commit()
    sub = conn.execute("SELECT * FROM bucket_subitems WHERE id=?", (sub_id,)).fetchone()
    conn.close()
    return jsonify(dict(sub))


@app.route('/api/subitems/<int:sub_id>', methods=['DELETE'])
def delete_subitem(sub_id):
    conn = get_db()
    conn.execute("DELETE FROM bucket_subitems WHERE id=?", (sub_id,))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


# ─── Monthly Combined ─────────────────────────────────────────────────────────

@app.route('/api/monthly-combined', methods=['GET'])
def monthly_combined():
    month = request.args.get('month', '')
    conn = get_db()

    tasks = conn.execute(
        "SELECT * FROM tasks WHERE target_month=? ORDER BY completed ASC, created_at ASC",
        (month,)
    ).fetchall()

    bucket_items = []
    subitems = []
    matched_ids = []
    if month:
        try:
            year_i, month_i = int(month.split('-')[0]), int(month.split('-')[1])
            rows = conn.execute(
                "SELECT * FROM bucket_list WHERE deadline_year=? AND deadline_month=? AND (status=0 OR status IS NULL) ORDER BY created_at ASC",
                (year_i, month_i)
            ).fetchall()
            for item in rows:
                subs = conn.execute(
                    "SELECT * FROM bucket_subitems WHERE bucket_id=? ORDER BY completed ASC, created_at ASC",
                    (item['id'],)
                ).fetchall()
                d = dict(item)
                d['subitems'] = [dict(s) for s in subs]
                bucket_items.append(d)

            sub_rows = conn.execute(
                """SELECT s.*, b.title AS bucket_title, b.category AS bucket_category
                   FROM bucket_subitems s
                   JOIN bucket_list b ON s.bucket_id = b.id
                   WHERE s.deadline_year=? AND s.deadline_month=? AND b.status=0
                   ORDER BY s.completed ASC, s.created_at ASC""",
                (year_i, month_i)
            ).fetchall()
            matched = [dict(r) for r in sub_rows]
            matched_ids = [s['id'] for s in matched]
            descendants = fetch_subitem_descendants(conn, matched_ids)
            subitems = matched + descendants
        except Exception:
            pass

    conn.close()
    return jsonify({'tasks': [dict(t) for t in tasks], 'bucket_items': bucket_items,
                    'subitems': subitems, 'root_subitem_ids': matched_ids})


# ─── Weekly Combined ─────────────────────────────────────────────────────────

@app.route('/api/weekly-combined', methods=['GET'])
def weekly_combined():
    week = request.args.get('week', '')
    conn = get_db()

    tasks = conn.execute(
        "SELECT * FROM tasks WHERE target_week=? ORDER BY completed ASC, created_at ASC",
        (week,)
    ).fetchall()

    bucket_items = []
    subitems = []
    matched_week_ids = []
    if week:
        b_rows = conn.execute(
            "SELECT * FROM bucket_list WHERE deadline_week=? AND (status=0 OR status IS NULL) ORDER BY created_at ASC",
            (week,)
        ).fetchall()
        for item in b_rows:
            subs = conn.execute(
                "SELECT * FROM bucket_subitems WHERE bucket_id=? ORDER BY completed ASC, created_at ASC",
                (item['id'],)
            ).fetchall()
            d = dict(item)
            d['subitems'] = [dict(s) for s in subs]
            bucket_items.append(d)

        rows = conn.execute(
            """SELECT s.*, b.title AS bucket_title, b.category AS bucket_category
               FROM bucket_subitems s
               JOIN bucket_list b ON s.bucket_id = b.id
               WHERE s.deadline_week=? AND b.status=0
               ORDER BY s.completed ASC, s.created_at ASC""",
            (week,)
        ).fetchall()
        matched = [dict(r) for r in rows]
        matched_week_ids = [s['id'] for s in matched]
        descendants = fetch_subitem_descendants(conn, matched_week_ids)
        subitems = matched + descendants

    conn.close()
    return jsonify({'tasks': [dict(t) for t in tasks], 'bucket_items': bucket_items,
                    'subitems': subitems, 'root_subitem_ids': matched_week_ids})


# ─── Daily Combined ──────────────────────────────────────────────────────────

@app.route('/api/daily-combined', methods=['GET'])
def daily_combined():
    day = request.args.get('date', date.today().isoformat())
    conn = get_db()

    tasks = conn.execute(
        "SELECT * FROM tasks WHERE target_date=? ORDER BY completed ASC, created_at ASC",
        (day,)
    ).fetchall()

    bucket_items = []
    subitems = []
    matched_day_ids = []
    if day:
        b_rows = conn.execute(
            "SELECT * FROM bucket_list WHERE deadline_date=? AND (status=0 OR status IS NULL) ORDER BY created_at ASC",
            (day,)
        ).fetchall()
        for item in b_rows:
            subs = conn.execute(
                "SELECT * FROM bucket_subitems WHERE bucket_id=? ORDER BY completed ASC, created_at ASC",
                (item['id'],)
            ).fetchall()
            d = dict(item)
            d['subitems'] = [dict(s) for s in subs]
            bucket_items.append(d)

        rows = conn.execute(
            """SELECT s.*, b.title AS bucket_title, b.category AS bucket_category
               FROM bucket_subitems s
               JOIN bucket_list b ON s.bucket_id = b.id
               WHERE s.deadline_date=? AND b.status=0
               ORDER BY s.completed ASC, s.created_at ASC""",
            (day,)
        ).fetchall()
        matched = [dict(r) for r in rows]
        matched_day_ids = [s['id'] for s in matched]
        descendants = fetch_subitem_descendants(conn, matched_day_ids)
        subitems = matched + descendants

    conn.close()
    return jsonify({'tasks': [dict(t) for t in tasks], 'bucket_items': bucket_items,
                    'subitems': subitems, 'root_subitem_ids': matched_day_ids})


# ─── Tasks ────────────────────────────────────────────────────────────────────

@app.route('/api/tasks', methods=['GET'])
def get_tasks():
    task_type = request.args.get('type', 'daily')
    conn = get_db()

    if task_type == 'daily':
        target = request.args.get('date', date.today().isoformat())
        tasks = conn.execute(
            "SELECT * FROM tasks WHERE task_type='daily' AND target_date=? ORDER BY completed ASC, created_at ASC",
            (target,)
        ).fetchall()
    elif task_type == 'weekly':
        target = request.args.get('week', '')
        tasks = conn.execute(
            "SELECT * FROM tasks WHERE task_type='weekly' AND target_week=? ORDER BY completed ASC, created_at ASC",
            (target,)
        ).fetchall()
    elif task_type == 'monthly':
        target = request.args.get('month', '')
        tasks = conn.execute(
            "SELECT * FROM tasks WHERE task_type='monthly' AND target_month=? ORDER BY completed ASC, created_at ASC",
            (target,)
        ).fetchall()
    else:
        tasks = []

    conn.close()
    return jsonify([dict(t) for t in tasks])


@app.route('/api/tasks', methods=['POST'])
def add_task():
    data = request.json
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO tasks (title, task_type, target_date, target_week, target_month) VALUES (?, ?, ?, ?, ?)",
        (
            data['title'],
            data['task_type'],
            data.get('target_date'),
            data.get('target_week'),
            data.get('target_month'),
        )
    )
    conn.commit()
    task = conn.execute("SELECT * FROM tasks WHERE id=?", (cur.lastrowid,)).fetchone()
    conn.close()
    return jsonify(dict(task)), 201


@app.route('/api/tasks/<int:task_id>', methods=['PUT'])
def update_task(task_id):
    data = request.json
    conn = get_db()
    conn.execute("UPDATE tasks SET title=? WHERE id=?", (data['title'], task_id))
    conn.commit()
    task = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    conn.close()
    return jsonify(dict(task))


@app.route('/api/tasks/<int:task_id>/toggle', methods=['PATCH'])
def toggle_task(task_id):
    conn = get_db()
    task = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    new_completed = 0 if task['completed'] else 1
    completed_at = datetime.now().strftime('%Y-%m-%d %H:%M:%S') if new_completed else None
    conn.execute("UPDATE tasks SET completed=?, completed_at=? WHERE id=?",
                 (new_completed, completed_at, task_id))
    conn.commit()
    task = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    conn.close()
    return jsonify(dict(task))


@app.route('/api/tasks/<int:task_id>/time-spent', methods=['PATCH'])
def set_task_time_spent(task_id):
    data = request.json
    time_spent = data.get('time_spent', '') or None
    conn = get_db()
    conn.execute("UPDATE tasks SET time_spent=? WHERE id=?", (time_spent, task_id))
    conn.commit()
    task = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    conn.close()
    return jsonify(dict(task))


@app.route('/api/tasks/<int:task_id>', methods=['DELETE'])
def delete_task(task_id):
    conn = get_db()
    conn.execute("DELETE FROM tasks WHERE id=?", (task_id,))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/bucket/<int:item_id>/duplicate', methods=['POST'])
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


@app.route('/api/tasks/<int:task_id>/duplicate', methods=['POST'])
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


@app.route('/api/subitems/<int:sub_id>/duplicate', methods=['POST'])
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


@app.route('/api/rollover', methods=['POST'])
def manual_rollover():
    today = date.today().isoformat()
    tomorrow = (date.today() + timedelta(days=1)).isoformat()
    count = do_rollover(today, tomorrow)
    return jsonify({'ok': True, 'rolled': count})


@app.route('/api/catchup', methods=['POST'])
def api_catchup():
    data = request.json or {}
    today = data.get('today') or date.today().isoformat()
    count = do_catchup(today)
    return jsonify({'ok': True, 'moved': count, 'today': today})


# ─── Export ───────────────────────────────────────────────────────────────────

@app.route('/api/export/text', methods=['GET'])
def export_text():
    conn = get_db()
    lines = []
    lines.append("=== 目標管理レポート ===")
    lines.append(f"出力日時: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append("")

    # ── やりたいことリスト ──────────────────────────────────────
    lines.append("━" * 42)
    lines.append("【やりたいことリスト】")
    lines.append("━" * 42)
    lines.append("")

    CATEGORIES = [
        ('must',          '🔥 must'),
        ('読みたい本',      '📚 読みたい本'),
        ('読みたい教科書',  '📖 読みたい教科書'),
        ('趣味',           '🎯 趣味'),
        ('投資',           '📈 投資'),
    ]

    all_bucket = conn.execute("SELECT * FROM bucket_list ORDER BY created_at ASC").fetchall()
    bucket_with_subs = []
    for item in all_bucket:
        subs = conn.execute(
            "SELECT * FROM bucket_subitems WHERE bucket_id=? ORDER BY created_at ASC",
            (item['id'],)
        ).fetchall()
        d = dict(item)
        d['subitems'] = [dict(s) for s in subs]
        bucket_with_subs.append(d)

    def deadline_sort_key(item):
        y = item.get('deadline_year') or 9999
        m = item.get('deadline_month') or 99
        return (y * 100 + m, item.get('title', ''))

    def fmt_deadline(y, m):
        if y and m:
            return f"  期限: {y}年{m}月"
        elif y:
            return f"  期限: {y}年"
        return "  （期限なし）"

    active = [i for i in bucket_with_subs if (i.get('status') or 0) == 0]
    for cat_key, cat_label in CATEGORIES:
        cat_items = sorted(
            [i for i in active if i.get('category') == cat_key],
            key=deadline_sort_key
        )
        lines.append(cat_label)
        if not cat_items:
            lines.append("  （なし）")
        else:
            for item in cat_items:
                dl = fmt_deadline(item.get('deadline_year'), item.get('deadline_month'))
                lines.append(f"  [○] {item['title']}{dl}")
                if item.get('description'):
                    lines.append(f"       メモ: {item['description']}")
                for s in item['subitems']:
                    sy, sm, sw, sd = s.get('deadline_year'), s.get('deadline_month'), s.get('deadline_week'), s.get('deadline_date')
                    sdl_parts = []
                    if sy and sm:
                        sdl_parts.append(f"{sy}年{sm}月")
                    elif sy:
                        sdl_parts.append(f"{sy}年")
                    if sw:
                        sdl_parts.append(f"（{sw}）")
                    if sd:
                        sdl_parts.append(f"[{sd}]")
                    sdl = "  期限: " + "".join(sdl_parts) if sdl_parts else ""
                    sts = f"  所要時間: {s['time_spent']}" if s.get('time_spent') else ""
                    lines.append(f"    ・ {s['title']}{sdl}{sts}")
        lines.append("")

    done = [i for i in bucket_with_subs if (i.get('status') or 0) == 1]
    if done:
        lines.append("─" * 42)
        lines.append("✓ 終了済み")
        for item in sorted(done, key=lambda i: i.get('completed_at') or ''):
            cd = f"  完了: {item['completed_at'][:10]}" if item.get('completed_at') else ""
            ts = f"  所要時間: {item['time_spent']}" if item.get('time_spent') else ""
            lines.append(f"  [✓] {item['title']}  [{item.get('category', '')}]{cd}{ts}")
        lines.append("")

    dropped = [i for i in bucket_with_subs if (i.get('status') or 0) == 2]
    if dropped:
        lines.append("─" * 42)
        lines.append("✕ やらないと決めた")
        for item in sorted(dropped, key=deadline_sort_key):
            lines.append(f"  [✕] {item['title']}  [{item.get('category', '')}]")
        lines.append("")

    lines.append("━" * 42)
    lines.append("")

    # ── 月次タスク ──────────────────────────────────────────────
    lines.append("【月次タスク】")
    monthly = conn.execute(
        "SELECT * FROM tasks WHERE task_type='monthly' ORDER BY target_month, completed, created_at"
    ).fetchall()
    def fmt_task_line(t, extra=''):
        mark = "✓" if t['completed'] else "○"
        cd = f"  完了: {t['completed_at'][:10]}" if t.get('completed_at') else ""
        ts = f"  所要時間: {t['time_spent']}" if t.get('time_spent') else ""
        return f"    [{mark}] {t['title']}{extra}{cd}{ts}"

    if monthly:
        cur_month = None
        for t in monthly:
            if t['target_month'] != cur_month:
                cur_month = t['target_month']
                lines.append(f"\n  ▸ {cur_month}")
            lines.append(fmt_task_line(t))
    else:
        lines.append("  （なし）")

    lines.append("")
    lines.append("【週次タスク】")
    weekly = conn.execute(
        "SELECT * FROM tasks WHERE task_type='weekly' ORDER BY target_week, completed, created_at"
    ).fetchall()
    if weekly:
        cur_week = None
        for t in weekly:
            if t['target_week'] != cur_week:
                cur_week = t['target_week']
                lines.append(f"\n  ▸ {cur_week}")
            lines.append(fmt_task_line(t))
    else:
        lines.append("  （なし）")

    lines.append("")
    lines.append("【日次タスク】")
    daily = conn.execute(
        "SELECT * FROM tasks WHERE task_type='daily' ORDER BY target_date DESC, completed, created_at"
    ).fetchall()
    if daily:
        cur_date = None
        for t in daily:
            if t['target_date'] != cur_date:
                cur_date = t['target_date']
                lines.append(f"\n  ▸ {cur_date}")
            rollover = " (繰越)" if t['rolled_over_from'] else ""
            lines.append(fmt_task_line(t, rollover))
    else:
        lines.append("  （なし）")

    conn.close()

    content = "\n".join(lines)
    response = make_response(content)
    response.headers['Content-Type'] = 'text/plain; charset=utf-8'
    response.headers['Content-Disposition'] = (
        f'attachment; filename=goals_{date.today().isoformat()}.txt'
    )
    return response


@app.route('/api/export/csv', methods=['GET'])
def export_csv():
    conn = get_db()
    output = io.StringIO()
    writer = csv.writer(output)

    writer.writerow(['=== やりたいことリスト ==='])
    writer.writerow(['ID', 'タイトル', '説明', 'カテゴリ', '状態', '完了日時', '作成日時'])
    for item in conn.execute("SELECT * FROM bucket_list ORDER BY completed, created_at"):
        writer.writerow([
            item['id'], item['title'], item['description'], item['category'],
            '完了' if item['completed'] else '未完了',
            item['completed_at'] or '', item['created_at']
        ])

    writer.writerow([])
    writer.writerow(['=== タスク一覧 ==='])
    writer.writerow(['ID', 'タイトル', 'タイプ', '対象日', '対象週', '対象月', '状態', '繰越元ID', '作成日時'])
    type_ja = {'daily': '日次', 'weekly': '週次', 'monthly': '月次'}
    for t in conn.execute(
        "SELECT * FROM tasks ORDER BY task_type, target_month, target_week, target_date, completed, created_at"
    ):
        writer.writerow([
            t['id'], t['title'], type_ja.get(t['task_type'], t['task_type']),
            t['target_date'] or '', t['target_week'] or '', t['target_month'] or '',
            '完了' if t['completed'] else '未完了',
            t['rolled_over_from'] or '', t['created_at']
        ])

    conn.close()
    output.seek(0)
    content = '﻿' + output.getvalue()  # BOM for Excel
    response = make_response(content)
    response.headers['Content-Type'] = 'text/csv; charset=utf-8-sig'
    response.headers['Content-Disposition'] = (
        f'attachment; filename=goals_{date.today().isoformat()}.csv'
    )
    return response


@app.route('/api/status', methods=['GET'])
def status():
    return jsonify({
        'status': 'ok',
        'local_ip': get_local_ip(),
        'time': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    })


@app.route('/')
def index():
    return render_template('index.html')


# DB初期化・スケジューラーはWSGI/直接起動どちらでも動くようにモジュールレベルで実行
init_db()
startup_catchup()

scheduler = BackgroundScheduler()
scheduler.add_job(do_catchup, 'cron', hour=0, minute=0)
scheduler.start()

if __name__ == '__main__':

    local_ip = get_local_ip()
    print("\n" + "=" * 40)
    print("  目標管理アプリ 起動中")
    print("=" * 40)
    print(f"  PC:     http://localhost:5000")
    print(f"  iPhone: http://{local_ip}:5000")
    print(f"  (同じWiFiに接続してください)")
    print("=" * 40 + "\n")

    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
