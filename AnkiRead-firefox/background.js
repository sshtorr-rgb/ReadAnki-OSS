// ReadAnki Background Service Worker (UI v3 / 2-pass analysis)
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // データ処理の説明と同意を、最初の解析より前に確実に表示する。
    chrome.runtime.openOptionsPage();
  }
  chrome.storage.local.get(['llmConfig', 'ankiConfig'], (res) => {
    if (!res.llmConfig) {
      chrome.storage.local.set({
        llmConfig: {
          provider: 'gemini',
          ollamaUrl: 'http://localhost:11434',
          ollamaModel: 'llama3.2',
          localOpenAiUrl: 'http://localhost:1234/v1',
          localOpenAiModel: 'local-model',
          localOpenAiApiKey: '',
          geminiModel: 'gemini-3.1-flash-lite',
          openAiModel: 'gpt-4o-mini',
        },
        // Firefox版はAnki連携を持たない。保存キー名は互換のため ankiConfig のまま（語義の表示方法だけを持つ）。
        ankiConfig: {
          wordDefinitionMode: 'llm-japanese',
        },
      });
    }
  });
  syncAllowedSiteScripts();
  // Firefox for Android には右クリックメニューが無い。
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'readanki-explain-selection',
      title: 'ReadAnki: 文法解説',
      contexts: ['selection'],
    });
  });
});

// 全サイトへの常駐はせず、ユーザー操作（右クリック・ポップアップ・ショートカット）で
// activeTab が付与されたタブにだけ content script を注入する。
async function ensureInjected(tabId) {
  const [{ result: alreadyInjected } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => Boolean(window.__readankiActiveInstance),
  });
  if (alreadyInjected) return;
  await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

// ============================================================
// 許可サイト: 利用者が設定画面で登録し、個別に権限を許可したサイトだけで常に content script を動かす。
// allowedSites（storage.local）と実際に許可されている権限の両方を満たすサイトだけを登録する。
// ============================================================
const ALLOWED_SITES_SCRIPT_ID = 'readanki-allowed-sites';

function sitePatterns(host) {
  return [`https://${host}/*`, `http://${host}/*`];
}

async function grantedAllowedSites() {
  const { allowedSites = [] } = await chrome.storage.local.get('allowedSites');
  const sites = Array.isArray(allowedSites) ? allowedSites.filter((host) => typeof host === 'string' && host) : [];
  const { origins = [] } = await chrome.permissions.getAll();
  const granted = new Set(origins);
  return sites
    .map((host) => ({ host, matches: sitePatterns(host).filter((pattern) => granted.has(pattern)) }))
    .filter((site) => site.matches.length);
}

let allowedSitesSyncQueue = Promise.resolve();

function syncAllowedSiteScripts() {
  const sync = async () => {
    const sites = await grantedAllowedSites();
    const matches = sites.flatMap((site) => site.matches);
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [ALLOWED_SITES_SCRIPT_ID] });
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [ALLOWED_SITES_SCRIPT_ID] });
    if (!matches.length) return;
    await chrome.scripting.registerContentScripts([{
      id: ALLOWED_SITES_SCRIPT_ID,
      matches,
      js: ['content.js'],
      css: ['content.css'],
      runAt: 'document_idle',
      persistAcrossSessions: true,
    }]);
  };
  allowedSitesSyncQueue = allowedSitesSyncQueue.then(sync, sync).catch((error) => {
    console.warn('ReadAnki: failed to sync allowed sites', error);
  });
  return allowedSitesSyncQueue;
}

// chrome://extensions などで権限が取り消されたら、登録一覧からも外す。
chrome.permissions.onRemoved.addListener(async ({ origins = [] }) => {
  if (!origins.length) return;
  const { allowedSites = [] } = await chrome.storage.local.get('allowedSites');
  const remaining = (await chrome.permissions.getAll()).origins || [];
  const stillGranted = new Set(remaining);
  const next = (Array.isArray(allowedSites) ? allowedSites : []).filter((host) =>
    sitePatterns(host).some((pattern) => stillGranted.has(pattern))
  );
  if (next.length !== allowedSites.length) await chrome.storage.local.set({ allowedSites: next });
  syncAllowedSiteScripts();
});
chrome.permissions.onAdded.addListener(() => syncAllowedSiteScripts());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.allowedSites) syncAllowedSiteScripts();
});
chrome.runtime.onStartup.addListener(() => syncAllowedSiteScripts());

chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'readanki-explain-selection' || !tab?.id) return;
  try {
    await ensureInjected(tab.id);
    await chrome.tabs.sendMessage(tab.id, {
      action: 'explainFromContextMenu',
      text: info.selectionText || '',
    });
  } catch (error) {
    console.warn('ReadAnki: このページでは実行できません', error);
  }
});

chrome.commands?.onCommand.addListener(async (command, tab) => {
  if (command !== 'activate-readanki' || !tab?.id) return;
  try {
    await ensureInjected(tab.id);
  } catch (error) {
    console.warn('ReadAnki: このページでは実行できません', error);
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'explain') {
    handleExplain(request).then(sendResponse);
    return true;
  }

  if (request.action === 'explainImage') {
    handleExplainImage(request).then(sendResponse);
    return true;
  }

  if (request.action === 'saveHistory') {
    // 解析カード（content script）の「履歴に保存」ボタンからのみ受け付ける。
    if (!sender.tab) return false;
    // プライベートブラウジング中のデータは保存しない（Firefox Add-on Policies 6.3）。
    if (sender.tab.incognito) {
      sendResponse({ success: false, error: 'プライベートウィンドウでは履歴を保存できません' });
      return false;
    }
    handleSaveHistory(request).then(sendResponse);
    return true;
  }

  if (request.action === 'toggleUnknownWord') {
    Promise.resolve(handleToggleUnknownWord(request)).then(sendResponse);
    return true;
  }

  if (request.action === 'getWordDefinition') {
    handleGetWordDefinition(request).then(sendResponse);
    return true;
  }

  if (request.action === 'getParaphrase') {
    handleGetParaphrase(request).then(sendResponse);
    return true;
  }

  if (request.action === 'generateExampleSentences') {
    handleGenerateExampleSentences(request).then(sendResponse);
    return true;
  }

  if (request.action === 'openHistory') {
    chrome.tabs.create({ url: chrome.runtime.getURL('history.html') });
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'openOptions') {
    try {
      if (chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage();
      } else {
        chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
      }
    } catch (e) {
      chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
    }
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'activateTab') {
    // 拡張機能ページ（ポップアップ）からの要求のみ受け付ける。
    if (sender.tab) return false;
    ensureInjected(request.tabId)
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'getDiagnostic') {
    getDiagnostic().then(sendResponse);
    return true;
  }
});

// 送信・保存する量をプライバシーポリシーの記載（選択英文と、それを含む1文）に合わせて制限する。
const MAX_TARGET_CHARS = 500;
const MAX_CONTEXT_CHARS = 500;

function clampText(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

const SECRET_CONFIG_KEYS = ['localOpenAiApiKey', 'openAiApiKey', 'geminiApiKey'];

async function getLlmConfig() {
  const [{ llmConfig = {} }, { llmSecrets = {} }] = await Promise.all([
    chrome.storage.local.get('llmConfig'),
    chrome.storage.session.get('llmSecrets'),
  ]);
  return { ...llmConfig, ...llmSecrets };
}

function endpointUrl(rawUrl, fallback, label) {
  let url;
  try {
    url = new URL(String(rawUrl || fallback).trim());
  } catch {
    throw new Error(`${label}のURLが正しくありません。`);
  }
  const isLoopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback)) return url;
  throw new Error(`${label}はHTTPS、またはlocalhost / 127.0.0.1 のHTTP URLを指定してください。`);
}

function localEndpointUrl(rawUrl, fallback, label) {
  const url = endpointUrl(rawUrl, fallback, label);
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)) {
    throw new Error(`${label}はlocalhost / 127.0.0.1 のみ指定できます。`);
  }
  return url;
}

async function requirePrivacyConsent() {
  const { privacyConsent } = await chrome.storage.local.get('privacyConsent');
  if (!privacyConsent) throw new Error('初回設定でデータ処理への同意が必要です。ReadAnkiの設定を開いて同意してください。');
}

async function recordDiagnostic(kind, provider, error) {
  const safeError = String(error || '不明なエラー').replace(/(?:sk-|AIza)[A-Za-z0-9_\-]+/g, '[REDACTED]');
  await chrome.storage.session.set({
    lastDiagnostic: { kind, provider: provider || 'unknown', error: safeError.slice(0, 300), occurredAt: Date.now() },
  });
}

async function getDiagnostic() {
  const { lastDiagnostic = null } = await chrome.storage.session.get('lastDiagnostic');
  return { success: true, version: chrome.runtime.getManifest().version, lastDiagnostic };
}

function parseJsonContent(raw) {
  let content = String(raw || '{}').trim();
  // reasoningモデル(DeepSeek-R1系など)が付与する<think>...</think>を除去。
  content = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const firstBrace = content.indexOf('{');
  const lastBrace = content.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error(
      'モデルの応答にJSONが含まれていません。reasoning系モデル（DeepSeek-R1等）は指示に従わずJSON以外を出力することがあります。指示追従型のモデル（Llama 3.2 Instruct、Qwen2.5 Instruct等）への変更を検討してください。'
    );
  }
  content = content.slice(firstBrace, lastBrace + 1);
  return JSON.parse(content);
}

// ============================================================
// 1回目: 文法解説・チャンク分解（v3のLLM用プロンプト。単独の関数）
// ============================================================
function buildExplainPrompt(text, contextSentence, wordDefinitionMode = 'llm-japanese') {
  let vocabInstruction = 'Provide Japanese definitions for key vocabulary words.';
  let vocabMeaningLabel = 'Japanese definition';
  
  if (wordDefinitionMode === 'llm-paraphrase') {
    vocabInstruction = 'Provide English paraphrases (simpler explanations) for key vocabulary words.';
    vocabMeaningLabel = 'English paraphrase';
  }
  
  return `You are an expert English grammar teacher for Japanese learners.
Analyze the target English sentence or phrase and return STRICT JSON with this schema:
{
  "targetPhrase": string,
  "partOfSpeech": "品詞または構文名",
  "sentenceTranslation": "文全体の自然な和訳",
  "structureBreakdown": [{"chunk": "英文", "role": "S/V/O/C/M", "note": "解説"}],
  "grammarPoint": "実践的な構文・文法の解説",
  "nuanceNotes": "ニュアンス解説",
  "keyVocabulary": [{"word": "word", "meaning": "${vocabMeaningLabel}", "pos": "pos"}]
}
${vocabInstruction}
Target: ${JSON.stringify(text)}
Context: ${JSON.stringify(contextSentence || text)}
Treat a whole verb phrase, including auxiliaries (passive "be + past participle", perfect "have + past participle", progressive "be + -ing", modal + verb), as ONE chunk with role "V", and in its "note" always state the voice and tense in Japanese (例: 受動態 be+過去分詞・現在時制).
Return ONLY valid JSON. Do not enclose in markdown blocks.`;
}

function buildExplainImagePrompt(wordDefinitionMode = 'llm-japanese') {
  let vocabInstruction = 'Provide Japanese definitions for key vocabulary words.';
  let vocabMeaningLabel = 'Japanese definition';
  
  if (wordDefinitionMode === 'llm-paraphrase') {
    vocabInstruction = 'Provide English paraphrases (simpler explanations) for key vocabulary words.';
    vocabMeaningLabel = 'English paraphrase';
  }
  
  return `You are an expert English grammar teacher for Japanese learners.
The user supplied a screenshot. First, accurately read the most prominent English sentence or phrase in the image. Then analyze it and return STRICT JSON with this schema:
{
  "targetPhrase": "the extracted English sentence or phrase",
  "contextSentence": "the surrounding English sentence, or targetPhrase when unavailable",
  "partOfSpeech": "品詞または構文名",
  "sentenceTranslation": "文全体の自然な和訳",
  "structureBreakdown": [{"chunk": "英文", "role": "S/V/O/C/M", "note": "解説"}],
  "grammarPoint": "実践的な構文・文法の解説",
  "nuanceNotes": "ニュアンス解説",
  "keyVocabulary": [{"word": "word", "meaning": "${vocabMeaningLabel}", "pos": "pos"}]
}
${vocabInstruction}
If no readable English text exists, return valid JSON with an empty targetPhrase and explain why in grammarPoint.
Treat a whole verb phrase, including auxiliaries (passive "be + past participle", perfect "have + past participle", progressive "be + -ing", modal + verb), as ONE chunk with role "V", and in its "note" always state the voice and tense in Japanese (例: 受動態 be+過去分詞・現在時制).
Return ONLY valid JSON. Do not enclose in markdown blocks.`;
}

// ============================================================
// LLM呼び出しの共通化（ollama / local-openai / openai / gemini）
// ============================================================
async function askLlm(prompt, config) {
  const provider = config.provider || 'gemini';

  if (provider === 'ollama') {
    const baseUrl = localEndpointUrl(config.ollamaUrl, 'http://localhost:11434', 'Ollama').toString().replace(/\/+$/, '');
    const model = config.ollamaModel || 'llama3.2';
    const res = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false, format: 'json' }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Ollamaエラー (HTTP ${res.status}): ${errText || res.statusText}`);
    }
    const data = await res.json();
    return parseJsonContent(data.response);
  }

  if (provider === 'local-openai') {
    let baseUrl = endpointUrl(config.localOpenAiUrl, 'http://localhost:1234/v1', 'OpenAI互換サーバー').toString().replace(/\/+$/, '');
    if (!baseUrl.endsWith('/chat/completions')) {
      if (!baseUrl.endsWith('/v1')) baseUrl += '/v1';
      baseUrl += '/chat/completions';
    }
    const model = config.localOpenAiModel || 'local-model';
    const headers = { 'Content-Type': 'application/json' };
    headers.Authorization = `Bearer ${config.localOpenAiApiKey || 'not-needed'}`;
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You are a JSON-only assistant. Always answer with strict JSON.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`ローカルOpenAI互換サーバーエラー (HTTP ${res.status}): ${errText || res.statusText}`);
    }
    const json = await res.json();
    return parseJsonContent(json.choices?.[0]?.message?.content || '{}');
  }

  if (provider === 'openai') {
    const apiKey = config.openAiApiKey;
    if (!apiKey) throw new Error('OpenAI APIキーが設定されていません');
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: config.openAiModel || 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'Output strict JSON only.' },
          { role: 'user', content: prompt },
        ],
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`OpenAIエラー (HTTP ${res.status}): ${errText || res.statusText}`);
    }
    const json = await res.json();
    return parseJsonContent(json.choices[0].message.content);
  }

  // gemini（既定）
  const apiKey = (config.geminiApiKey || '').trim();
  if (!apiKey) {
    throw new Error('Gemini APIキーが設定されていません。設定画面でGoogle AI StudioのAPIキーを入力してください。');
  }
  const configuredModel = (config.geminiModel || '').trim();
  // gemini-2.0-flash は2026/6/1、gemini-2.5-flash/pro は2026/10/16 に順次シャットダウン予定。
  // 未設定・旧モデル名のどちらも現行世代へ寄せる。
  const DEPRECATED_MODELS = ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'];
  const model = !configuredModel || DEPRECATED_MODELS.includes(configuredModel)
    ? 'gemini-3.1-flash-lite'
    : configuredModel;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
      },
    }),
  });
  const rawResponse = await res.text();
  let json;
  try {
    json = JSON.parse(rawResponse);
  } catch {
    const contentType = res.headers.get('content-type') || 'unknown';
    const responseKind = rawResponse.trim().startsWith('<') ? 'HTML' : 'JSONではないデータ';
    throw new Error(
      `Gemini APIから${responseKind}が返されました (HTTP ${res.status}, Content-Type: ${contentType})。` +
        `応答URL: ${res.url || '取得不可'}。` +
        'Google AI StudioのAPIキー制限、ネットワークの認証ページ・プロキシ設定を確認してください。'
    );
  }
  if (!res.ok) {
    const message = json?.error?.message || res.statusText;
    throw new Error(`Gemini APIエラー (HTTP ${res.status}): ${message}`);
  }
  const content = json.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || '')
    .join('')
    .trim();
  if (!content) {
    const reason = json.promptFeedback?.blockReason || json.candidates?.[0]?.finishReason;
    throw new Error(`Geminiから解析結果を取得できませんでした${reason ? ` (${reason})` : ''}`);
  }
  return parseJsonContent(content);
}

async function askLlmWithImage(prompt, image, config) {
  const provider = config.provider || 'gemini';
  const mimeType = image.mimeType;
  const base64 = image.base64;
  const dataUrl = `data:${mimeType};base64,${base64}`;

  if (provider === 'ollama') {
    const baseUrl = localEndpointUrl(config.ollamaUrl, 'http://localhost:11434', 'Ollama').toString().replace(/\/+$/, '');
    const model = config.ollamaModel || 'llama3.2';
    const res = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false, format: 'json', images: [base64] }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Ollama画像解析エラー (${model}, HTTP ${res.status}): ${errText || res.statusText}`);
    }
    const data = await res.json();
    return parseJsonContent(data.response);
  }

  if (provider === 'local-openai' || provider === 'openai') {
    const isOpenAi = provider === 'openai';
    const apiKey = isOpenAi ? config.openAiApiKey : config.localOpenAiApiKey;
    if (isOpenAi && !apiKey) throw new Error('OpenAI APIキーが設定されていません');
    let url;
    let model;
    if (isOpenAi) {
      url = 'https://api.openai.com/v1/chat/completions';
      model = config.openAiModel || 'gpt-4o-mini';
    } else {
      url = endpointUrl(config.localOpenAiUrl, 'http://localhost:1234/v1', 'OpenAI互換サーバー').toString().replace(/\/+$/, '');
      if (!url.endsWith('/chat/completions')) {
        if (!url.endsWith('/v1')) url += '/v1';
        url += '/chat/completions';
      }
      model = config.localOpenAiModel || 'local-model';
    }
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey || 'not-needed'}` };
    const body = {
      model,
      messages: [
        { role: 'system', content: 'You are a JSON-only assistant. Always answer with strict JSON.' },
        { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUrl } }] },
      ],
      temperature: 0.2,
    };
    if (isOpenAi) body.response_format = { type: 'json_object' };
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`${isOpenAi ? 'OpenAI' : 'OpenAI互換サーバー'}画像解析エラー (${model}, HTTP ${res.status}): ${errText || res.statusText}`);
    }
    const json = await res.json();
    return parseJsonContent(json.choices?.[0]?.message?.content || '{}');
  }

  const apiKey = (config.geminiApiKey || '').trim();
  if (!apiKey) throw new Error('Gemini APIキーが設定されていません。設定画面でGoogle AI StudioのAPIキーを入力してください。');
  const configuredModel = (config.geminiModel || '').trim();
  const DEPRECATED_MODELS = ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'];
  const model = !configuredModel || DEPRECATED_MODELS.includes(configuredModel)
    ? 'gemini-3.1-flash-lite'
    : configuredModel;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: base64 } }, { text: prompt }] }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
    }),
  });
  const rawResponse = await res.text();
  let json;
  try {
    json = JSON.parse(rawResponse);
  } catch {
    throw new Error(`Gemini画像解析エラー (${model}, HTTP ${res.status}): JSONではない応答が返されました。`);
  }
  if (!res.ok) throw new Error(`Gemini画像解析エラー (${model}, HTTP ${res.status}): ${json?.error?.message || res.statusText}`);
  const content = json.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('').trim();
  if (!content) throw new Error(`Geminiから画像解析結果を取得できませんでした (${model})`);
  return parseJsonContent(content);
}

// ============================================================
// 単語定義取得
// ============================================================
async function handleGetWordDefinition(request) {
  const { word } = request;
  if (!word) return { success: false, error: '単語が指定されていません' };
  
  const ankiConfig = (await chrome.storage.local.get(['ankiConfig'])).ankiConfig || {};
  const mode = ankiConfig.wordDefinitionMode || 'llm-japanese';
  
  try {
    await requirePrivacyConsent();
    
    if (mode === 'llm-japanese') {
      const config = await getLlmConfig();
      const prompt = `Provide a Japanese definition for the English word "${word}". Return JSON with this schema: {"word": "${word}", "definition": "Japanese definition", "example": "example sentence"}. Return ONLY valid JSON.`;
      const data = await askLlm(prompt, config);
      return { success: true, mode: 'llm-japanese', data };
    } else if (mode === 'llm-paraphrase') {
      const config = await getLlmConfig();
      const prompt = `Provide an English paraphrase (simpler explanation) for the word "${word}". Return JSON with this schema: {"word": "${word}", "paraphrase": "English paraphrase", "example": "example sentence"}. Return ONLY valid JSON.`;
      const data = await askLlm(prompt, config);
      return { success: true, mode: 'llm-paraphrase', data };
    } else if (mode === 'external-link') {
      const link = `https://dictionary.cambridge.org/dictionary/english/${encodeURIComponent(word)}`;
      return { success: true, mode: 'external-link', data: { word, link } };
    }
  } catch (err) {
    await recordDiagnostic('word-definition', mode, err.message);
    return { success: false, error: err.message };
  }
}

// ============================================================
// 言い換え（Paraphrase）取得
// ============================================================
async function handleGetParaphrase(request) {
  const sentence = clampText(request.sentence, MAX_CONTEXT_CHARS);
  if (!sentence) return { success: false, error: '英文が指定されていません' };
  
  const config = await getLlmConfig();
  try {
    await requirePrivacyConsent();
    const prompt = `Provide an alternative phrasing for this English sentence. Return JSON with this schema: {"original": "original sentence", "paraphrase": "alternative phrasing"}. Return ONLY valid JSON. Original: "${sentence}"`;
    const data = await askLlm(prompt, config);
    return { success: true, data };
  } catch (err) {
    await recordDiagnostic('paraphrase', config.provider, err.message);
    return { success: false, error: err.message };
  }
}

// ============================================================
// 例文生成（15語グループ用）
// ============================================================
async function handleGenerateExampleSentences(request) {
  const { words } = request;
  if (!words || !Array.isArray(words) || words.length === 0) {
    return { success: false, error: '単語リストが指定されていません' };
  }
  
  const config = await getLlmConfig();
  try {
    await requirePrivacyConsent();
    
    const wordList = words.map(w => `${w.word} (${w.meaning || ''})`).join(', ');
    const prompt = `You are an English teacher for Japanese learners. Create a single coherent English sentence that naturally includes ALL of these words: ${wordList}. The sentence should be contextually meaningful and appropriate for learning. Return JSON with this schema: {"sentence": "the example sentence", "words": [{"word": "word1", "meaning": "meaning1"}, {"word": "word2", "meaning": "meaning2"}]}. Return ONLY valid JSON.`;
    
    const data = await askLlm(prompt, config);
    return { success: true, data };
  } catch (err) {
    await recordDiagnostic('example-sentences', config.provider, err.message);
    return { success: false, error: err.message };
  }
}

// ============================================================
// 1回目: 解説 ＋ 履歴保存
// ============================================================
async function handleExplain(request) {
  const text = clampText(request.text, MAX_TARGET_CHARS + 1);
  if (!text) return { success: false, error: '対象テキストが空です' };
  if (text.length > MAX_TARGET_CHARS) {
    return { success: false, error: `解析できるのは${MAX_TARGET_CHARS}文字までです。範囲を短くして選択してください。` };
  }
  const contextSentence = clampText(request.contextSentence, MAX_CONTEXT_CHARS) || text;
  request = { ...request, text, contextSentence };
  const config = await getLlmConfig();
  const ankiConfig = (await chrome.storage.local.get(['ankiConfig'])).ankiConfig || {};
  const wordDefinitionMode = ankiConfig.wordDefinitionMode || 'llm-japanese';
  try {
    await requirePrivacyConsent();
    const data = await askLlm(buildExplainPrompt(text, contextSentence, wordDefinitionMode), config);
    return await saveAndReturnExplanation(request, config.provider || 'gemini', data);
  } catch (err) {
    await recordDiagnostic('text-analysis', config.provider, err.message);
    return { success: false, error: err.message };
  }
}

async function handleExplainImage(request) {
  const image = request.image || {};
  if (!image.base64 || !image.mimeType) return { success: false, error: 'スクリーンショット画像が見つかりません' };
  const config = await getLlmConfig();
  const ankiConfig = (await chrome.storage.local.get(['ankiConfig'])).ankiConfig || {};
  const wordDefinitionMode = ankiConfig.wordDefinitionMode || 'llm-japanese';
  try {
    await requirePrivacyConsent();
    const data = await askLlmWithImage(buildExplainImagePrompt(wordDefinitionMode), image, config);
    const targetPhrase = clampText(data.targetPhrase, MAX_TARGET_CHARS);
    if (!targetPhrase) {
      return { success: false, error: data.grammarPoint || '画像から解析できる英文を抽出できませんでした' };
    }
    const contextSentence = clampText(data.contextSentence, MAX_CONTEXT_CHARS) || targetPhrase;
    const response = await saveAndReturnExplanation(
      { text: targetPhrase, contextSentence },
      config.provider || 'gemini',
      data
    );
    return { ...response, targetPhrase, contextSentence };
  } catch (err) {
    await recordDiagnostic('image-analysis', config.provider, err.message);
    return { success: false, error: err.message };
  }
}

const HISTORY_LIMIT = 500;
let historyWriteQueue = Promise.resolve();

// 解析結果は自動では保存しない。利用者が解析画面で「履歴に保存」を押したときだけ handleSaveHistory で保存する。
async function saveAndReturnExplanation(request, provider, data) {
  return { success: true, provider, data };
}

const MAX_EXPLANATION_BYTES = 50 * 1024;

async function handleSaveHistory(request) {
  const text = clampText(request.text, MAX_TARGET_CHARS);
  if (!text) return { success: false, error: '保存する英文がありません' };
  const data = request.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { success: false, error: '保存する解析結果がありません' };
  }
  let serialized;
  try {
    serialized = JSON.stringify(data);
  } catch {
    return { success: false, error: '解析結果を保存できる形式に変換できません' };
  }
  if (new TextEncoder().encode(serialized).length > MAX_EXPLANATION_BYTES) {
    return { success: false, error: '解析結果が大きすぎるため保存できません' };
  }
  const entry = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    targetPhrase: text,
    contextSentence: clampText(request.contextSentence, MAX_CONTEXT_CHARS) || text,
    provider: clampText(request.provider, 40) || 'unknown',
    explanation: JSON.parse(serialized),
  };
  try {
    await saveHistoryEntry(entry);
    return { success: true, entryId: entry.id };
  } catch (error) {
    return { success: false, error: error.message || '履歴の保存に失敗しました' };
  }
}

function saveHistoryEntry(entry) {
  const write = async () => {
    const { historyIndex = [] } = await chrome.storage.local.get('historyIndex');
    const index = Array.isArray(historyIndex) ? historyIndex.filter((id) => typeof id === 'string') : [];
    const retainedIds = index.slice(0, HISTORY_LIMIT - 1);
    const removedIds = index.slice(HISTORY_LIMIT - 1);
    const values = {
      [`history:${entry.id}`]: entry,
      historyIndex: [entry.id, ...retainedIds],
    };
    if (removedIds.length) {
      await chrome.storage.local.remove(removedIds.map((id) => `history:${id}`));
    }
    await chrome.storage.local.set(values);
  };
  historyWriteQueue = historyWriteQueue.then(write, write);
  return historyWriteQueue;
}

// 未知語トグル: entry.unknownWords (string[]) に対して直列書き込みで追加/削除する。
// saveHistoryEntry と同じ historyWriteQueue に乗せることで、
// 「解析結果の保存」と「未知語マーク」が競合して片方を消してしまう事態を防ぐ。
function handleToggleUnknownWord(request) {
  const { entryId, word, unknown } = request || {};
  const wordKey = String(word || '').trim();
  if (!entryId || !wordKey) {
    return Promise.resolve({ success: false, error: 'entryId または word がありません' });
  }
  const write = async () => {
    const key = `history:${entryId}`;
    const res = await chrome.storage.local.get(key);
    const entry = res[key];
    if (!entry) {
      return { success: false, error: '対象の履歴が見つかりません（削除済みの可能性があります）' };
    }
    const set = new Set(Array.isArray(entry.unknownWords) ? entry.unknownWords : []);
    if (unknown) set.add(wordKey);
    else set.delete(wordKey);
    entry.unknownWords = Array.from(set);
    await chrome.storage.local.set({ [key]: entry });
    return { success: true, unknownWords: entry.unknownWords };
  };
  historyWriteQueue = historyWriteQueue.then(write, write);
  return historyWriteQueue;
}
