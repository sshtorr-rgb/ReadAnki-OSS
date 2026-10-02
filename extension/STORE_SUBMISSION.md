# Chrome Web Store 提出チェックリスト

## 掲載情報

- 単一目的: 「閲覧中または貼り付け画像内の英文をAI解析し、Anki学習カードへ変換する」
- プライバシーポリシー: 正本 `https://sshtorr-rgb.github.io/ReadAnki-OSS/privacy.html`（リポジトリの `docs/privacy.html`）をDeveloper Dashboardへ登録。Googleサイトのミラーは同内容を転記し、正本URLを明記する
- `docs/privacy.html` と `extension/privacy.html` は同一内容に保つ（`RELEASE_CHECK.ps1` で検査）
- サポートURL: `https://github.com/sshtorr-rgb/ReadAnki-OSS/issues`
- 実UIを写した 1280×800 または 640×400 のスクリーンショットを最低1枚登録
- 128pxのストア用PNGと、16/32/48/128pxの拡張機能用PNGを追加して manifest の `icons` に登録
- 開発者アカウントの2段階認証を有効化し、連絡先メールを確認

## 説明文に必ず含める開示（Disclosure Requirements）

- 解析を実行したとき、選択した英文（最大500文字）とそれを含む1文、または貼り付け画像を、利用者が選んだLLMプロバイダ（Google Gemini / OpenAI / 利用者指定のサーバー）へ直接送信する
- 送信後の取り扱いには各プロバイダの規約が適用される
- インストール直後に同意画面を表示し、同意するまで送信しない

## Privacy practices の記載

- 収集するデータ種別: 「ウェブサイトのコンテンツ」（利用者が選択した英文と、それを含む1文）、「ユーザーが提供したコンテンツ」（貼り付け画像）。開発者は受け取らず、LLMプロバイダへ直接送信
- 解析結果は自動保存しない。利用者が解析画面で「履歴に保存」を押したときだけ端末内に保存（最大500件）。画像は保存しない
- 開発者は解析対象・APIキー・Ankiカードを中継、収集、販売、広告利用しない
- Limited Use 準拠の宣言はプライバシーポリシー第7節に記載

## 権限の理由

- `activeTab`: 利用者がポップアップ・右クリック・ショートカットを使ったタブにだけ解析UIを追加するため
- `scripting`: 上記タブへ解析UI（content.js / content.css）を注入するため
- `contextMenus`: 選択英文を右クリックから解析するため
- `storage`: 設定、同意状態、利用者が保存を選んだ履歴の保存
- ホスト `generativelanguage.googleapis.com` / `api.openai.com`: 利用者が選んだLLM APIへの送信
- ホスト `localhost` / `127.0.0.1`: 端末上のOllama・ローカルLLM・AnkiConnectとの通信
- オプションのホスト `https://*/*` / `http://*/*`: インストール時には要求しない。(1) 利用者が設定画面の「常に有効にするサイト」に登録したサイト、(2) 利用者が設定した外部のOpenAI互換サーバー、のホストだけを実行時に要求。登録サイトには `scripting.registerContentScripts` で解析UIを登録し、登録削除・権限取り消しで解除する
- 全サイトへの常時アクセス・`clipboardRead` は要求しない（画像は貼り付け枠からの paste イベントでも受け取れる）

## AnkiConnect

公開後の拡張IDを確認し、AnkiConnectの `webCorsOriginList` には次だけを登録する。

```json
["chrome-extension://<Chrome-Web-Storeの拡張ID>"]
```

`["*"]` は使用しない。
