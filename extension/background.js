// ReadAnki Background Service Worker (UI v3 / 2-pass analysis)
importScripts('anki-model.js');
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
        ankiConfig: {
          url: 'http://127.0.0.1:8765',
          wordDefinitionMode: 'llm-japanese',
          // 4つのカード形式ごとのデッキ名・ノートタイプ名
          ...ANKI_DEFAULTS,
          tags: ['ReadAnki'],
          allowDuplicate: false,
        },
      });
    }
  });
  syncAllowedSiteScripts();
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'readanki-explain-selection',
      title: 'ReadAnki: 文法解説とAnki化',
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

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
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

chrome.commands.onCommand.addListener(async (command, tab) => {
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
    handleSaveHistory(request).then(sendResponse);
    return true;
  }

  if (request.action === 'toggleUnknownWord') {
    Promise.resolve(handleToggleUnknownWord(request)).then(sendResponse);
    return true;
  }

  if (request.action === 'addToAnki') {
    handleAddToAnki(request).then(sendResponse);
    return true;
  }

  if (request.action === 'getAnkiFields') {
    handleGetAnkiFields(request).then(sendResponse);
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

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
  "keyVocabulary": [{"word": "word", "meaning": "${vocabMeaningLabel}", "pos": "pos"}],
  "ankiFront": "表面HTML",
  "ankiBack": "裏面HTML"
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
  "keyVocabulary": [{"word": "word", "meaning": "${vocabMeaningLabel}", "pos": "pos"}],
  "ankiFront": "表面HTML",
  "ankiBack": "裏面HTML"
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

// ============================================================
// Anki連携（4ノートタイプ対応）
// ============================================================
// 初期値（設定画面・インストール時・カード作成時で共通）
const ANKI_DEFAULTS = {
  vocabClozeDeckName: 'AnkiRead::Vocab-Cloze',
  vocabClozeModelName: '穴埋め問題',
  grammarDeckName: 'AnkiRead::Grammar',
  grammarModelName: '基本',
  enJaDeckName: 'AnkiRead::EN-JP',
  enJaModelName: '基本',
  jaEnDeckName: 'AnkiRead::JP-EN',
  jaEnModelName: '基本 (文字入力解答)',
};

// ---------- カードの書式 ----------
// 文字色は指定しない（Ankiの夜間モードでもそのまま読めるように）。強調は半透明の背景と下線で表す。
const CARD_STYLE = {
  front: 'text-align: center; font-size: 1.45em; line-height: 1.75; padding: 0.3em 0.2em;',
  back: 'text-align: left; max-width: 34em; margin: 0 auto; line-height: 1.7;',
  label: 'display: block; font-size: 0.7em; letter-spacing: 0.08em; opacity: 0.55; margin-bottom: 0.15em;',
  section: 'margin: 0 0 0.9em;',
  main: 'font-size: 1.2em; font-weight: 600;',
  sub: 'font-size: 0.95em; opacity: 0.88;',
  mark: 'background: rgba(37, 99, 235, 0.14); border-bottom: 2px solid rgba(37, 99, 235, 0.75); border-radius: 3px; padding: 0 0.12em; font-weight: 600;',
  chip: 'display: inline-block; margin: 0.15em 0.3em 0.15em 0; padding: 0.05em 0.55em; border: 1px solid rgba(128, 128, 128, 0.35); border-radius: 999px; font-size: 0.88em;',
  role: 'margin-left: 0.4em; font-size: 0.72em; font-weight: 700; opacity: 0.6;',
};

// 文脈の中の対象フレーズを強調表示した HTML を返す（各カードで共用）。
function highlightPhraseInContext(context, phrase) {
  const idx = phrase ? context.indexOf(phrase) : -1;
  return idx === -1
    ? escapeHtml(context)
    : `${escapeHtml(context.slice(0, idx))}<span style="${CARD_STYLE.mark}">${escapeHtml(phrase)}</span>${escapeHtml(context.slice(idx + phrase.length))}`;
}

function cardFront(innerHtml) {
  return `<div style="${CARD_STYLE.front}">${innerHtml}</div>`;
}

function cardSection(label, innerHtml, kind = 'sub') {
  if (!htmlToPlainText(innerHtml)) return '';
  return `<div style="${CARD_STYLE.section}"><span style="${CARD_STYLE.label}">${label}</span><div style="${CARD_STYLE[kind]}">${innerHtml}</div></div>`;
}

function cardBack(sections) {
  return `<div style="${CARD_STYLE.back}">${sections.join('')}</div>`;
}

function breakdownChips(breakdown) {
  return (Array.isArray(breakdown) ? breakdown : [])
    .map((b) => `<span style="${CARD_STYLE.chip}">${escapeHtml(b.chunk)}<span style="${CARD_STYLE.role}">${escapeHtml(b.role)}</span></span>`)
    .join('');
}

function vocabularyList(vocabulary) {
  return (Array.isArray(vocabulary) ? vocabulary : [])
    .map((v) => `<b>${escapeHtml(v.word)}</b>${v.pos ? ` <span style="opacity: 0.6;">(${escapeHtml(v.pos)})</span>` : ''} ${escapeHtml(v.meaning)}`)
    .join('<br>');
}

function noteFromFields(ankiConfig, deckKey, modelKey, card, generatedFields, tags, allowDuplicate) {
  const fields = card.fields && typeof card.fields === 'object' ? card.fields : generatedFields;
  return {
    deckName: ankiConfig[deckKey] || ANKI_DEFAULTS[deckKey],
    modelName: ankiConfig[modelKey] || ANKI_DEFAULTS[modelKey],
    fields,
    options: { allowDuplicate },
    tags,
  };
}

function buildVocabClozeNote(ankiConfig, card, tags, allowDuplicate) {
  const exp = card.explanation || {};
  const phrase = card.targetPhrase || '';
  const context = card.contextSentence || phrase;
  const generatedFields = {
    Text: cardFront(`{{c1::${escapeHtml(phrase)}}}`),
    'Back Extra': cardBack([
      cardSection('文脈', highlightPhraseInContext(context, phrase)),
      cardSection('訳', escapeHtml(exp.sentenceTranslation)),
      cardSection('重要語彙', vocabularyList(exp.keyVocabulary)),
    ]),
  };
  return noteFromFields(ankiConfig, 'vocabClozeDeckName', 'vocabClozeModelName', card, generatedFields, tags, allowDuplicate);
}

function buildGrammarNote(ankiConfig, card, tags, allowDuplicate) {
  const exp = card.explanation || {};
  const phrase = card.targetPhrase || '';
  const context = card.contextSentence || phrase;
  // 表: 例文（問い）、裏: 文法ポイント（答え）
  const generatedFields = {
    Front: cardFront(highlightPhraseInContext(context, phrase)),
    Back: cardBack([
      cardSection('文法ポイント', escapeHtml(exp.grammarPoint), 'main'),
      cardSection('訳', escapeHtml(exp.sentenceTranslation)),
      cardSection('構文', breakdownChips(exp.structureBreakdown)),
    ]),
  };
  return noteFromFields(ankiConfig, 'grammarDeckName', 'grammarModelName', card, generatedFields, tags, allowDuplicate);
}

function buildEnJaNote(ankiConfig, card, tags, allowDuplicate) {
  const exp = card.explanation || {};
  const phrase = card.targetPhrase || '';
  const context = card.contextSentence || phrase;
  // 表: 英文、裏: 和訳
  const generatedFields = {
    Front: cardFront(highlightPhraseInContext(context, phrase)),
    Back: cardBack([
      cardSection('和訳', escapeHtml(exp.sentenceTranslation), 'main'),
      cardSection('文法', escapeHtml(exp.grammarPoint)),
    ]),
  };
  return noteFromFields(ankiConfig, 'enJaDeckName', 'enJaModelName', card, generatedFields, tags, allowDuplicate);
}

function buildJaEnNote(ankiConfig, card, tags, allowDuplicate) {
  const exp = card.explanation || {};
  const phrase = card.targetPhrase || '';
  const context = card.contextSentence || phrase;
  // 表: 和訳、裏: 英文（入力型では照合の正解になるため、HTMLを含まない英文だけにする）、解説は別フィールド
  const generatedFields = {
    Front: cardFront(escapeHtml(exp.sentenceTranslation || '')),
    Back: context,
    Extra: cardBack([
      cardSection('対象の表現', highlightPhraseInContext(phrase, phrase)),
      cardSection('文法', escapeHtml(exp.grammarPoint)),
      cardSection('構文', breakdownChips(exp.structureBreakdown)),
    ]),
  };
  return noteFromFields(ankiConfig, 'jaEnDeckName', 'jaEnModelName', card, generatedFields, tags, allowDuplicate);
}

async function handleGetAnkiFields(request) {
  const ankiConfig = (await chrome.storage.local.get(['ankiConfig'])).ankiConfig || {};
  const card = request.card || {};
  const cardType = card.cardType || 'vocab-cloze';
  
  let note;
  switch (cardType) {
    case 'vocab-cloze':
      note = buildVocabClozeNote(ankiConfig, card, [], false);
      break;
    case 'grammar':
      note = buildGrammarNote(ankiConfig, card, [], false);
      break;
    case 'en-ja':
      note = buildEnJaNote(ankiConfig, card, [], false);
      break;
    case 'ja-en':
      note = buildJaEnNote(ankiConfig, card, [], false);
      break;
    default:
      note = buildVocabClozeNote(ankiConfig, card, [], false);
  }
  
  return { success: true, cardType, fields: note.fields };
}

async function ankiConnect(endpoint, action, params = {}) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, version: 6, params }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`AnkiConnectエラー (HTTP ${res.status}): ${errText || res.statusText}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

// ReadAnki の論理フィールドの並び順（穴埋め: 本文→補足、日英: 日本語→英文→解説、その他: 表→裏）。
function logicalFieldOrder(cardType) {
  if (cardType === 'vocab-cloze') return ['Text', 'Back Extra'];
  if (cardType === 'ja-en') return ['Front', 'Back', 'Extra'];
  return ['Front', 'Back'];
}

function htmlToPlainText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// ノートタイプの実際のフィールド名と種類（穴埋め型・入力型）を調べる。
async function getModelInfo(endpoint, modelName) {
  let fields;
  try {
    fields = await ankiConnect(endpoint, 'modelFieldNames', { modelName });
  } catch (error) {
    if (/model was not found/i.test(error.message)) {
      throw new Error(`Ankiにノートタイプ「${modelName}」が見つかりません。ReadAnkiの設定で、Ankiにあるノートタイプ名を指定してください。`);
    }
    throw error;
  }
  if (!Array.isArray(fields) || !fields.length) {
    throw new Error(`ノートタイプ「${modelName}」のフィールドを取得できませんでした。`);
  }
  let templateText = '';
  try {
    const templates = await ankiConnect(endpoint, 'modelTemplates', { modelName });
    templateText = Object.values(templates || {}).map((t) => `${t.Front || ''}\n${t.Back || ''}`).join('\n');
  } catch {
    // 古い AnkiConnect でテンプレートを取れない場合は、通常型として扱う。
  }
  const clozeField = (templateText.match(/\{\{cloze:([^}]+)\}\}/) || [])[1]?.trim();
  const typeField = (templateText.match(/\{\{type:(?:cloze:)?([^}]+)\}\}/) || [])[1]?.trim();
  return {
    fields,
    clozeField: fields.includes(clozeField) ? clozeField : null,
    typeField: fields.includes(typeField) ? typeField : null,
  };
}

// ReadAnki の論理フィールドを、ノートタイプの実フィールドへ当てはめる。
// 名前が合わないと AnkiConnect が値を捨てて「empty」エラーになるため、名前ではなく役割と位置で対応させる。
async function mapToModelFields(endpoint, modelName, cardType, fields) {
  const values = logicalFieldOrder(cardType).map((key) => String(fields?.[key] ?? ''));
  const info = await getModelInfo(endpoint, modelName);
  const isClozeCard = cardType === 'vocab-cloze';

  if (isClozeCard && !info.clozeField) {
    throw new Error(`穴埋めカードの送り先「${modelName}」は穴埋め型のノートタイプではありません。設定の「Vocabulary Cloze ノートタイプ名」に穴埋め型（例: 穴埋め問題）を指定してください。`);
  }
  if (!isClozeCard && info.clozeField) {
    throw new Error(`「${modelName}」は穴埋め型のノートタイプです。このカード形式には通常のノートタイプ（例: 基本）を指定してください。`);
  }
  if (isClozeCard && !/\{\{c\d+::/.test(values[0])) {
    throw new Error('穴埋めカードの本文に {{c1::…}} がありません。「編集・カード形式」で穴埋めにする語を {{c1::語}} の形にしてください。');
  }

  const mapped = {};
  const remaining = [...info.fields];
  const take = (name) => {
    const index = remaining.indexOf(name);
    if (index !== -1) remaining.splice(index, 1);
    return name;
  };

  if (isClozeCard) {
    mapped[take(info.clozeField)] = values[0];
    if (remaining.length) mapped[take(remaining[0])] = values[1];
  } else if (info.typeField) {
    // 入力型: 正解フィールドには HTML を含まない答えだけを入れる（解説を混ぜると常に不正解になる）。
    mapped[take(info.typeField)] = htmlToPlainText(values[1]);
    if (remaining.length) mapped[take(remaining[0])] = values[0];
    if (values[2] && remaining.length) mapped[take(remaining[0])] = values[2];
  } else {
    values.forEach((value, i) => {
      if (!value) return;
      if (remaining.length) {
        mapped[take(remaining[0])] = i === 1 && cardType === 'ja-en' ? `<div style="${CARD_STYLE.front}">${escapeHtml(value)}</div>` : value;
      } else {
        const last = info.fields[info.fields.length - 1];
        mapped[last] = `${mapped[last] || ''}<hr>${value}`;
      }
    });
  }

  if (!htmlToPlainText(mapped[info.fields[0]])) {
    throw new Error(`カードの1番目の欄（Ankiの「${info.fields[0]}」）が空です。「編集・カード形式」で内容を入力してください。`);
  }
  return mapped;
}

async function handleAddToAnki(request) {
  const ankiConfig = (await chrome.storage.local.get(['ankiConfig'])).ankiConfig || {};
  let endpoint;
  const card = request.card || {};
  const tags = Array.isArray(ankiConfig.tags) && ankiConfig.tags.length ? ankiConfig.tags : ['ReadAnki'];
  const allowDuplicate = !!ankiConfig.allowDuplicate;

  const CARD_TYPES = ['vocab-cloze', 'grammar', 'en-ja', 'ja-en'];
  const cardType = CARD_TYPES.includes(card.cardType) ? card.cardType : 'vocab-cloze';
  
  let note;
  switch (cardType) {
    case 'vocab-cloze':
      note = buildVocabClozeNote(ankiConfig, card, tags, allowDuplicate);
      break;
    case 'grammar':
      note = buildGrammarNote(ankiConfig, card, tags, allowDuplicate);
      break;
    case 'en-ja':
      note = buildEnJaNote(ankiConfig, card, tags, allowDuplicate);
      break;
    case 'ja-en':
      note = buildJaEnNote(ankiConfig, card, tags, allowDuplicate);
      break;
    default:
      note = buildVocabClozeNote(ankiConfig, card, tags, allowDuplicate);
  }

  try {
    endpoint = localEndpointUrl(ankiConfig.url, 'http://127.0.0.1:8765', 'AnkiConnect').toString();
    note.fields = await mapToModelFields(endpoint, note.modelName, cardType, note.fields);
    // addNote は送り先のデッキが無いと失敗するため、先に用意する（既にあれば何もしない）。
    await ankiConnect(endpoint, 'createDeck', { deck: note.deckName });
    const noteId = await ankiConnect(endpoint, 'addNote', { note });
    return { success: true, noteId, cardType };
  } catch (err) {
    await recordDiagnostic('anki-add', 'anki', err.message);
    const message = /cannot create note because it is a duplicate/i.test(err.message)
      ? '同じ内容のカードが既にAnkiにあります。内容を編集するか、Anki側のカードを確認してください。'
      : err.message;
    return { success: false, error: message };
  }
}
