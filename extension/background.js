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
  if (details.reason === 'update') cleanupLegacyAllowedSites();
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

// 旧版（3.0.5まで）の「常に有効にするサイト」を片付ける。登録済みの content script を外し、
// そのために許可されたサイト権限も返す（外部のOpenAI互換サーバー用の許可は残す）。
async function cleanupLegacyAllowedSites() {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ['readanki-allowed-sites'] });
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: ['readanki-allowed-sites'] });
    const { allowedSites = [], llmConfig = {} } = await chrome.storage.local.get(['allowedSites', 'llmConfig']);
    let endpointHost = null;
    try {
      if (llmConfig.provider === 'local-openai') endpointHost = new URL(llmConfig.localOpenAiUrl).hostname;
    } catch {}
    await chrome.storage.local.remove('allowedSites');
    // manifest から外した http://*/* の許可は取り消せない（既に失効している）ため、今も持っているものだけを返す。
    const granted = new Set((await chrome.permissions.getAll()).origins || []);
    const origins = (Array.isArray(allowedSites) ? allowedSites : [])
      .filter((host) => typeof host === 'string' && host && host !== endpointHost)
      .flatMap((host) => [`https://${host}/*`, `http://${host}/*`])
      .filter((origin) => granted.has(origin));
    if (origins.length) await chrome.permissions.remove({ origins });
  } catch (error) {
    console.warn('ReadAnki: failed to clean up allowed sites', error);
  }
}

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

// ページ上の操作から外部のAIを呼ぶ回数を、タブごとに制限する。
// ページ側のスクリプトがReadAnkiのボタンを連打させても、利用者のAPIキーで際限なく課金されないようにする。
const PAGE_CALL_LIMIT = 30;
const PAGE_CALL_WINDOW_MS = 60 * 1000;
const PAGE_CALL_LIMIT_ERROR = { success: false, error: '短時間にAIへの送信が多すぎるため、一時的に止めています。1分ほど待ってから試してください。' };
const pageCallLog = new Map();

function overPageCallLimit(sender) {
  const tabId = sender?.tab?.id;
  if (tabId === undefined) return false;
  const now = Date.now();
  const recent = (pageCallLog.get(tabId) || []).filter((time) => now - time < PAGE_CALL_WINDOW_MS);
  const over = recent.length >= PAGE_CALL_LIMIT;
  if (!over) recent.push(now);
  pageCallLog.set(tabId, recent);
  return over;
}

chrome.tabs.onRemoved.addListener((tabId) => pageCallLog.delete(tabId));

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'explain') {
    if (overPageCallLimit(sender)) { sendResponse(PAGE_CALL_LIMIT_ERROR); return false; }
    handleExplain(request).then(sendResponse);
    return true;
  }

  if (request.action === 'explainImage') {
    if (overPageCallLimit(sender)) { sendResponse(PAGE_CALL_LIMIT_ERROR); return false; }
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

  if (request.action === 'getParaphrase') {
    if (overPageCallLimit(sender)) { sendResponse(PAGE_CALL_LIMIT_ERROR); return false; }
    handleGetParaphrase(request).then(sendResponse);
    return true;
  }

  if (request.action === 'generateExampleSentences') {
    handleGenerateExampleSentences(request).then(sendResponse);
    return true;
  }

  if (request.action === 'addWordbookWord') {
    // ページ上の「＋単語」ボタン（content script）からのみ受け付ける。記事のURLは送信元のフレームから取る。
    if (!sender.tab || !sender.url) return false;
    // プライベートブラウジング中のデータは保存しない（Firefox Add-on Policies 6.3）。
    if (sender.tab.incognito) {
      sendResponse({ success: false, error: 'プライベートウィンドウでは単語帳に保存しません' });
      return false;
    }
    handleAddWordbookWord(request, sender.url).then(sendResponse);
    return true;
  }

  if (request.action === 'defineWordbookWords') {
    handleDefineWordbookWords(request).then(sendResponse);
    return true;
  }

  if (request.action === 'openWordbook') {
    const page = typeof request.page === 'string' ? request.page : '';
    chrome.tabs.create({ url: chrome.runtime.getURL(`wordbook.html${page ? `#page=${encodeURIComponent(page)}` : ''}`) });
    sendResponse({ success: true });
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
// 記事ごとの単語帳: 利用者が「＋単語」で選んだ語を、記事（ページURL）ごとに端末内へ保存する。
// 保存時は外部へ送信しない。意味（英英・和訳・例文）は単語帳画面で利用者が押したときだけLLMで作る。
// ============================================================
const WORDBOOK_PAGE_LIMIT = 300;
const WORDBOOK_WORD_LIMIT = 200;
const MAX_WORDBOOK_WORD_CHARS = 60;
const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src)$/i;
let wordbookWriteQueue = Promise.resolve();

// 同じ記事を同じ単語帳にまとめるため、ページ内リンク（#）と追跡用パラメータを除いたURLを鍵にする。
function wordbookPageKey(rawUrl) {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('通常のウェブページでのみ使えます。');
  url.hash = '';
  [...url.searchParams.keys()].forEach((key) => {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  });
  return url.toString();
}

function handleAddWordbookWord(request, senderUrl) {
  const write = async () => {
    const word = String(request.word || '').replace(/\s+/g, ' ').trim();
    if (!word) return { success: false, error: '単語を選択してください。' };
    if (word.length > MAX_WORDBOOK_WORD_CHARS) {
      return { success: false, error: `単語・熟語は${MAX_WORDBOOK_WORD_CHARS}文字までです。` };
    }
    const page = wordbookPageKey(senderUrl);
    const key = `wordbook:${page}`;
    const { [key]: stored, wordbookIndex = [] } = await chrome.storage.local.get([key, 'wordbookIndex']);
    const now = Date.now();
    const book = stored || { page, title: '', createdAt: now, words: [] };
    book.title = clampText(request.title || book.title || '', 200);
    book.updatedAt = now;
    const exists = book.words.some((item) => item.word.toLowerCase() === word.toLowerCase());
    if (!exists) {
      if (book.words.length >= WORDBOOK_WORD_LIMIT) {
        return { success: false, error: `1つの記事に登録できるのは${WORDBOOK_WORD_LIMIT}語までです。` };
      }
      book.words.push({ word, context: clampText(request.context || '', MAX_CONTEXT_CHARS), addedAt: now });
    }
    const others = (Array.isArray(wordbookIndex) ? wordbookIndex : []).filter((item) => item !== page);
    // 満杯のときに古い記事を自動で消すと、ページ側のスクリプトに単語帳を消させる手口になるため、追加を断る。
    if (others.length >= WORDBOOK_PAGE_LIMIT) {
      return { success: false, error: `単語帳は${WORDBOOK_PAGE_LIMIT}記事までです。単語帳の一覧から、使わない記事の単語帳を削除してください。` };
    }
    await chrome.storage.local.set({ [key]: book, wordbookIndex: [page, ...others] });
    return { success: true, page, count: book.words.length, duplicate: exists };
  };
  const run = () => write().catch((error) => ({ success: false, error: error.message }));
  wordbookWriteQueue = wordbookWriteQueue.then(run, run);
  return wordbookWriteQueue;
}

// 送るのは語と、その語を含む1文（追加時に保存したもの）だけ。
async function handleDefineWordbookWords(request) {
  const words = (Array.isArray(request.words) ? request.words : [])
    .map((item) => ({
      word: clampText(String(item?.word || '').trim(), MAX_WORDBOOK_WORD_CHARS),
      context: clampText(String(item?.context || ''), MAX_CONTEXT_CHARS),
    }))
    .filter((item) => item.word)
    .slice(0, 30);
  if (!words.length) return { success: false, error: '意味を付ける単語がありません。' };
  const config = await getLlmConfig();
  try {
    await requirePrivacyConsent();
    const list = words.map((item, i) => `${i + 1}. ${item.word}${item.context ? ` | Context: ${item.context}` : ''}`).join('\n');
    const prompt = `あなたは日本人の英語学習者を教える講師です。次の英単語・熟語それぞれについて、文脈（Context）での意味に合わせて説明してください。
${list}

次のJSONだけを返してください。words は入力と同じ順番・同じ数にしてください。
{
  "words": [
    {
      "word": "入力の語そのまま",
      "enDefinition": "やさしい英語による英英定義（1文）",
      "ja": "文脈に合う日本語訳（短く）",
      "example": "その語を使った新しい英語の例文（1文。元の文とは別のもの）"
    }
  ]
}`;
    const data = await askLlm(prompt, config);
    const results = Array.isArray(data?.words) ? data.words : [];
    return {
      success: true,
      words: words.map((item, i) => {
        const hit = results.find((r) => String(r?.word || '').trim().toLowerCase() === item.word.toLowerCase()) || results[i] || {};
        return {
          word: item.word,
          enDefinition: clampText(String(hit.enDefinition || ''), 500),
          ja: clampText(String(hit.ja || ''), 200),
          example: clampText(String(hit.example || ''), 500),
        };
      }),
    };
  } catch (err) {
    await recordDiagnostic('wordbook-define', config.provider, err.message);
    return { success: false, error: err.message };
  }
}
