# CLAUDE.md

## プロジェクト概要

ウルトラマン関連のイベント・特売情報を1日おきに自動収集し、iPhone の PWA で閲覧・通知するツール。利用者は本人と配偶者の2名。通知は両方の iPhone に届く。

## 構成

```
.github/workflows/collect.yml  GitHub Actions（毎日起動、1日おきに実処理）
scripts/
  sources.mjs      収集元の定義。ここを増やす／直すことが最も多い
  normalize.mjs    URL正規化・ID生成・地域判定・重複判定の材料
  collect.mjs      収集の本体。既報判定と items.json の書き出し
  notify.mjs       Web Push 送信（秘密鍵に触れる唯一の場所）
supabase/schema.sql  ピック共有テーブルと行レベルセキュリティの定義
docs/              GitHub Pages の公開ディレクトリ = PWA
  data/items.json  収集結果（Actions が自動コミット）
state/
  seen.json        既報の記録。これが重複判定の正
  last-run.json    直近実行の結果。通知の要否と本文の材料
```

## 守ること

- `docs/` 配下は全世界に公開される。秘密情報を置かない
- 秘密鍵・購読情報は GitHub Secrets のみ。コミットもログ出力もしない
- 通知先は複数ある前提で書く。1台の失敗で他への送信を止めない
- スクレイピングは 1 ソースあたり 3 秒以上の間隔を空ける。RSS があるサイトでは必ず RSS を優先する
- `state/seen.json` を安易に削除しない。既報が全部再通知される
- Supabase の RLS ポリシーを無効化しない。anon キーは公開されているため、RLS だけが書き込みを守っている
- コメントとコミットメッセージは日本語で書く

## よく使うコマンド

```powershell
npm install
npm run collect          # 日付判定を飛ばして収集を即実行
npm run notify           # 直近実行の結果をもとに通知を送る
npx serve docs           # PWA をローカルで確認
npx web-push generate-vapid-keys
```
