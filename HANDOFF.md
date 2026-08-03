# HANDOFF.md

Claude.ai のチャットで設計と雛形作成まで完了した状態からの引き継ぎ資料です。
このファイルを最初に読んでから作業を始めてください。

## このプロジェクトは何か

ウルトラマン関連のイベント・特売情報を1日おきに自動収集し、iPhone の Safari（ホーム画面に追加した PWA）で閲覧できるようにするツール。
新着があればWeb Push で通知する。利用者は本人と配偶者の2名で、通知は両方の iPhone に届く。

## 現在地

| 状態 | 内容 |
|---|---|
| 完了 | 全体設計・アーキテクチャ確定 |
| 完了 | ディレクトリ構成、収集スクリプト、PWA、ワークフローの雛形 |
| 完了 | 正規化・重複判定ロジックの単体動作確認（`scripts/normalize.mjs`） |
| **未着手** | **実サイトの DOM を見た CSS セレクタの調整** ← 最優先 |
| 未着手 | GitHub リポジトリ作成・Pages 有効化 |
| 未着手 | VAPID 鍵生成と Secrets 登録 |
| 未着手 | iPhone 実機での通知受信テスト |

## 最初にやること（優先順）

### 1. 収集元のセレクタを実地で直す（最重要）

Claude.ai のサンドボックスは外部サイトへ接続できなかったため、
`scripts/sources.mjs` の HTML セレクタは**未検証の仮置き**です。

```powershell
npm install
npm run collect   # FORCE=true で日付判定を飛ばして即実行
```

ログに `✗ 円谷ステーション: ...` や取得 0 件が出たソースを、実際に`curl` で HTML を取って DOM を確認しながら直してください。

- まず `https://m-78.jp/feed/` が生きているか確認する。生きていれば`tsuburaya-event` の html 定義は捨てて rss 定義に一本化してよい
- Google ニュース RSS 系（`news-*`）は仕様が安定しているので、ここが動いていれば収集の骨格は成立している
- 各サイトの robots.txt と利用規約を確認すること。`POLITE_DELAY_MS` は3 秒に設定済み。短くしないこと

### 2. Supabase の用意

1. Supabase で新規プロジェクトを作る
2. SQL Editor に `supabase/schema.sql` を貼って実行する
3. Authentication → Users から2名ぶんのユーザーを手動作成する。**一般公開のサインアップは無効にしておくこと**
4. Settings → API から Project URL と anon キーを取得し、`docs/app.js` の `SUPABASE_URL` / `SUPABASE_ANON_KEY` に貼ってコミットする

### 3. リポジトリと Pages

```powershell
gh repo create ultraman-watch --public --source=. --push
```

- Settings → Pages → Source を `main` ブランチの `/docs` に設定
- 公開 URL を Actions の Variables に `SITE_URL` として登録

### 4. 通知の有効化

```powershell
npx web-push generate-vapid-keys
```

- **公開鍵** → `docs/app.js` の `VAPID_PUBLIC_KEY` に貼ってコミット
- **秘密鍵** → リポジトリの Secrets に `VAPID_PRIVATE_KEY` として登録。**絶対にコミットしない。ターミナルログにも残さない**
- `VAPID_SUBJECT` に `mailto:自分のアドレス` を登録
- **2台ぶん登録する。** 各 iPhone で Safari を開く → 共有 → ホーム画面に追加 → ホーム画面のアイコンから起動 → 「通知を有効にする」→ 表示された購読情報を取得。もう1台ぶんは「購読情報を共有」から LINE や AirDrop で送ってもらう
- 集めた購読情報を配列にまとめ、Secrets に `PUSH_SUBSCRIPTIONS` として登録する

  ```json
  [
    { "label": "自分", "subscription": { "endpoint": "...", "keys": { } } },
    { "label": "妻",   "subscription": { "endpoint": "...", "keys": { } } }
  ]
  ```

### 5. 通しテスト

Actions タブから `情報収集` を `workflow_dispatch` で手動実行し、新着が出て iPhone に通知が届くまでを確認する。

## 触る前に知っておくべき設計上の癖

- **`docs/` に秘密情報を置かない。** Pages で全世界に公開されます。
  秘密鍵に触れるのは `scripts/notify.mjs` だけで、Actions の
  Secrets 経由でしか渡していません。この分離を壊さないこと
- **cron は毎日起動する。** 1日おきの判定は `scripts/collect.mjs` 冒頭で通算日数の剰余を見て行っています。`*/2` は月をまたぐと連続実行になるため意図的にこの形にしています
- **重複判定は3段構え。** URL ハッシュ → タイトル+開催日のキー → バイグラム類似度 0.75。`state/seen.json` が正。ここを消すと既報が全部新着として再通知されます
- **`detectRegion` の実装順序に依存がある。** 「東京都」に「京都」が含まれるため、正式名称を先に消してから略称を探しています。この順序を入れ替えないこと
- **ピックの正は Supabase、IndexedDB は控え。** 圏外でも見られるよう、取得結果をそのまま鏡写ししています。書き込みは必ず Supabase 経由で、成功後に再描画します
- **anon キーはコミットしてよい。** 公開される前提のキーです。守るのは行レベルセキュリティ（RLS）の役目なので、`supabase/schema.sql` のポリシーを無効化しないこと
- **通知は1台失効しても止まらない。** `Promise.allSettled` で個別に送り、全滅したときだけワークフローを失敗させています

## 決まっていること・決まっていないこと

決定事項は `DECISIONS.md` を参照。まだ決めていないのは以下。

- 販売店・EC の特売情報をどこまで真面目に取るか（現状は楽天 API のスタブのみ。App ID を入れれば動く）
- 通知の主系が Web Push で足りるか、メールを並走させるか
- Supabase の無料プランは一定期間アクセスがないとプロジェクトが停止する。1日おきに使う想定なので問題になりにくいが、現行の条件は確認しておくこと
