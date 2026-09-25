# XERO Fortnite 冬季大会 運営 Bot

esports チーム **XERO** 主催の Fortnite 冬季大会（カスタムマッチ）を運営するための Discord Bot です。
試合の **リプレイファイル(.replay) を解析して、結果の記録・ポイント計算・順位表の更新を自動化**します。
あわせて、エントリー管理・チェックイン・ワンボタン告知などの運営作業を効率化します。

> キーの配布と Epic アカウントの本人認証は既存 Bot「**Yunite**」を併用する前提のため、本 Bot には実装していません。

---

## 目次

1. [リプレイ解析ライブラリの調査結果](#1-リプレイ解析ライブラリの調査結果)
2. [プロジェクト構成](#2-プロジェクト構成)
3. [セットアップ](#3-セットアップ)
4. [大会ルールの設定 (config/tournament.json)](#4-大会ルールの設定-configtournamentjson)
5. [コマンド一覧](#5-コマンド一覧)
6. [運用手順](#6-運用手順)
7. [リプレイの統合ルール](#7-リプレイの統合ルール)
8. [解析が壊れたときの手動入力](#8-解析が壊れたときの手動入力)
9. [常時稼働させる方法（デプロイ）](#9-常時稼働させる方法デプロイ)
10. [テスト・ログ](#10-テストログ)
11. [未確定事項・確認したいこと](#11-未確定事項確認したいこと)

---

## 1. リプレイ解析ライブラリの調査結果

### fortnite-replay-analysis (yuyutti/Fortnite_Replay_Analysis) — 採用

| 項目 | 内容 |
|---|---|
| バージョン | npm `fortnite-replay-analysis@1.3.6`（2026年時点の最新） |
| 仕組み | [FortniteReplayDecompressor](https://github.com/Shiqan/FortniteReplayDecompressor) を使った C#(.NET 10) の解析プログラムを、Node.js から子プロセスとして呼び出すラッパー |
| 外部依存 | **.NET ランタイムのインストールは不要**（linux-x64 / win-x64 向けの自己完結バイナリが同梱）。Linux では `libicu` が必要 |
| 対応 OS | Windows x64 / Linux x64。**macOS・ARM（Raspberry Pi 等）は非対応** |
| パッケージサイズ | 約 330MB（両 OS 分のバイナリ込み） |
| 取得できる項目 | プレイヤーごとの `Placement`（順位）・`Kills`・`TeamKills`・`EpicId`・`PlayerName`・`TeamIndex`（パーティ番号）・`IsBot`・`IsReplayOwner`（録画者）・死亡時刻、試合の `GameSessionId`、KillFeed（キルログ） |
| 順位の補完 | リプレイに順位が無いプレイヤーは KillFeed の撃破順から順位を復元（`hybrid` モード） |

**実際のリプレイで検証した結果**（FortniteReplayDecompressor リポジトリ同梱の Chapter 5 Season 5 スクワッドのリプレイ・12MB）:

- 解析時間: 約 1.8 秒
- 34 人全員の **順位・Epic ID・チーム番号が取得できた**
- セッションID（`GameSessionId`）も取得できた → 二重送信の検出に利用
- **キル数は 0 キルのプレイヤーだと `null` になる**（0 のときは値が記録されない仕様）。
  `TeamKills`（チーム合計キル）は個人キルの合計と一致していたため、Bot では
  「個人キルの合計」と「チームキル」の大きい方をチームのキル数として採用しています。
- 遠くのプレイヤーの情報は録画者のクライアントに届かないことがあるため、**同じ試合の複数リプレイを統合**できるようにしています（[7章](#7-リプレイの統合ルール)）。

> ⚠️ Fortnite のアップデートで解析が壊れる可能性があります。その場合は
> ① `npm update fortnite-replay-analysis` で更新 → `/replay reparse` で再解析、
> ② それでも駄目なら `/result-fix` で手動入力（[8章](#8-解析が壊れたときの手動入力)）で大会を続行できます。

### 代替案: 外部バイナリ方式

ライブラリが使えなくなった場合は、FortniteReplayDecompressor を使った .NET の CLI を自作（またはフォーク）し、
`.env` で `REPLAY_PARSER=external` / `REPLAY_PARSER_BIN=<実行ファイルのパス>` を指定すると、その CLI を子プロセスで呼び出します。
CLI は `<実行ファイル> <リプレイのパス>` で起動され、次の形式の JSON を標準出力に出す想定です。

```json
{ "GameData": { "GameSessionId": "..." }, "PlayerData": [ { "EpicId": "...", "PlayerName": "...", "TeamIndex": 3, "Placement": 1, "Kills": 4, "TeamKills": 9, "IsBot": false, "IsReplayOwner": true } ] }
```

---

## 2. プロジェクト構成

```
config/tournament.json   大会ルール（ポイント表・試合数・日程など）
src/
  index.ts               起動処理
  config.ts              .env と tournament.json の読み込み・検証
  logger.ts              ログ（コンソール + logs/bot.log、トークンは自動マスク）
  i18n/                  表示テキスト（ja.ts が基準、en.ts は英語。未翻訳は日本語にフォールバック）
  core/                  Discord に依存しない純粋なロジック（ユニットテスト対象）
    scoring.ts           ポイント計算
    standings.ts         順位表・タイブレーク
    matcher.ts           リプレイ上のプレイヤーと登録チームの照合
    merge.ts             複数リプレイの統合
    validation.ts        欠損・不自然な値の検出
  db/                    DB アクセス層（types.ts のインターフェース + SQLite 実装）
  replay/                解析エンジンのアダプタ・解析キュー・ダウンロード
  services/              エントリー・チェックイン・リプレイ・結果・順位表・告知の業務処理
  commands/              スラッシュコマンド・ボタン・モーダル
tests/                   ユニットテスト（vitest）
data/                    SQLite DB と保存したリプレイ（自動作成）
logs/                    ログファイル（自動作成）
```

**DB について**: Bot 本体は `src/db/types.ts` の `Repository` インターフェースにだけ依存しています。
Supabase(Postgres) に移行する場合は、同じインターフェースを実装したクラスを作り `src/db/index.ts` で差し替えるだけで済みます
（スキーマは `src/db/schema.ts`、標準的な SQL のみ使用）。

### テーブル

| テーブル | 内容 |
|---|---|
| teams | チーム（status: active=参加 / waitlist=キャンセル待ち / cancelled=取消、代表者） |
| players | メンバー（Discord ID・Epic 表示名・Epic ID） |
| matches | 試合（試合番号・セッションID・status: collecting / pending=承認待ち / approved / rejected・プレビュー） |
| replays | 送信されたリプレイ（保存パス・元URL・ハッシュ・解析状態・エラー・除外フラグ） |
| match_results | 試合ごとのチーム結果（順位・キル・順位P・キルP・合計P） |
| penalties | ペナルティ（減点・理由） |
| checkins | チェックイン（ラウンドごと、checked_in / absent） |
| templates | 告知テンプレート |
| audit_log | 承認・手動修正・取消などの操作履歴（修正前後の値を保存） |
| settings | 順位表メッセージID などの内部設定 |

提案からの主な変更点: 重複送信検出用に `replays.file_hash`、誤送信対策に `replays.excluded`、
キャンセル待ち管理に `teams.status=waitlist`、欠場管理に `checkins.status`、固定メッセージ管理に `settings` を追加しています。

---

## 3. セットアップ

### 3-1. Discord 側の準備

1. [Discord Developer Portal](https://discord.com/developers/applications) でアプリケーションを作成し、Bot を追加
2. **Bot → Privileged Gateway Intents** で **Server Members Intent** を ON（ロール付与・権限判定に使用）
3. **OAuth2 → URL Generator** で `bot` と `applications.commands` を選び、以下の権限を付けてサーバーに招待
   - チャンネルを見る / メッセージを送信 / 埋め込みリンク / ファイルを添付 / メッセージ履歴を読む / メッセージの管理（ピン留め用） / ロールの管理
4. サーバー設定で **Bot のロールを「参加者ロール」より上** に配置（下にあるとロールを付与できません）
5. 以下を用意し ID を控える（開発者モードを ON にして右クリック →「ID をコピー」）
   - ロール: 運営ロール / ホストロール / 参加者ロール
   - チャンネル: 運営専用 / チェックイン / 順位表 / 告知 / 配信者・実況者用

### 3-2. インストール

必要なもの: **Node.js 20 以上**、Linux x64 または Windows x64

```bash
npm install
cp .env.example .env        # .env を編集してトークン・ID を設定
# config/tournament.json を大会に合わせて編集
npm run build
npm run deploy-commands     # スラッシュコマンドをサーバーに登録
npm start
```

- `.env` は Git に含めないでください（`.gitignore` 済み）。トークンはログにも出力されません。
- **Bot はプロジェクトのフォルダ直下で起動**してください（解析ライブラリがカレントディレクトリからバイナリを探すため）。
- `config/tournament.json` の `format`（ソロ/デュオ…）を変えたら `npm run deploy-commands` を再実行してください（`/entry` のメンバー欄の数が変わるため）。
- 開発時は `npm run dev`（ファイル変更で自動再起動）。

---

## 4. 大会ルールの設定 (config/tournament.json)

```jsonc
{
  "name": "XERO Fortnite 冬季大会",
  "language": "ja",              // 表示言語 ja / en
  "format": "trio",              // solo / duo / trio / squad
  "totalMatches": 6,             // 総試合数
  "entry": {
    "open": true,                // false にすると即受付停止
    "deadline": "2026-12-20T23:59:00+09:00",  // 締切（過ぎると自動で受付停止）
    "maxTeams": 33,              // 定員（超えるとキャンセル待ち）
    "requireEpicId": false       // true なら Epic アカウントID を必須にする
  },
  "scoring": {
    "placementPoints": { "1": 11, "2": 6, "3": 5 },  // 順位ポイント（書いていない順位は 0 点）
    "pointsPerKill": 1,          // 1キルあたりのポイント
    "killCap": null,             // 1試合あたりのキル上限（null = 上限なし）
    "tiebreakers": ["victory_royales", "avg_kills", "avg_placement", "total_kills", "last_match_placement"]
  },
  "rounds": [                    // 試合日（ラウンド）ごとのチェックイン設定
    {
      "round": 1, "name": "Day1",
      "startAt": "2026-12-26T20:00:00+09:00",
      "matches": [1, 2, 3],               // このラウンドで行う試合番号
      "checkinOpenMinutesBefore": 60,     // 開始◯分前にチェックイン投稿
      "checkinCloseMinutesBefore": 15,    // 開始◯分前に締切（未チェックインは欠場扱い）
      "reminderMinutesBefore": [30, 10]   // 開始◯分前に参加者ロールへリマインド
    }
  ],
  "standings": { "displayTop": 20 },      // 順位表 Embed に表示するチーム数
  "validation": { "maxKillsPerPlayer": 40, "minLobbyPlayers": 10 }  // 不自然な値の判定基準
}
```

### タイブレーク

合計ポイントが同じ場合、`tiebreakers` に書いた順で比較します。

| キー | 内容 |
|---|---|
| `victory_royales` | ビクロイ数（多い方が上） |
| `avg_kills` | 1試合あたりの平均キル（多い方が上） |
| `avg_placement` | 平均順位（小さい方が上） |
| `total_kills` | 合計キル（多い方が上） |
| `last_match_placement` | 最終試合の順位（小さい方が上） |

未指定時のデフォルトは Fortnite 公式ルールに準拠した `victory_royales → avg_kills → avg_placement → last_match_placement` です。
すべて同じ場合は同順位になります。

**ルールを変えたとき**: `tournament.json` を編集してから `/recalculate` を実行すると、設定を読み直して、保存済みの順位・キル数から全試合のポイントを再計算し、順位表を更新します。

---

## 5. コマンド一覧

### 参加者向け（誰でも実行可）

| コマンド | 内容 |
|---|---|
| `/entry member2 member3 …` | チームでエントリー。実行者が代表者になり、モーダルでチーム名と各メンバーの Epic 表示名（任意で `, EpicアカウントID`）を入力。登録完了で参加者ロールを自動付与。定員超過時はキャンセル待ち |
| `/entry-edit [old_member new_member]` | 代表者がチーム名・Epic 名を修正、またはメンバーを入れ替え |
| `/entry-cancel` | 代表者がエントリーを取消（空いた枠はキャンセル待ちの先頭チームに自動で回り、ロール付与・DM 通知） |
| `/standings` | 現在の順位表を自分だけに表示 |
| チェックインボタン | チームの誰か 1 人が押せばチェックイン完了 |

### 運営向け（`.env` の `OPS_ROLE_IDS` のロールが必要。権限が無いと本人にだけ見えるメッセージで拒否）

| コマンド | 内容 |
|---|---|
| `/entry-list` | 登録チーム一覧（キャンセル待ち含む） |
| `/entry-edit team:` / `/entry-cancel team:` | 任意のチームの修正・取消 |
| `/checkin post\|close\|status round:` | チェックインの手動投稿・手動締切・状況確認（通常は自動） |
| `/submit-replay match: file:` / `url:` | リプレイ送信（**ホストロールでも実行可**） |
| `/replay list\|reparse\|exclude` | 送信済みリプレイの一覧・再解析・誤送信の除外 |
| `/result-fix match: team: reason: [placement] [kills] [delete]` | 結果の手動修正・手動入力（履歴を audit_log に保存） |
| `/result-show match:` | 試合ごとの内訳（順位P・キルP） |
| `/recalculate` | 設定を読み直して全試合のポイントを再計算 |
| `/standings-setup [channel]` | 自動更新される順位表メッセージを設置（ピン留め） |
| `/standings-export` | 全チームの順位表を CSV で出力 |
| `/final-results [top]` | 最終結果を告知チャンネルに投稿（CSV 添付） |
| `/penalty add\|remove\|list` | ペナルティ・警告の記録（減点は順位表に反映。0 点なら警告のみ） |
| `/template-add name: channel:` | 告知テンプレートを登録（本文はモーダルで入力） |
| `/template-edit` / `/template-delete` / `/template-list` | テンプレートの編集・削除・一覧 |
| `/announce-panel` | 実行したチャンネルに告知パネル（テンプレートのボタン一覧）を設置 |

#### テンプレートで使える変数

| 変数 | 内容 |
|---|---|
| `{tournament_name}` | 大会名 |
| `{match_number}` | 次の試合番号（確定済み試合数 + 1） |
| `{start_time}` | 次のラウンドの開始時刻（各ユーザーの時刻表示で出ます） |
| `{round_name}` | 次のラウンド名 |
| `{top3}` | 現在の上位 3 チーム |
| `{team_count}` | 参加チーム数 |
| `{total_matches}` | 総試合数 |

本文に `@everyone` やロールメンションを書けば、送信時にそのまま通知されます。

---

## 6. 運用手順

### 大会前

1. `config/tournament.json` を設定 → `npm run deploy-commands` → Bot 起動
2. 順位表チャンネルで `/standings-setup`
3. 運営チャンネルでテンプレートを登録（`/template-add`）し、`/announce-panel` で告知パネルを設置
4. 参加者に `/entry` を案内（締切日時を過ぎると自動で受付停止）

### 試合当日（自動で行われること）

- 開始 60 分前: チェックインチャンネルにボタン付きメッセージを投稿（参加者ロールにメンション）
- 開始 30 分前・10 分前: リマインダー
- 開始 15 分前: 締切。未チェックインのチームを **欠場扱い** にして運営チャンネルへ通知
- 開始時刻: 配信者・実況者チャンネルへ開始通知

時刻は `tournament.json` の `rounds` で変更できます。Bot が停止していた場合も、再起動時に未実行のイベントを実行します（古すぎるものはスキップ）。

### ホスト側: リプレイの保存と送信

1. **Fortnite の設定 → ゲーム → リプレイ → 「リプレイを記録」を ON**（PC 版のみ記録可能）
2. 試合終了後、リプレイは次の場所に保存されます
   - Windows: `%LOCALAPPDATA%\FortniteGame\Saved\Demos`
     （エクスプローラーのアドレスバーに貼り付けて開けます。更新日時が最新の `.replay` がその試合）
3. Discord で `/submit-replay match:<試合番号> file:<.replayファイル>` を実行
   - Discord のアップロード上限（通常 10MB）を超える場合は、Google Drive / Dropbox に置いて
     **「リンクを知っている全員が閲覧可」にした共有リンク** を `url:` に貼り付けてください（自動で直リンクに変換します）
4. Bot が「受付 → 解析中 → 解析完了」と同じメッセージを更新して進捗を知らせます
5. **精度を上げるため、同じ試合のリプレイを複数人（ホスト・観戦者・各チームの代表など）から送ることを推奨** します。自動で統合されます。

### 運営側: 結果の承認

1. 解析が終わると運営チャンネルに「**解析結果プレビュー**」が投稿されます
   （順位・チーム・キル・ポイント と、検出された警告）
2. 内容を確認して **「承認」** を押すと確定し、順位表メッセージが自動更新され、実況チャンネルにも通知されます
3. おかしい場合は **「却下」** → リプレイを再送信するか `/result-fix` で修正
4. 同じ試合に追加のリプレイが届くと、統合し直した新しいプレビューが投稿されます（古いプレビューのボタンは無効化）

#### 運営に通知される警告

- 登録されていないプレイヤーがロビーにいた
- 登録チームのプレイヤーがリプレイ上に見つからない（欠場扱いのチームは除外）
- 順位・キル数の欠損、不自然な値（上限超え・順位の重複など）
- 登録チームのメンバーが別パーティになっている
- 同じ試合（セッションID）のリプレイが別の試合番号で送信された / 同一ファイルの二重送信
- 同じ試合番号にセッションIDの異なるリプレイが混ざった（統合から除外）
- 複数リプレイ間で順位やキル数が食い違った

エラー（❌）がある場合はプレビューにその旨が表示されます。確認のうえ承認してください。

### 大会終了時

`/final-results` で告知チャンネルに最終結果（上位チーム + 全体の CSV）を投稿します。

---

## 7. リプレイの統合ルール

1 つのクライアントのリプレイには、遠くにいたプレイヤーの情報が欠けることがあります。
同じ試合に複数のリプレイが送られた場合、以下のルールで統合します（`src/core/merge.ts`）。

1. **対象**: 解析済みで除外されていない、同じセッションIDのリプレイ。別セッションのものは統合せず警告
2. **プレイヤーの同一視**: Epic ID（なければ表示名）で同じ人とみなし、どれか 1 つのリプレイにいれば結果に含める
3. **順位**: 値のあるものを採用。リプレイ間で食い違う場合は
   1. そのプレイヤーのチームが **録画者自身のチーム** であるリプレイの値（自チームの情報が最も正確なため）
   2. なければ多数決
   3. それでも決まらなければ良い方の順位

   を採用し、警告を出します
4. **キル数**: 取りこぼしは「少なくなる方向」にしかズレないため **最大値** を採用（異なる場合は情報として表示）
5. **チームの結果**: チームの順位 = メンバーの順位（食い違えば良い方＋警告）、
   チームのキル = 「メンバーの個人キル合計」と「リプレイ上のチームキル」の大きい方

誤って別の試合のリプレイを送った場合は `/replay list match:` で受付IDを確認し、`/replay exclude id:` で統合対象から外せます。

---

## 8. 解析が壊れたときの手動入力

Fortnite のアップデートで解析できなくなった場合でも、大会は手動入力で続行できます。

```
/result-fix match:3 team:チーム名 placement:1 kills:8 reason:リプレイ解析不可のため手動入力
```

- 試合が未登録でも作成され、確定扱いになります（順位表に即反映）
- 既存の結果の一部だけ（例: キル数だけ）を修正することもできます
- すべての修正は修正前後の値と理由が `audit_log` に保存されます
- 送信されたリプレイは `data/replays/` に保存されているので、ライブラリ更新後に `/replay reparse` で再解析できます（未確定の試合のみ）

---

## 9. 常時稼働させる方法（デプロイ）

解析バイナリの都合上、**Linux x64 または Windows x64** のマシンが必要です（Mac・Raspberry Pi は不可）。
リプレイ解析で一時的にメモリを数百MB使うため、**メモリ 1GB 以上** を推奨します。

### おすすめ構成

| 方法 | 向いているケース |
|---|---|
| **VPS（ConoHa / さくら / Vultr / Hetzner など、Linux x64・メモリ 1〜2GB）+ Docker** | 一番おすすめ。月数百〜千円程度で安定稼働 |
| VPS + pm2 | Docker を使わない場合 |
| 運営メンバーの Windows PC で起動 | 大会当日だけ動かせればよい場合（PC を落とすと止まる点に注意） |

### Docker（推奨）

```bash
cp .env.example .env   # 編集
docker compose up -d --build
docker compose run --rm bot node dist/scripts/deployCommands.js   # 初回・コマンド変更時
docker compose logs -f
```

`data/`（DB とリプレイ）・`logs/`・`config/` はホスト側に保存されるので、コンテナを作り直しても消えません。

### pm2

```bash
npm install && npm run build && npm run deploy-commands
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup   # OS 起動時に自動起動
```

### バックアップ

`data/tournament.db` と `data/replays/` を定期的にコピーしてください（大会期間中は各試合日の後に 1 回推奨）。

---

## 10. テスト・ログ

```bash
npm test           # ユニットテスト（ポイント計算・タイブレーク・プレイヤー照合・リプレイ統合・検証など）
npm run typecheck  # 型チェック
```

- ログはコンソールと `logs/bot.log` に出力されます（`LOG_LEVEL=debug|info|warn|error`）
- 解析に失敗した場合はエラー内容が運営チャンネルにも通知され、`/replay list` でも確認できます
- Bot トークンや Webhook URL はログ出力時に自動でマスクされます

---

## 11. 未確定事項・確認したいこと

仕様書 8 章の大会情報は未定のため、**仮の値** で設定しています（すべて `config/tournament.json` で変更できます）。

| 項目 | 仮の値 |
|---|---|
| 大会形式 | トリオ |
| 総試合数 | 6（2 日間 × 3 試合） |
| 順位ポイント | 1位 11 / 2位 6 / 3位 5 / 4-5位 4 / 6-7位 3 / 8-9位 2 / 10位 1 |
| キルポイント | 1 キル 1pt、上限なし |
| 参加チーム上限 | 33 チーム（トリオで 99 人） |
| プラットフォーム | 制限なし（リプレイの記録は PC のみ可能なので、ホストは PC 必須） |

確認したい点:

1. **統合ルール（7章）** はこの内容で問題ないか
2. **欠場扱いのチーム** がそのラウンドの試合に参加していた場合、結果として記録してよいか（現在は記録し、警告は出さない）
3. **エントリーの代表者以外のメンバー** にも修正・取消を許可するか（現在は代表者と運営のみ）
4. チェックインは **チームの 1 人が押せば OK** でよいか（全員必須にもできます）
5. 順位表の公開範囲（現在は `/standings` で誰でも閲覧可、固定メッセージも公開チャンネル想定）
