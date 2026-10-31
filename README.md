# 家の管理ハブ

口座・クレジットカード・契約/固定費・書類/家電・ポイントカード/会員情報を1か所で把握し、期限の前にスマホへ通知する家庭用の PWA です。

- 要件定義: [docs/requirements.md](docs/requirements.md)
- セットアップ手順: [docs/setup.md](docs/setup.md)

## 構成

| 部分 | 内容 |
|---|---|
| `web/` | 画面（HTML・CSS・JavaScript、外部ライブラリなし）。GitHub Pages で公開 |
| `supabase/schema.sql` | データベース定義と RLS（Supabase の SQL Editor で実行） |
| `scripts/notify.mjs` | 毎朝の期限チェックと Web Push 送信（GitHub Actions で実行、Node.js 標準機能のみ） |
| `tests/` | 単体テスト・データベース/RLS テスト・ブラウザでの画面操作テスト |
| `tools/make_icons.py` | アプリアイコンの生成（Python 標準ライブラリのみ） |

パスワード・暗証番号・カード番号の全桁は保存しません（番号は下4桁のみ）。
