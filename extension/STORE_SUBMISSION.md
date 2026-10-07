# Chrome Web Store 提出チェックリスト

## 掲載情報

- 単一目的: 「閲覧中または貼り付け画像内の英文をAI解析し、Anki学習カードへ変換する」
- プライバシーポリシー: 正本 `https://sshtorr-rgb.github.io/ReadAnki/privacy.html`（リポジトリの `docs/privacy.html`）をDeveloper Dashboardへ登録。Googleサイトのミラーは同内容を転記し、正本URLを明記する
- `docs/privacy.html` と `extension/privacy.html` は同一内容に保つ（`RELEASE_CHECK.ps1` で検査）
- サポートURL: `https://github.com/sshtorr-rgb/ReadAnki/issues`
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
- 単語帳: 「＋単語」を押した語・その1文・記事のURLとタイトルを端末内にだけ保存。「AIで意味を付ける」を押したときだけ、語とその1文をLLMプロバイダへ送信（URL・タイトルは送らない）
- 開発者は解析対象・APIキー・Ankiカードを中継、収集、販売、広告利用しない
- Limited Use 準拠の宣言はプライバシーポリシー第7節に記載

## 権限の理由

- `activeTab`: 利用者がポップアップ・右クリック・ショートカットを使ったタブにだけ解析UIを追加するため
- `scripting`: 上記タブへ解析UI（content.js / content.css）を注入するため
- `contextMenus`: 選択英文を右クリックから解析するため
- `storage`: 設定、同意状態、利用者が保存を選んだ履歴と単語帳の保存
- ホスト `generativelanguage.googleapis.com` / `api.openai.com`: 利用者が選んだLLM APIへの送信
- ホスト `localhost` / `127.0.0.1`: 端末上のOllama・ローカルLLM・AnkiConnectとの通信
- オプションのホスト `https://*/*`: インストール時には要求しない。利用者が設定した外部のOpenAI互換サーバーのホストだけを、保存時に実行時に要求する
- 全サイトへの常時アクセス・`clipboardRead` は要求しない（画像は貼り付け枠からの paste イベントでも受け取れる）

## AnkiConnect

公開後の拡張IDを確認し、AnkiConnectの `webCorsOriginList` には次だけを登録する。

```json
["chrome-extension://<Chrome-Web-Storeの拡張ID>"]
```

`["*"]` は使用しない。

---

# Firefox Add-ons（AMO）提出チェックリスト（`firefox` ブランチ）

Mozilla Add-on Policies（2026-04-30 更新版）と照合済み。

## 提出設定

- 対応プラットフォーム: 「Firefox」と「Firefox for Android」の両方にチェック
- 対応バージョン: manifest の `strict_min_version`（パソコン 140 / Android 142）
- ソースコード提出: 不要（ビルド・圧縮・難読化をしていないため。Policies 3.1）
- プライバシーポリシー: AMO の「プライバシーポリシー」欄に `extension/privacy.html` の本文を貼り付ける（このブランチの内容。Firefox版の記載を含む）
- データ収集の申告: manifest の `browser_specific_settings.gecko.data_collection_permissions.required` に `websiteContent` を申告済み（選択英文・それを含む1文・貼り付け画像をLLMプロバイダへ送信するため。Policies 6.2.1）。インストール時に Firefox の同意画面に表示される

## 掲載文に必ず含める内容（Policies 1「No Surprises」）

- 解析を実行したとき（ボタンをタップ・クリックしたときだけ）、選択した英文（最大500文字）とそれを含む1文、または貼り付けた画像を、利用者が選んだLLMプロバイダ（Google Gemini / OpenAI / 利用者指定のサーバー）へ直接送信する。開発者のサーバーは経由しない
- 送信後の取り扱いには各プロバイダの規約が適用される
- インストール直後に同意画面を表示し、同意するまで送信しない
- 解析結果は「履歴に保存」を押したときだけ端末内に保存。プライベートウィンドウでは保存しない
- 利用には各LLMプロバイダのAPIキー（利用者自身のもの）が必要
- Firefox版には Anki 連携が無い（AnkiConnect への通信もしない）。★を付けた単語は、履歴画面の穴埋めテスト（端末内のみ）で復習する
- 「＋単語」で選んだ語・その1文・記事のURLとタイトルを、記事ごとの単語帳として端末内にだけ保存する。「AIで意味を付ける」を押したときだけ、語とその1文を LLM プロバイダへ送る（URL・タイトルは送らない）。プライベートウィンドウでは保存しない

## 審査員向けメモ（Policies 3「テスト情報」）

提出フォームの「審査員へのメモ」に次を書く。**APIキーはリポジトリやこのファイルに書かない。** 審査用に発行した、使用量の上限を低く設定したキーをフォームにだけ記入し、審査後に無効化する。

```
Test steps:
1. After install, the options page opens. Check the consent checkbox, choose "Google Gemini", paste the test API key below, and save.
2. Open any English news page, click the toolbar button > "このページで有効化" (Enable on this page).
3. Select an English sentence; a "⋯ ReadAnki" button appears (on Android, below the selection). Tap it, then "解説" (Explain).
4. The analysis card shows the grammar breakdown. "💾 履歴に保存" saves it locally; nothing is saved automatically.
Test Gemini API key: <審査用キーをここに記入（フォームのみ）>

Notes on innerHTML (linter warnings UNSAFE_VAR_ASSIGNMENT):
All dynamic values inserted via innerHTML in content.js and history.js are passed through escapeHtml(); the remaining templates are static strings.
```

## web-ext lint の結果（提出前に再確認）

- エラー: 0
- 警告: `UNSAFE_VAR_ASSIGNMENT`（innerHTML）のみ。動的な値はすべて `escapeHtml()` を通しており、上記メモで説明する
