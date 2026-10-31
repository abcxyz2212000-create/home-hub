# 家の管理ハブ セットアップ手順

最初に1回だけ行う作業です。所要時間の目安は30〜60分です。

> **注意**: Supabase・GitHub の画面のボタン名やメニューの場所は、2026-10-31 時点の情報をもとに書いています。実際の画面では変わっている可能性があります（未確認）。見つからない場合は、近い名前のメニューを探してください。

## 進捗(2026-11-01 時点)

| 手順 | 状態 |
|---|---|
| 1. Supabase のプロジェクト作成(`home-hub`、Tokyo、Free)と `supabase/schema.sql` の実行 | ✅ 完了 |
| 2. 共通アカウントの作成、新規登録の停止、所有者(`app_owner`)の登録 | ✅ 完了 |
| 3. `web/js/config.js` に接続先を設定 | ✅ プルリクエストで反映(マージ後に有効) |
| 4. GitHub Pages(リポジトリは公開、Source: GitHub Actions) | ✅ 公開済み(`https://abcxyz2212000-create.github.io/home-hub/`) |
| ログイン確認(共通アカウントでホーム画面が出るか) | ⬜ 未確認 |
| 5. 通知の鍵の作成と GitHub Secrets の登録 | ⬜ 未 |
| 6. 2人のスマホにアプリを追加し、通知を許可 | ⬜ 未 |
| 7. テスト通知 | ⬜ 未 |

メモ:
- Supabase の Database password は Chrome のパスワードマネージャーに保存済み(アプリでは使わない)。
- 共通アカウントのパスワードは、2人が使えるパスワードマネージャーに保存すること。
- Supabase のコネクタ(MCP)を接続すると、新しい会話から Claude が SQL の実行などを直接行える見込み(未確認)。接続時は `home-hub` プロジェクトだけに絞ること。

---

## 更新があったとき(データベースの変更)

`supabase/schema.sql` が変わったときは、Supabase の SQL Editor で**もう一度全文を実行**します。何度実行してもデータは消えません。公開サイト(`web/`)の更新より**先に**実行してください(先に画面だけ新しくなると、新しい項目を保存するときにエラーになります)。

- 2026-11-01: 口座に「金融機関コード」「支店番号」の列を追加
- 2026-11-01: 口座に「口座番号（全桁）」の列を追加

## Google ドライブの口座マスタからの移行

1. 設定画面の「家族の名前」に、口座名義の名前を登録します（表記を口座マスタと同じにします）。
2. 口座マスタのシートを CSV で書き出します（Google スプレッドシートなら「ファイル → ダウンロード → カンマ区切り形式（.csv）」）。表題の行や見出しはそのままで構いません。
3. 設定画面の「取り込み」で、台帳に「口座」を選んで取り込みます。
4. 取り込んだ内容を画面で確認したら、**Google ドライブのシートを削除し、ゴミ箱も空にします**。ダウンロードした CSV も削除します。

- 先頭の0が消えた口座番号（Excel で開き直したときなど）は、そのまま取り込まれます。取り込む前に確認してください。

## 全体の流れ

1. Supabase にプロジェクトを作り、データベースを準備する
2. 共通アカウントを作り、新規登録を止める
3. アプリに Supabase の接続先を設定する
4. GitHub Pages で公開する
5. 通知の鍵を作り、GitHub に秘密の値を登録する
6. 2人のスマホにアプリを追加し、通知を受け取る設定をする
7. テスト通知を送って確認する

---

## 1. Supabase のプロジェクトを作る

1. https://supabase.com/ を開き、「Start your project」などから **GitHub アカウントでサインイン**します。
2. 「New project」でプロジェクトを作ります。
   - Name: `home-hub`（任意）
   - Database Password: 長いパスワードを自動生成し、**Google パスワードマネージャーに保存**します（普段は使いませんが、無くすと困ります）。
   - Region: **Northeast Asia (Tokyo)**
   - Plan: **Free**
3. 作成が終わるまで数分待ちます。

### データベースを準備する

1. 左メニューの **SQL Editor** を開き、「New query」を押します。
2. このリポジトリの `supabase/schema.sql` の中身を**全部**コピーして貼り付け、**Run** を押します。
3. 「Success」と表示されれば完了です。何回実行してもデータは消えません。

## 2. 共通アカウントを作り、新規登録を止める

1. 左メニューの **Authentication** → **Users** → 「Add user」→「Create new user」を選びます。
   - Email: 2人で使う共通のメールアドレス
   - Password: Google パスワードマネージャーで生成した**長いパスワード**
   - 「Auto Confirm User」にチェックを入れます。
2. **新規登録を止めます（最重要）**: Authentication の設定（Sign In / Providers など）で **「Allow new users to sign up」をオフ**にして保存します。
   - これを忘れると、他人がアカウントを作れてしまいます。ただし、その場合でもデータは次の手順で守られます。
3. もう一度 **SQL Editor** を開き、次の SQL のメールアドレスを書き換えて実行します。この共通アカウントだけがデータを読み書きできるようになります。

```sql
insert into public.app_owner (user_id)
select id from auth.users where email = 'ここに共通アカウントのメールアドレス'
on conflict (singleton) do update set user_id = excluded.user_id;
```

   - 「INSERT 0 1」などと表示されれば成功です。「INSERT 0 0」の場合はメールアドレスが違っています。

## 3. アプリに接続先を設定する

1. Supabase の **Project Settings** → **API**（または **API Keys**）を開き、次の2つを控えます。
   - **Project URL**（`https://xxxx.supabase.co` の形）
   - **公開用のキー**: 「Publishable key」（`sb_publishable_...`）または「anon public」キー（`eyJ...`）
2. GitHub でこのリポジトリの `web/js/config.js` を開き、鉛筆アイコン（Edit）で次のように書き換えて、「Commit changes」で保存します。

```js
export const CONFIG = {
  supabaseUrl: 'https://xxxx.supabase.co',
  supabaseKey: 'sb_publishable_xxxx',
};
```

> **秘密のキー（Secret key / service_role）は絶対に config.js に書かないでください。** config.js は公開されます。公開用のキーは公開しても問題ないもので、データは RLS で守られます。

## 4. GitHub Pages で公開する

1. 変更が `main` に入っていることを確認します（以後の変更はプルリクエストで `main` に取り込みます）。
2. リポジトリの **Settings** → **Pages** を開き、「Build and deployment」の **Source** を **GitHub Actions** にします。
3. **Actions** タブで「GitHub Pages」が緑のチェックになるまで待ちます（数分）。
4. `https://<GitHubのユーザー名>.github.io/home-hub/` を開き、ログイン画面が出れば成功です。
   - GitHub Pages を無料で使うには、リポジトリを公開（Public）にする必要があります（2026-10-31 に GitHub の画面で確認）。公開されるのはプログラムと文書だけで、台帳のデータは含まれません。

## 5. 通知の鍵を作り、GitHub に登録する

1. PC でアプリを開いてログインし、**設定** → 「通知（この端末）」→ **通知の鍵を作成** を押します。
2. 表示された **秘密の値** をコピーします（この値は二度と表示されません）。
3. GitHub のリポジトリ → **Settings** → **Secrets and variables** → **Actions** → **New repository secret** で、次の2つを登録します。

| Name | Secret に入れる値 |
|---|---|
| `VAPID_PRIVATE_KEY` | 手順2でコピーした秘密の値 |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase の Project Settings → API にある **Secret key**（`sb_secret_...`）または **service_role** キー |

> `SUPABASE_SERVICE_ROLE_KEY` は全データを読み書きできる強い鍵です。GitHub の Secrets 以外（チャット・メール・ファイル）には絶対に貼り付けないでください。

## 6. スマホにアプリを追加して通知を受け取る（2人とも）

1. Android の **Chrome** で `https://<GitHubのユーザー名>.github.io/home-hub/` を開き、ログインします。
2. Chrome のメニュー（︙）→ **ホーム画面に追加**（または「アプリをインストール」）を選びます。
3. ホーム画面のアイコンからアプリを開き、**設定** → **この端末で通知を受け取る** を押して、通知を**許可**します。
4. PC でも通知を受け取りたい場合は、PC の Chrome / Edge で同じ操作をします。

## 7. テスト通知を送る

1. GitHub のリポジトリ → **Actions** → 左の一覧から **毎朝の通知** を選びます。
2. **Run workflow** → 実行内容で **テスト通知** を選び、緑の **Run workflow** を押します。
3. 1〜2分で各端末に「テスト通知」が届けば完了です。
   - 届かない場合は、実行結果のログを確認してください（ログに台帳の名前は出ません）。

以後は毎朝8時ごろ（UTC 23:00）に自動で期限をチェックし、通知します。

---

## 運用上の注意

- **通知の時刻**: GitHub Actions の定期実行は、混雑で数分〜それ以上遅れることがあります（未確認）。
- **定期実行の自動停止**: 公開リポジトリでは、**60日間リポジトリに更新が無いと定期実行が自動で止まります**（未確認）。止まる前に GitHub からメールが届く見込みです。届いたら **Actions** → **毎朝の通知** で「Enable workflow」を押して再開してください。
- **Supabase の一時停止**: 無料プランは1週間アクセスが無いと一時停止します（未確認）。毎朝の通知処理が毎日アクセスするので、通常は止まりません。止まった場合は Supabase の管理画面からプロジェクトを再開（Restore）してください。データは消えません。
- **バックアップ**: Supabase の無料プランには自動バックアップがありません。**設定** → **全データを書き出す（ZIP）** を月1回程度行ってください（30日たつとホーム画面でお知らせします）。
- **端末をなくしたとき**: **設定** → **すべての端末からログアウト** を押してから、Supabase の Authentication → Users で共通アカウントのパスワードを変更し、Google パスワードマネージャーも更新してください。
- **メールアドレスの非公開設定**: GitHub の Settings → Emails で「Keep my email addresses private」と「Block command line pushes that expose my email」を On にしています。PC の Git から送信して止められた場合は、PC の Git のメールアドレスを `350591672+abcxyz2212000-create@users.noreply.github.com` に設定してから記録し直してください。
- **通知の鍵を無くしたとき**: **設定** → 「通知の鍵を作り直す」で作り直し、`VAPID_PRIVATE_KEY` を登録し直してから、各端末で通知の設定をやり直してください。

## 開発者向け: テストの実行

```bash
npm test
```

```bash
PGHOST=localhost PGUSER=postgres sh tests/sql/run.sh
```

```bash
node tests/e2e/run.mjs
```

- `npm test`: 単体テスト（期限計算・CSV・ZIP・入力チェック・通知の暗号化と送信）。外部ライブラリは不要です。
- `tests/sql/run.sh`: データベース定義と RLS のテスト。PostgreSQL が必要です。
- `tests/e2e/run.mjs`: ブラウザでの画面操作テスト。Playwright と Chromium が必要です（アプリ本体の依存ではありません）。
