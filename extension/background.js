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
  migrateUnknownWordsToWordbook();
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
  await chrome.scripting.executeScript({ target: { tabId }, files: ['tts.js', 'content.js'] });
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
      js: ['tts.js', 'content.js'],
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
chrome.runtime.onStartup.addListener(() => {
  syncAllowedSiteScripts();
  migrateUnknownWordsToWordbook();
});

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

// ページ上の操作から外部のAI・読み上げを呼ぶ回数を、タブごとに制限する。
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
    handleSaveHistory(request).then(sendResponse);
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

  if (request.action === 'translateClozePart') {
    if (overPageCallLimit(sender)) { sendResponse(PAGE_CALL_LIMIT_ERROR); return false; }
    handleTranslateClozePart(request).then(sendResponse);
    return true;
  }

  if (request.action === 'getParaphrase') {
    if (overPageCallLimit(sender)) { sendResponse(PAGE_CALL_LIMIT_ERROR); return false; }
    handleGetParaphrase(request).then(sendResponse);
    return true;
  }

  if (request.action === 'addWordbookWord') {
    // ページ上の「＋単語」ボタン（content script）からのみ受け付ける。記事のURLは送信元のフレームから取る。
    if (!sender.tab || !sender.url) return false;
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

  if (request.action === 'synthesizeSpeech') {
    // 未保存の設定での試聴は、拡張機能のページ（設定画面）からだけ受け付ける。
    // （設定画面はタブで開くため sender.tab の有無ではなく、送信元URLが拡張機能自身のページかで判定する）
    const fromExtensionPage = sender.id === chrome.runtime.id && String(sender.url || '').startsWith(chrome.runtime.getURL(''));
    if (!fromExtensionPage && overPageCallLimit(sender)) { sendResponse(PAGE_CALL_LIMIT_ERROR); return false; }
    handleSynthesizeSpeech(request, fromExtensionPage ? request.config : null).then(sendResponse);
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

// 診断情報に秘密の値が残らないよう伏せ字にする。
// 設定済みのキーそのもの → URLのクエリの値 → Bearer などの認証値 → key= / token= などの値 → キーやトークンらしい長い文字列、の順に消す。
function redactSecrets(text, knownSecrets = []) {
  let safe = String(text || '');
  for (const secret of knownSecrets) {
    if (typeof secret === 'string' && secret.length >= 6) safe = safe.split(secret).join('[REDACTED]');
  }
  return safe
    .replace(/([?&#][^=\s&#?]+=)[^&#\s"'<>)]+/g, '$1[REDACTED]')
    .replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+\/=-]+/gi, '$1 [REDACTED]')
    .replace(/\b((?:x-goog-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passwd|authorization|auth|key|sig|signature)["']?\s*[:=]\s*["']?)(?!\[REDACTED\])[^\s"'&,;}<>]+/gi, '$1[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[REDACTED]')
    .replace(/(?:sk-|AIza|ghp_|gho_|xox[abp]-)[A-Za-z0-9_\-]+/g, '[REDACTED]')
    .replace(/(?<![A-Za-z0-9_\-])[A-Za-z0-9_\-]{32,}(?![A-Za-z0-9_\-])/g, '[REDACTED]');
}

async function recordDiagnostic(kind, provider, error) {
  let knownSecrets = [];
  try {
    const config = await getLlmConfig();
    knownSecrets = SECRET_CONFIG_KEYS.map((key) => config[key]);
  } catch {}
  const safeError = redactSecrets(error || '不明なエラー', knownSecrets);
  await chrome.storage.session.set({
    lastDiagnostic: { kind, provider: provider || 'unknown', error: safeError.slice(0, 300), occurredAt: Date.now() },
  });
}

async function getDiagnostic() {
  const { lastDiagnostic = null } = await chrome.storage.session.get('lastDiagnostic');
  return { success: true, version: chrome.runtime.getManifest().version, lastDiagnostic };
}

// ============================================================
// 外部TTS（設定で選んだときだけ）: 読み上げる英文だけを選んだサービスへ送り、音声を返す。
// 同じ文の再生成（再課金）を避けるため、メモリ内に最近の音声だけを保持する（ディスクには保存しない）。
// ============================================================
const TTS_DEFAULTS = {
  engine: 'browser',
  accent: 'us',
  openAiTtsVoice: 'coral',
  openAiTtsModel: 'gpt-4o-mini-tts',
  geminiTtsVoice: 'Kore',
  geminiTtsModel: 'gemini-3.8-flash-tts',
  localTtsUrl: 'http://localhost:8880/v1',
  localTtsModel: 'kokoro',
  localTtsVoice: 'af_heart',
};
const TTS_ACCENT_NAMES = { us: 'American', gb: 'British', au: 'Australian', in: 'Indian' };
const TTS_ENGINE_LABELS = { openai: 'OpenAI', gemini: 'Gemini', local: 'ローカルTTS' };
const TTS_CACHE_LIMIT = 30;
const ttsCache = new Map();

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function ttsStyle(accent, slow) {
  const accentName = TTS_ACCENT_NAMES[accent] || TTS_ACCENT_NAMES.us;
  return `Speak in a clear, natural ${accentName} English accent${slow ? ', slowly and carefully for a language learner' : ''}.`;
}

async function fetchAudioBytes(res, label) {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let message = res.statusText;
    try { message = JSON.parse(body)?.error?.message || message; } catch {}
    throw new Error(`${label} の読み上げエラー (HTTP ${res.status}): ${message}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function synthesizeOpenAi(text, tts, slow, apiKey) {
  if (!apiKey) throw new Error('OpenAI APIキーが設定されていません（設定画面のAI設定で入力してください）。');
  const model = String(tts.openAiTtsModel || TTS_DEFAULTS.openAiTtsModel).trim();
  const body = { model, voice: tts.openAiTtsVoice || TTS_DEFAULTS.openAiTtsVoice, input: text, response_format: 'mp3' };
  if (slow) body.speed = 0.8;
  if (!/^tts-1/.test(model)) body.instructions = ttsStyle(tts.accent, slow);
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  return { format: 'encoded', data: bytesToBase64(await fetchAudioBytes(res, 'OpenAI')) };
}

function findGeminiAudio(json) {
  const outputs = [];
  for (const step of Array.isArray(json?.steps) ? json.steps : []) {
    for (const item of Array.isArray(step?.content) ? step.content : []) {
      if (item?.type === 'audio' && item.data) outputs.push({ data: item.data, mimeType: item.mime_type || item.mimeType });
    }
  }
  if (json?.output_audio?.data) outputs.push({ data: json.output_audio.data, mimeType: json.output_audio.mime_type });
  for (const part of json?.candidates?.[0]?.content?.parts || []) {
    if (part?.inlineData?.data) outputs.push({ data: part.inlineData.data, mimeType: part.inlineData.mimeType });
  }
  return outputs[outputs.length - 1] || null;
}

async function synthesizeGemini(text, tts, slow, apiKey) {
  if (!apiKey) throw new Error('Gemini APIキーが設定されていません（設定画面のAI設定で入力してください）。');
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      model: String(tts.geminiTtsModel || TTS_DEFAULTS.geminiTtsModel).trim(),
      input: [{
        type: 'user_input',
        content: [{
          type: 'text',
          text,
          annotations: [{ type: 'speech_metadata', style: ttsStyle(tts.accent, slow) }],
        }],
      }],
      response_format: { type: 'audio', mime_type: 'audio/wav' },
      generation_config: { speech_config: [{ voice: tts.geminiTtsVoice || TTS_DEFAULTS.geminiTtsVoice }] },
    }),
  });
  const raw = await res.text();
  let json;
  try { json = JSON.parse(raw); } catch { json = null; }
  if (!res.ok || !json) {
    throw new Error(`Gemini の読み上げエラー (HTTP ${res.status}): ${json?.error?.message || res.statusText}`);
  }
  const audio = findGeminiAudio(json);
  if (!audio) throw new Error('Geminiから音声が返されませんでした。読み上げモデル名を確認してください。');
  const mimeType = String(audio.mimeType || '').toLowerCase();
  if (/l16|pcm/.test(mimeType)) {
    const rate = Number((mimeType.match(/rate=(\d+)/) || [])[1]) || 24000;
    return { format: 'pcm16', data: audio.data, sampleRate: rate };
  }
  return { format: 'encoded', data: audio.data };
}

async function synthesizeLocal(text, tts, slow) {
  const base = localEndpointUrl(tts.localTtsUrl, TTS_DEFAULTS.localTtsUrl, 'ローカルTTS');
  const url = /\/audio\/speech\/?$/.test(base.pathname)
    ? base.toString()
    : `${base.toString().replace(/\/+$/, '')}/audio/speech`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: tts.localTtsModel || TTS_DEFAULTS.localTtsModel,
      voice: tts.localTtsVoice || TTS_DEFAULTS.localTtsVoice,
      input: text,
      response_format: 'mp3',
      speed: slow ? 0.8 : 1,
    }),
  });
  return { format: 'encoded', data: bytesToBase64(await fetchAudioBytes(res, 'ローカルTTS')) };
}

async function handleSynthesizeSpeech(request, configOverride) {
  const text = clampText(request.text, MAX_TARGET_CHARS);
  if (!text) return { success: false, error: '読み上げる英文がありません' };
  const { ttsConfig = {} } = await chrome.storage.local.get('ttsConfig');
  const override = configOverride && typeof configOverride === 'object' ? configOverride : {};
  const tts = { ...TTS_DEFAULTS, ...ttsConfig, ...override };
  const slow = request.slow === true;
  if (!TTS_ENGINE_LABELS[tts.engine]) return { success: false, error: 'ブラウザ音声が選ばれています' };
  try {
    await requirePrivacyConsent();
    const voiceKey = { openai: [tts.openAiTtsModel, tts.openAiTtsVoice], gemini: [tts.geminiTtsModel, tts.geminiTtsVoice], local: [tts.localTtsUrl, tts.localTtsModel, tts.localTtsVoice] }[tts.engine];
    const cacheKey = JSON.stringify([tts.engine, ...voiceKey, tts.accent, slow, text]);
    if (ttsCache.has(cacheKey)) {
      const cached = ttsCache.get(cacheKey);
      ttsCache.delete(cacheKey);
      ttsCache.set(cacheKey, cached);
      return { success: true, cached: true, ...cached };
    }
    const config = await getLlmConfig();
    let audio;
    if (tts.engine === 'openai') audio = await synthesizeOpenAi(text, tts, slow, String(config.openAiApiKey || '').trim());
    else if (tts.engine === 'gemini') audio = await synthesizeGemini(text, tts, slow, String(config.geminiApiKey || '').trim());
    else audio = await synthesizeLocal(text, tts, slow);
    ttsCache.set(cacheKey, audio);
    while (ttsCache.size > TTS_CACHE_LIMIT) ttsCache.delete(ttsCache.keys().next().value);
    return { success: true, ...audio };
  } catch (error) {
    await recordDiagnostic('tts', tts.engine, error.message);
    return { success: false, error: error.message };
  }
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
  "targetTranslation": "Targetだけの、Contextの意味に合った和訳",
  "sentenceTranslation": "Context（文全体）の自然な和訳",
  "structureBreakdown": [{"chunk": "英文", "role": "S/V/O/C/M", "note": "解説", "ja": "このチャンクの文脈に合った短い和訳"}],
  "grammarPoint": "実践的な構文・文法の解説",
  "nuanceNotes": "ニュアンス解説",
  "keyVocabulary": [{"word": "word", "meaning": "${vocabMeaningLabel}", "pos": "pos"}],
  "ankiFront": "表面HTML",
  "ankiBack": "裏面HTML"
}
${vocabInstruction}
Target: ${JSON.stringify(text)}
Context: ${JSON.stringify(contextSentence || text)}
First read the whole Context to understand the meaning, then analyze ONLY the Target (it may be a short phrase, not a full clause).
"structureBreakdown" must split ONLY the Target: every "chunk" is copied exactly from the Target, in order, and together the chunks cover the WHOLE Target from its first word to its last word. Do not include words that are outside the Target.
If the Target contains several clauses or phrases (main clause, participle phrase, reported clause, relative clause, etc.), break down every one of them. Never skip the beginning, the middle or the end of the Target.
For each chunk, "role" is the role it plays in the Context sentence (use "M" for modifiers such as prepositional phrases and adverbs), and "note" explains in Japanese how it works in the Context.
"grammarPoint", "keyVocabulary" and "targetTranslation" focus on the Target; use the Context only to decide the correct meaning.
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
  "structureBreakdown": [{"chunk": "英文", "role": "S/V/O/C/M", "note": "解説", "ja": "このチャンクの文脈に合った短い和訳"}],
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
// 言い換え（Paraphrase）取得
// ============================================================
// 語彙Clozeで語単位に選んだ穴の、文脈に合った短い和訳（表面のヒント用）
async function handleTranslateClozePart(request) {
  const part = clampText(request.part, MAX_TARGET_CHARS);
  const sentence = clampText(request.sentence, MAX_CONTEXT_CHARS) || part;
  if (!part) return { success: false, error: '訳す語句がありません' };
  const config = await getLlmConfig();
  try {
    await requirePrivacyConsent();
    const prompt = `Translate the English part into short, natural Japanese as it is used in the sentence. Translate only the part, not the whole sentence.
Return ONLY valid JSON: {"ja": "Japanese translation"}
Part: ${JSON.stringify(part)}
Sentence: ${JSON.stringify(sentence)}`;
    const data = await askLlm(prompt, config);
    const ja = String(data?.ja || '').trim();
    if (!ja) throw new Error('訳を取得できませんでした');
    return { success: true, ja };
  } catch (err) {
    await recordDiagnostic('cloze-hint', config.provider, err.message);
    return { success: false, error: err.message };
  }
}

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
// 1回目: 解説 ＋ 履歴保存
// ============================================================
// ============================================================
// 構文分解が選択範囲の全体を覆っているかの確認（LLMが一部の節だけを返すことがあるため）
// AIは引用符（“ ” と "）・句読点・大文字小文字・空白を変えて返すことがあるため、
// 語（英数字）の並びだけで照合し、元の文字位置に戻す。
// ============================================================
function wordSkeleton(value) {
  const source = String(value || '');
  let text = '';
  const map = [];
  let pendingGap = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (/[\p{L}\p{N}]/u.test(ch)) {
      if (pendingGap && text) { text += ' '; map.push(i); }
      text += ch.toLowerCase();
      map.push(i);
      pendingGap = false;
    } else {
      pendingGap = true;
    }
  }
  return { text, map };
}

// 範囲の中で片方だけになった引用符・括弧を、すぐ隣にある相方まで広げて閉じる（例: “clearly … actor → “clearly … actor”）。
function balanceSpan(source, start, end) {
  const count = (re) => (source.slice(start, end).match(re) || []).length;
  for (const [open, close] of [['“', '”'], ['‘', '’'], ['[', ']'], ['(', ')']]) {
    const opens = count(new RegExp('\\' + open, 'g'));
    const closes = count(new RegExp('\\' + close, 'g'));
    if (opens > closes) {
      const next = source.slice(end, end + 2).match(new RegExp('^[,.;:!?]?\\' + close));
      if (next) end += next[0].length;
    } else if (closes > opens && source[start - 1] === open) {
      start -= 1;
    }
  }
  if (count(/"/g) % 2 === 1) {
    const next = source.slice(end, end + 2).match(/^[,.;:!?]?"/);
    if (next) end += next[0].length;
    else if (source[start - 1] === '"') start -= 1;
  }
  return { start, end };
}

// text の中で、chunks を順に（見つからなければ先頭から）探し、重ならない文字範囲を返す。
// 先頭・末尾の引用符は、チャンク側にも引用符があれば範囲に含める。
function locateChunks(text, chunks, fromIndex = 0) {
  const source = String(text || '');
  const base = wordSkeleton(source);
  const padded = ` ${base.text} `;
  const startSkel = base.map.findIndex((orig) => orig >= fromIndex);
  let cursor = startSkel === -1 ? 0 : startSkel;
  const spans = [];
  for (const raw of chunks) {
    const chunk = wordSkeleton(raw).text;
    if (!chunk) { spans.push(null); continue; }
    const needle = ` ${chunk} `;
    const overlaps = (st, en) => spans.some((sp) => sp && st < sp.end && en > sp.start);
    const toSpan = (pos) => {
      let start = base.map[pos];
      let end = base.map[pos + chunk.length - 1] + 1;
      const rawText = String(raw).trim();
      // チャンクが引用符で囲まれていれば、元の文の引用符（直後の , や . を挟む場合も）を含める
      if (/^["“‘]/.test(rawText) && /["“‘]/.test(source[start - 1] || '')) start -= 1;
      if (/["”’]$/.test(rawText)) {
        const close = source.slice(end, end + 2).match(/^[,.;:!?]?["”’]/);
        if (close) end += close[0].length;
      }
      return balanceSpan(source, start, end);
    };
    let found = null;
    for (const from of [cursor, 0]) {
      let pos = padded.indexOf(needle, from);
      while (pos !== -1) {
        const span = toSpan(pos);
        if (!overlaps(span.start, span.end)) { found = { span, next: pos + chunk.length }; break; }
        pos = padded.indexOf(needle, pos + 1);
      }
      if (found) break;
    }
    if (found) {
      spans.push(found.span);
      cursor = found.next;
    } else {
      spans.push(null);
    }
  }
  return spans;
}

// 対象テキストのうち、どのチャンクにも含まれない語の部分を返す（引用符・句読点だけの差は無視）。
function findUncoveredParts(target, breakdown) {
  const source = String(target || '');
  const items = Array.isArray(breakdown) ? breakdown : [];
  const spans = locateChunks(source, items.map((item) => item?.chunk));
  const covered = new Array(source.length).fill(false);
  spans.forEach((sp) => { if (sp) covered.fill(true, sp.start, sp.end); });
  const parts = [];
  let start = -1;
  for (let i = 0; i <= source.length; i++) {
    if (i < source.length && !covered[i]) {
      if (start === -1) start = i;
    } else if (start !== -1) {
      const piece = source.slice(start, i);
      if (/[\p{L}\p{N}]/u.test(piece)) {
        // 前後の句読点・空白は落として、語の部分だけを返す
        const lead = piece.search(/[\p{L}\p{N}"'“‘]/u);
        const trimmed = piece.slice(lead).replace(/[\s,;:-]+$/, '');
        parts.push({ start: start + lead, end: start + lead + trimmed.length, text: trimmed.trim() });
      }
      start = -1;
    }
  }
  return parts;
}

// 再依頼しても漏れが残った場合は、漏れた部分を「未解析」のチャンクとして元の位置に補い、黙って消えないようにする。
function fillUncoveredParts(target, breakdown) {
  const parts = findUncoveredParts(target, breakdown);
  if (!parts.length) return breakdown;
  const spans = locateChunks(target, breakdown.map((item) => item?.chunk));
  const located = breakdown.map((item, i) => ({ item, at: spans[i] ? spans[i].start : Infinity }));
  parts.forEach((part) => located.push({ item: { chunk: part.text, role: '?', note: 'AIの構文分解から漏れた部分です（役割は未解析）。' }, at: part.start }));
  return located.sort((x, y) => x.at - y.at).map((entry) => entry.item);
}

async function askLlmWithFullCoverage(prompt, text, config) {
  const data = await askLlm(prompt, config);
  const missing = findUncoveredParts(text, data?.structureBreakdown);
  if (!missing.length) return data;
  // 1回だけ、漏れた部分を示して全体の分解をやり直してもらう。
  const retryPrompt = `${prompt}

Your previous answer's "structureBreakdown" did not cover these parts of the Target: ${missing.map((m) => JSON.stringify(m.text)).join(', ')}.
Return the complete JSON again. The chunks must cover the whole Target, from ${JSON.stringify(text.split(' ').slice(0, 3).join(' '))} to the very end.`;
  let retried = null;
  try {
    retried = await askLlm(retryPrompt, config);
  } catch {}
  const best = retried && findUncoveredParts(text, retried.structureBreakdown).length < missing.length ? retried : data;
  return { ...best, structureBreakdown: fillUncoveredParts(text, Array.isArray(best.structureBreakdown) ? best.structureBreakdown : []) };
}

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
    const data = await askLlmWithFullCoverage(buildExplainPrompt(text, contextSentence, wordDefinitionMode), text, config);
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

// ============================================================
// 記事ごとの単語帳: 利用者が「＋単語」で選んだ語を、記事（ページURL）ごとに端末内へ保存する。
// 保存時は外部へ送信しない。意味（英英・和訳・例文）は単語帳画面で利用者が押したときだけLLMで作る。
// ============================================================
const WORDBOOK_PAGE_LIMIT = 300;
const WORDBOOK_WORD_LIMIT = 200;
const MAX_WORDBOOK_WORD_CHARS = 60;
const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src)$/i;
let wordbookWriteQueue = Promise.resolve();

// 旧版の「未知語★」（解析履歴に付けた印）は単語帳に一本化した。
// 印の付いた語を、意味と元の1文ごと特別な単語帳「履歴から移した未知語」へ1回だけ移し、履歴側の印は消す。
const LEGACY_UNKNOWN_BOOK = 'readanki:unknown-words';

function migrateUnknownWordsToWordbook() {
  const run = async () => {
    const { unknownWordsMigrated, historyIndex = [] } = await chrome.storage.local.get(['unknownWordsMigrated', 'historyIndex']);
    if (unknownWordsMigrated) return;
    const keys = (Array.isArray(historyIndex) ? historyIndex : []).map((id) => `history:${id}`);
    const stored = keys.length ? await chrome.storage.local.get(keys) : {};
    const bookKey = `wordbook:${LEGACY_UNKNOWN_BOOK}`;
    const { [bookKey]: existing, wordbookIndex = [] } = await chrome.storage.local.get([bookKey, 'wordbookIndex']);
    const book = existing || { page: LEGACY_UNKNOWN_BOOK, title: '履歴から移した未知語（★）', createdAt: Date.now(), words: [] };
    const updates = {};
    for (const key of keys) {
      const entry = stored[key];
      const words = Array.isArray(entry?.unknownWords) ? entry.unknownWords : [];
      if (!entry || (!words.length && !entry.reviewSchedule)) continue;
      const vocab = Array.isArray(entry.explanation?.keyVocabulary) ? entry.explanation.keyVocabulary : [];
      for (const raw of words) {
        const word = clampText(raw, MAX_WORDBOOK_WORD_CHARS);
        if (!word || book.words.length >= WORDBOOK_WORD_LIMIT) continue;
        if (book.words.some((item) => item.word.toLowerCase() === word.toLowerCase())) continue;
        const hit = vocab.find((v) => String(v?.word || '').trim() === raw);
        book.words.push({
          word,
          context: clampText(entry.contextSentence || entry.targetPhrase || '', MAX_CONTEXT_CHARS),
          ja: clampText(hit?.meaning || '', 200),
          addedAt: entry.createdAt || Date.now(),
        });
      }
      const { unknownWords, reviewSchedule, ...rest } = entry;
      updates[key] = rest;
    }
    if (book.words.length) {
      book.updatedAt = Date.now();
      updates[bookKey] = book;
      const index = Array.isArray(wordbookIndex) ? wordbookIndex : [];
      if (!index.includes(LEGACY_UNKNOWN_BOOK)) updates.wordbookIndex = [LEGACY_UNKNOWN_BOOK, ...index];
    }
    updates.unknownWordsMigrated = true;
    await chrome.storage.local.set(updates);
  };
  const safe = () => run().catch((error) => console.warn('ReadAnki: failed to migrate unknown words', error));
  wordbookWriteQueue = wordbookWriteQueue.then(safe, safe);
  historyWriteQueue = historyWriteQueue.then(() => wordbookWriteQueue, () => wordbookWriteQueue);
  return wordbookWriteQueue;
}

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
      const entry = { word, context: clampText(request.context || '', MAX_CONTEXT_CHARS), addedAt: now };
      // 解説カードの重要語彙から追加したときは、その日本語の意味も入れておく
      const ja = clampText(request.ja || '', 200);
      if (ja) entry.ja = ja;
      book.words.push(entry);
    }
    const others = (Array.isArray(wordbookIndex) ? wordbookIndex : []).filter((item) => item !== page);
    // 満杯のときに古い記事を自動で消すと、ページ側のスクリプトに単語帳を消させる手口になるため、追加を断る。
    if (others.length >= WORDBOOK_PAGE_LIMIT) {
      throw new Error(`単語帳は${WORDBOOK_PAGE_LIMIT}記事までです。単語帳の一覧から、使わない記事の単語帳を削除してください。`);
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
  hint: 'margin-top: 0.6em; font-size: 0.68em; line-height: 1.6; opacity: 0.75;',
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

// 文脈の中で、穴にする語句（S/V/O/C/Mのチャンク）を {{cN::…}} に変えた HTML を返す。
// targets が空なら対象フレーズ全体を穴にする。separate なら c1, c2… と別々のカードにする。
function clozeContextHtml(context, phrase, targets, separate) {
  const list = (Array.isArray(targets) ? targets : [])
    .map((t) => String(t || '').trim())
    .filter(Boolean);
  // 選択部分の位置から探す（同じ語が文の前のほうにあっても、選択部分の中を優先する）
  const [phraseSpan] = phrase ? locateChunks(context, [phrase]) : [null];
  let spans = list.length ? locateChunks(context, list, phraseSpan ? phraseSpan.start : 0).filter(Boolean) : [];
  if (!spans.length) spans = phraseSpan ? [phraseSpan] : [];
  if (!spans.length) return `{{c1::${escapeHtml(phrase || context)}}}`;
  spans.sort((x, y) => x.start - y.start);
  let html = '';
  let pos = 0;
  spans.forEach((sp, i) => {
    html += escapeHtml(context.slice(pos, sp.start));
    html += `{{c${separate ? i + 1 : 1}::${escapeHtml(context.slice(sp.start, sp.end))}}}`;
    pos = sp.end;
  });
  return html + escapeHtml(context.slice(pos));
}

// カードに入れる日本語（設定画面「カードに入れる日本語」）。既定はすべて入れる。
const CARD_JA_DEFAULTS = { grammar: true, vocabulary: true, translation: true, meaning: true, clozeHint: true, structure: true };

function cardJaOptions(ankiConfig) {
  return { ...CARD_JA_DEFAULTS, ...(ankiConfig && typeof ankiConfig.cardJa === 'object' ? ankiConfig.cardJa : {}) };
}

function buildVocabClozeNote(ankiConfig, card, tags, allowDuplicate) {
  const exp = card.explanation || {};
  const phrase = card.targetPhrase || '';
  const context = card.contextSentence || phrase;
  const ja = cardJaOptions(ankiConfig);
  // 表面の和訳ヒント: 穴の部分の訳（画面で選んだ穴に合わせて渡される）。未指定なら選択部分全体の訳。
  const hint = typeof card.clozeHint === 'string'
    ? card.clozeHint.trim()
    : String(exp.targetTranslation || exp.sentenceTranslation || '').trim();
  const front = clozeContextHtml(context, phrase, card.clozeTargets, card.clozeSeparate === true);
  const generatedFields = {
    Text: cardFront(front + (ja.clozeHint && hint ? `<div style="${CARD_STYLE.hint}">${escapeHtml(hint)}</div>` : '')),
    'Back Extra': cardBack([
      cardSection('対象の表現', highlightPhraseInContext(phrase, phrase)),
      cardSection('意味', ja.meaning ? escapeHtml(phrase !== context ? exp.targetTranslation : '') : ''),
      cardSection('訳', ja.translation ? escapeHtml(exp.sentenceTranslation) : ''),
      cardSection('重要語彙', ja.vocabulary ? vocabularyList(exp.keyVocabulary) : ''),
    ]),
  };
  return noteFromFields(ankiConfig, 'vocabClozeDeckName', 'vocabClozeModelName', card, generatedFields, tags, allowDuplicate);
}

function buildGrammarNote(ankiConfig, card, tags, allowDuplicate) {
  const exp = card.explanation || {};
  const phrase = card.targetPhrase || '';
  const context = card.contextSentence || phrase;
  const ja = cardJaOptions(ankiConfig);
  // 表: 例文（問い）、裏: 文法ポイント（答え）
  const generatedFields = {
    Front: cardFront(highlightPhraseInContext(context, phrase)),
    Back: cardBack([
      cardSection('文法ポイント', ja.grammar ? escapeHtml(exp.grammarPoint) : '', 'main'),
      cardSection('訳', ja.translation ? escapeHtml(exp.sentenceTranslation) : ''),
      cardSection('構文', ja.structure ? breakdownChips(exp.structureBreakdown) : ''),
    ]),
  };
  return noteFromFields(ankiConfig, 'grammarDeckName', 'grammarModelName', card, generatedFields, tags, allowDuplicate);
}

function buildEnJaNote(ankiConfig, card, tags, allowDuplicate) {
  const exp = card.explanation || {};
  const phrase = card.targetPhrase || '';
  const context = card.contextSentence || phrase;
  const ja = cardJaOptions(ankiConfig);
  // 表: 英文、裏: 和訳（答えなので常に入れる）
  const generatedFields = {
    Front: cardFront(highlightPhraseInContext(context, phrase)),
    Back: cardBack([
      cardSection('和訳', escapeHtml(exp.sentenceTranslation), 'main'),
      cardSection('文法', ja.grammar ? escapeHtml(exp.grammarPoint) : ''),
    ]),
  };
  return noteFromFields(ankiConfig, 'enJaDeckName', 'enJaModelName', card, generatedFields, tags, allowDuplicate);
}

function buildJaEnNote(ankiConfig, card, tags, allowDuplicate) {
  const exp = card.explanation || {};
  const phrase = card.targetPhrase || '';
  const context = card.contextSentence || phrase;
  const ja = cardJaOptions(ankiConfig);
  // 表: 和訳（問題なので常に入れる）、裏: 英文（入力型では照合の正解になるため、HTMLを含まない英文だけにする）、解説は別フィールド
  const generatedFields = {
    Front: cardFront(escapeHtml(exp.sentenceTranslation || '')),
    Back: escapeHtml(context),
    Extra: cardBack([
      cardSection('対象の表現', highlightPhraseInContext(phrase, phrase)),
      cardSection('文法', ja.grammar ? escapeHtml(exp.grammarPoint) : ''),
      cardSection('構文', ja.structure ? breakdownChips(exp.structureBreakdown) : ''),
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

// ============================================================
// Ankiへ送るHTMLの掃除
// カードの内容はページ上の編集欄から届くため、ページ側のスクリプトに書き換えられている可能性がある。
// Ankiはカード内のHTML・JavaScriptを実行するため、送る直前に、ReadAnkiが作るタグと style 属性だけを残す。
// （Service Worker には DOMParser が無いため、許可リスト方式の字句解析で行う）
// ============================================================
const ANKI_ALLOWED_TAGS = new Set(['div', 'span', 'br', 'hr', 'b', 'strong', 'i', 'em', 'u', 's', 'sub', 'sup', 'small', 'mark', 'p', 'ul', 'ol', 'li', 'ruby', 'rt', 'rp', 'code']);
// 中身ごと捨てるタグ（中身が文字として残ると、スクリプトやCSSの本文がカードに出てしまう）
const ANKI_DROPPED_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'textarea', 'title', 'svg', 'math', 'xmp', 'noembed', 'noframes', 'select', 'frameset']);
const ANKI_TAG_PATTERN = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
const ANKI_ATTR_PATTERN = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function safeInlineStyle(value) {
  const style = String(value || '');
  // url() や式、文字参照・バックスラッシュによる言い換えは、まとめて捨てる。
  if (/url\s*\(|expression\s*\(|javascript:|@import|behavior\s*:|binding|[<>&\\]/i.test(style)) return '';
  return style;
}

function sanitizeAnkiHtml(html) {
  const source = String(html ?? '');
  const escapeText = (text) => text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let out = '';
  let last = 0;
  let dropping = '';
  ANKI_TAG_PATTERN.lastIndex = 0;
  for (let match; (match = ANKI_TAG_PATTERN.exec(source));) {
    if (!dropping) out += escapeText(source.slice(last, match.index));
    last = ANKI_TAG_PATTERN.lastIndex;
    const [whole, closing, rawName, rawAttrs, selfClosing] = match;
    if (whole.startsWith('<!--')) continue;
    const name = rawName.toLowerCase();
    if (dropping) {
      if (closing && name === dropping) dropping = '';
      continue;
    }
    if (ANKI_DROPPED_WITH_CONTENT.has(name)) {
      if (!closing && !selfClosing) dropping = name;
      continue;
    }
    if (!ANKI_ALLOWED_TAGS.has(name)) continue;
    if (closing) {
      out += `</${name}>`;
      continue;
    }
    let style = '';
    ANKI_ATTR_PATTERN.lastIndex = 0;
    for (let attr; (attr = ANKI_ATTR_PATTERN.exec(rawAttrs || ''));) {
      if (attr[1].toLowerCase() === 'style') style = safeInlineStyle(attr[2] ?? attr[3] ?? attr[4] ?? '');
    }
    out += style ? `<${name} style="${style.replace(/"/g, '&quot;')}">` : `<${name}>`;
  }
  if (!dropping) out += escapeText(source.slice(last));
  return out;
}

function sanitizeNoteFields(fields) {
  const clean = {};
  for (const [name, value] of Object.entries(fields || {})) clean[name] = sanitizeAnkiHtml(value);
  return clean;
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
    // htmlToPlainText は &lt; などを文字に戻すため、もう一度エスケープしてからAnkiへ入れる。
    mapped[take(info.typeField)] = escapeHtml(htmlToPlainText(values[1]));
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
    note.fields = sanitizeNoteFields(note.fields);
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
