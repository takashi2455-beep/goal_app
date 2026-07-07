# goal-app — 目標管理アプリ

Flask + SQLite(data/goals.db)。APScheduler でスケジュール処理あり。

## 起動

```
python app.py
```

→ http://localhost:5000(PORT 環境変数で変更可)

## 注意

- data/goals.db は個人データ。commit しない
- kakeibo-app / portal-app と同時起動するとポート5000が衝突する
