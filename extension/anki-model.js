// 日英（入力＋解説）専用ノートタイプの定義と作成処理。
// 設定画面（options.html）と background（importScripts）の両方から読み込む。

const JA_EN_MODEL_NAME = 'AnkiRead JP-EN（入力＋解説）';
const JA_EN_MODEL_CSS = `.card {
  font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", "Yu Gothic UI", sans-serif;
  font-size: 20px; line-height: 1.7; text-align: center;
  color: #1f2937; background: #ffffff; padding: 28px 18px;
}
.nightMode.card, .night_mode .card, .nightMode .card { color: #e5e7eb; background: #1f2329; }
.ra-label { font-size: 0.68em; letter-spacing: 0.12em; opacity: 0.5; margin-bottom: 0.6em; }
.ra-prompt { font-size: 1.35em; font-weight: 600; margin: 0 auto 1.1em; max-width: 30em; }
#typeans { font-size: 0.95em; width: 92%; max-width: 30em; padding: 0.45em 0.7em; border-radius: 10px;
  border: 1px solid rgba(128, 128, 128, 0.45); background: transparent; color: inherit; }
code#typeans { display: inline-block; text-align: left; line-height: 1.8; }
hr#answer { border: none; border-top: 1px solid rgba(128, 128, 128, 0.3); margin: 1.4em auto; max-width: 30em; }
.ra-explanation { text-align: left; max-width: 34em; margin: 0 auto; font-size: 0.85em; }`;

// AnkiConnect に1件の要求を送り、結果を返す。失敗時は具体的な文言の例外を投げる。
async function ankiConnectRequest(endpoint, action, params = {}) {
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, version: 6, params }),
    });
  } catch (error) {
    throw new Error(`AnkiConnect（${endpoint}）に接続できません。Ankiが起動していて、AnkiConnectが入っているか確認してください。`);
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`AnkiConnectエラー (HTTP ${res.status}): ${errText || res.statusText}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(`AnkiConnectエラー: ${data.error}`);
  return data.result;
}

// 専用ノートタイプが無ければ作る。作成済みならそのまま使う。
async function createJaEnModel(endpoint) {
  const existing = await ankiConnectRequest(endpoint, 'modelNames');
  if (Array.isArray(existing) && existing.includes(JA_EN_MODEL_NAME)) {
    return { created: false, modelName: JA_EN_MODEL_NAME };
  }
  await ankiConnectRequest(endpoint, 'createModel', {
    modelName: JA_EN_MODEL_NAME,
    inOrderFields: ['日本語', '英文', '解説'],
    css: JA_EN_MODEL_CSS,
    isCloze: false,
    cardTemplates: [{
      Name: '日本語→英語（入力）',
      Front: '<div class="ra-label">日本語 → 英語</div>\n<div class="ra-prompt">{{日本語}}</div>\n{{type:英文}}',
      Back: '{{FrontSide}}\n<hr id="answer">\n<div class="ra-explanation">{{解説}}</div>',
    }],
  });
  return { created: true, modelName: JA_EN_MODEL_NAME };
}
