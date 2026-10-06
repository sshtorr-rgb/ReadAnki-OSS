function updateVisibility() {
  const p = document.getElementById('provider').value;
  document.getElementById('local-openai-section').style.display =
    p === 'local-openai' ? 'block' : 'none';
  document.getElementById('ollama-section').style.display = p === 'ollama' ? 'block' : 'none';
  // 外部の読み上げ（発音）で使うAPIキーの欄は、LLMプロバイダが別でも表示する。
  const tts = document.getElementById('ttsEngine').value;
  document.getElementById('openai-section').style.display = p === 'openai' || tts === 'openai' ? 'block' : 'none';
  document.getElementById('gemini-section').style.display = p === 'gemini' || tts === 'gemini' ? 'block' : 'none';
}

document.getElementById('provider').addEventListener('change', updateVisibility);

// ============================================================
// タブ切り替え（最後に開いたタブはこのブラウザにだけ覚える）
// ============================================================
function showTab(key, remember = true) {
  if (!document.getElementById(`panel-${key}`)) key = 'ai';
  document.querySelectorAll('.tabs [data-tab]').forEach((btn) => {
    btn.setAttribute('aria-selected', String(btn.dataset.tab === key));
  });
  document.querySelectorAll('.panel').forEach((panel) => {
    panel.hidden = panel.dataset.panel !== key;
  });
  if (remember) { try { localStorage.setItem('readanki-options-tab', key); } catch {} }
}

document.querySelectorAll('.tabs [data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
});

const prefillSite = new URLSearchParams(location.hash.slice(1)).get('add-site');
let initialTab = 'ai';
try { initialTab = localStorage.getItem('readanki-options-tab') || 'ai'; } catch {}
showTab(prefillSite ? 'sites' : initialTab, false);

// カードに入れる日本語（background.js の CARD_JA_DEFAULTS と同じ項目・既定値）
const CARD_JA_DEFAULTS = { clozeHint: true, grammar: true, translation: true, meaning: true, vocabulary: true, structure: true };

document.querySelectorAll('[data-preset-url]').forEach((el) => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    const url = el.getAttribute('data-preset-url');
    if (url) document.getElementById('localOpenAiUrl').value = url;
  });
});

Promise.all([
  chrome.storage.local.get(['llmConfig', 'ankiConfig', 'privacyConsent', 'persistApiKeys', 'displayConfig']),
  chrome.storage.session.get('llmSecrets'),
]).then(([res, session]) => {
  const secrets = session.llmSecrets || {};
  if (res.llmConfig) {
    document.getElementById('provider').value = res.llmConfig.provider || 'gemini';
    document.getElementById('localOpenAiUrl').value =
      res.llmConfig.localOpenAiUrl || 'http://localhost:1234/v1';
    document.getElementById('localOpenAiModel').value = res.llmConfig.localOpenAiModel || 'local-model';
    document.getElementById('localOpenAiApiKey').value = secrets.localOpenAiApiKey || res.llmConfig.localOpenAiApiKey || '';
    document.getElementById('ollamaUrl').value = res.llmConfig.ollamaUrl || 'http://localhost:11434';
    document.getElementById('ollamaModel').value = res.llmConfig.ollamaModel || 'llama3.2';
    document.getElementById('openAiApiKey').value = secrets.openAiApiKey || res.llmConfig.openAiApiKey || '';
    document.getElementById('openAiModel').value = res.llmConfig.openAiModel || 'gpt-4o-mini';
    document.getElementById('geminiApiKey').value = secrets.geminiApiKey || res.llmConfig.geminiApiKey || '';
    const deprecatedGeminiModels = ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'];
    document.getElementById('geminiModel').value =
      !res.llmConfig.geminiModel || deprecatedGeminiModels.includes(res.llmConfig.geminiModel)
        ? 'gemini-3.1-flash-lite'
        : res.llmConfig.geminiModel;
  }
  if (res.ankiConfig) {
    document.getElementById('ankiUrl').value = res.ankiConfig.url || 'http://127.0.0.1:8765';
    document.getElementById('wordDefinitionMode').value = res.ankiConfig.wordDefinitionMode || 'llm-japanese';
    document.getElementById('vocabClozeDeckName').value =
      res.ankiConfig.vocabClozeDeckName || 'AnkiRead::Vocab-Cloze';
    document.getElementById('vocabClozeModelName').value = res.ankiConfig.vocabClozeModelName || '穴埋め問題';
    document.getElementById('grammarDeckName').value =
      res.ankiConfig.grammarDeckName || 'AnkiRead::Grammar';
    document.getElementById('grammarModelName').value = res.ankiConfig.grammarModelName || '基本';
    document.getElementById('enJaDeckName').value =
      res.ankiConfig.enJaDeckName || 'AnkiRead::EN-JP';
    document.getElementById('enJaModelName').value = res.ankiConfig.enJaModelName || '基本';
    document.getElementById('jaEnDeckName').value =
      res.ankiConfig.jaEnDeckName || 'AnkiRead::JP-EN';
    document.getElementById('jaEnModelName').value = res.ankiConfig.jaEnModelName || '基本 (文字入力解答)';
  }
  const display = res.displayConfig || {};
  document.getElementById('display-grammar').value = display.grammar || 'show';
  document.getElementById('display-vocabulary').value = display.vocabulary || 'show';
  const cardJa = { ...CARD_JA_DEFAULTS, ...(res.ankiConfig?.cardJa || {}) };
  Object.keys(CARD_JA_DEFAULTS).forEach((key) => {
    document.getElementById(`cardJa-${key}`).checked = cardJa[key] !== false;
  });
  document.getElementById('privacyConsent').checked = !!res.privacyConsent;
  // 同意前は「プライバシー」タブから始める（同意しないと保存できないため）
  if (!res.privacyConsent && !prefillSite) showTab('privacy', false);
  document.getElementById('persistApiKeys').checked = !!res.persistApiKeys;
  updateVisibility();
});

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];

function remoteHttpsOrigin(rawUrl) {
  try {
    const url = new URL(String(rawUrl || '').trim());
    if (url.protocol !== 'https:' || LOOPBACK_HOSTS.includes(url.hostname)) return null;
    // ポート指定の有無にかかわらず一致するよう、ホスト名単位で許可を求める。
    return `https://${url.hostname}`;
  } catch {
    return null;
  }
}

document.getElementById('save-btn').addEventListener('click', async () => {
  if (!document.getElementById('privacyConsent').checked) {
    document.getElementById('save-msg').textContent = '利用にはデータ処理への同意が必要です（「🔒 プライバシー」タブ）。';
    showTab('privacy', false);
    return;
  }
  try {
    // 外部のOpenAI互換サーバーを使う場合だけ、そのホストへのアクセスを個別に許可してもらう。
    // ユーザー操作の直後に呼ぶ必要があるため、他の await より先に実行する。
    if (document.getElementById('provider').value === 'local-openai') {
      const origin = remoteHttpsOrigin(document.getElementById('localOpenAiUrl').value);
      if (origin) {
        const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
        if (!granted) {
          document.getElementById('save-msg').textContent = `${origin} へのアクセスが許可されなかったため保存しませんでした。`;
          return;
        }
      }
    }
    const res = await chrome.storage.local.get(['llmConfig', 'ankiConfig']);
    const prevLlm = res.llmConfig || {};
    const prevAnki = res.ankiConfig || {};
    const llmConfig = {
      ...prevLlm,
      provider: document.getElementById('provider').value,
      localOpenAiUrl: document.getElementById('localOpenAiUrl').value,
      localOpenAiModel: document.getElementById('localOpenAiModel').value,
      ollamaUrl: document.getElementById('ollamaUrl').value,
      ollamaModel: document.getElementById('ollamaModel').value,
      openAiModel: document.getElementById('openAiModel').value,
      geminiModel: document.getElementById('geminiModel').value,
    };
    const secrets = {
      localOpenAiApiKey: document.getElementById('localOpenAiApiKey').value,
      openAiApiKey: document.getElementById('openAiApiKey').value,
      geminiApiKey: document.getElementById('geminiApiKey').value,
    };
    const persistApiKeys = document.getElementById('persistApiKeys').checked;
    if (persistApiKeys) Object.assign(llmConfig, secrets);
    else ['localOpenAiApiKey', 'openAiApiKey', 'geminiApiKey'].forEach((key) => delete llmConfig[key]);
    const ankiConfig = {
      ...prevAnki,
      url: document.getElementById('ankiUrl').value,
      wordDefinitionMode: document.getElementById('wordDefinitionMode').value,
      vocabClozeDeckName: document.getElementById('vocabClozeDeckName').value,
      vocabClozeModelName: document.getElementById('vocabClozeModelName').value,
      grammarDeckName: document.getElementById('grammarDeckName').value,
      grammarModelName: document.getElementById('grammarModelName').value,
      enJaDeckName: document.getElementById('enJaDeckName').value,
      enJaModelName: document.getElementById('enJaModelName').value,
      jaEnDeckName: document.getElementById('jaEnDeckName').value,
      jaEnModelName: document.getElementById('jaEnModelName').value,
      cardJa: Object.fromEntries(Object.keys(CARD_JA_DEFAULTS).map((key) => [key, document.getElementById(`cardJa-${key}`).checked])),
    };
    const displayConfig = {
      grammar: document.getElementById('display-grammar').value,
      vocabulary: document.getElementById('display-vocabulary').value,
    };
    await chrome.storage.local.set({ llmConfig, ankiConfig, displayConfig, privacyConsent: true, persistApiKeys });
    if (!persistApiKeys) await chrome.storage.local.remove(['localOpenAiApiKey', 'openAiApiKey', 'geminiApiKey']);
    await chrome.storage.session.set({ llmSecrets: secrets });
    const msg = document.getElementById('save-msg');
    msg.textContent = '✅ 設定を保存しました！';
    setTimeout(() => { msg.textContent = ''; }, 2500);
  } catch (error) {
    document.getElementById('save-msg').textContent = `保存に失敗しました: ${error.message}`;
  }
});

document.getElementById('copy-diagnostic').addEventListener('click', async () => {
  const msg = document.getElementById('diagnostic-msg');
  try {
    const diagnostic = await chrome.runtime.sendMessage({ action: 'getDiagnostic' });
    const output = JSON.stringify({
      extensionVersion: diagnostic.version,
      browser: navigator.userAgent,
      lastError: diagnostic.lastDiagnostic || null,
    }, null, 2);
    await navigator.clipboard.writeText(output);
    msg.textContent = '診断情報をコピーしました。';
  } catch {
    msg.textContent = '診断情報をコピーできませんでした。';
  }
});

// ============================================================
// 常に有効にするサイト（許可サイト）
// ============================================================
function normalizeSite(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  const host = url.hostname.toLowerCase();
  if (!host || host.includes('*')) return null;
  return { host, pattern: `${url.protocol}//${host}/*` };
}

function sitePatterns(host) {
  return [`https://${host}/*`, `http://${host}/*`];
}

async function renderSites() {
  const list = document.getElementById('site-list');
  const { allowedSites = [] } = await chrome.storage.local.get('allowedSites');
  const { origins = [] } = await chrome.permissions.getAll();
  const granted = new Set(origins);
  const sites = (Array.isArray(allowedSites) ? allowedSites : []).filter((host) =>
    sitePatterns(host).some((pattern) => granted.has(pattern))
  );
  list.replaceChildren();
  if (!sites.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '登録されたサイトはありません';
    list.appendChild(li);
    return;
  }
  for (const host of sites) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = host;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'site-remove';
    remove.textContent = '削除';
    remove.addEventListener('click', () => removeSite(host));
    li.append(name, remove);
    list.appendChild(li);
  }
}

async function addSite() {
  const msg = document.getElementById('site-msg');
  const site = normalizeSite(document.getElementById('site-input').value);
  if (!site) {
    msg.textContent = 'サイトのアドレスを正しく入力してください（例: www.bbc.com）。';
    return;
  }
  try {
    // ユーザー操作の直後に呼ぶ必要があるため、最初に権限を求める。
    const granted = await chrome.permissions.request({ origins: [site.pattern] });
    if (!granted) {
      msg.textContent = `${site.host} へのアクセスが許可されなかったため、登録しませんでした。`;
      return;
    }
    const { allowedSites = [] } = await chrome.storage.local.get('allowedSites');
    const next = Array.from(new Set([...(Array.isArray(allowedSites) ? allowedSites : []), site.host]));
    await chrome.storage.local.set({ allowedSites: next });
    document.getElementById('site-input').value = '';
    msg.textContent = `✅ ${site.host} を登録しました。開いているタブは再読み込みすると有効になります。`;
    await renderSites();
  } catch (error) {
    msg.textContent = `登録に失敗しました: ${error.message}`;
  }
}

async function removeSite(host) {
  const msg = document.getElementById('site-msg');
  try {
    const { allowedSites = [] } = await chrome.storage.local.get('allowedSites');
    await chrome.storage.local.set({
      allowedSites: (Array.isArray(allowedSites) ? allowedSites : []).filter((item) => item !== host),
    });
    // OpenAI互換サーバーとして使っているホストの権限は残す。
    const { llmConfig = {} } = await chrome.storage.local.get('llmConfig');
    const endpointHost = llmConfig.provider === 'local-openai' ? normalizeSite(llmConfig.localOpenAiUrl)?.host : null;
    if (endpointHost !== host) await chrome.permissions.remove({ origins: sitePatterns(host) });
    msg.textContent = `${host} の登録を削除しました。`;
    await renderSites();
  } catch (error) {
    msg.textContent = `削除に失敗しました: ${error.message}`;
  }
}

document.getElementById('add-site-btn').addEventListener('click', addSite);
document.getElementById('site-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addSite();
});

// ポップアップの「このサイトを常に有効にする」から開かれた場合は、入力欄に入れておく。
if (prefillSite) {
  document.getElementById('site-input').value = prefillSite;
  document.getElementById('site-input').scrollIntoView({ block: 'center' });
  document.getElementById('site-msg').textContent = '「追加」を押すと、このサイトへのアクセス許可を求めます。';
}
renderSites();

// 日英カード用の専用ノートタイプ（日本語／英文／解説）を Anki に作り、送り先にする。
document.getElementById('create-ja-en-model').addEventListener('click', async () => {
  const msg = document.getElementById('create-model-msg');
  msg.textContent = 'Ankiに作成中…';
  try {
    // 設定画面から AnkiConnect（localhost / 127.0.0.1 のみ）を直接呼ぶ。
    const rawUrl = document.getElementById('ankiUrl').value.trim() || 'http://127.0.0.1:8765';
    let url;
    try { url = new URL(rawUrl); } catch (e) { throw new Error(`AnkiConnect URL「${rawUrl}」が正しくありません。`); }
    if (!LOOPBACK_HOSTS.includes(url.hostname)) throw new Error('AnkiConnect URL は localhost / 127.0.0.1 のみ指定できます。');
    const res = await createJaEnModel(url.toString());
    const { ankiConfig = {} } = await chrome.storage.local.get('ankiConfig');
    await chrome.storage.local.set({ ankiConfig: { ...ankiConfig, url: rawUrl, jaEnModelName: res.modelName } });
    document.getElementById('jaEnModelName').value = res.modelName;
    msg.textContent = res.created
      ? `✅ Ankiに「${res.modelName}」を作成し、日英カードの送り先にしました。`
      : `✅ 「${res.modelName}」は作成済みでした。日英カードの送り先にしました。`;
  } catch (error) {
    msg.textContent = `作成に失敗しました: ${error.message}`;
  }
});

// ============================================================
// 発音（読み上げ）
// ============================================================
const TTS_FIELD_IDS = ['openAiTtsVoice', 'openAiTtsModel', 'geminiTtsVoice', 'geminiTtsModel', 'localTtsUrl', 'localTtsModel', 'localTtsVoice'];
let savedVoiceURI = '';

function readTtsForm() {
  const config = {
    engine: document.getElementById('ttsEngine').value,
    accent: document.getElementById('ttsAccent').value,
    voiceURI: document.getElementById('ttsVoice').value,
    rate: Number(document.getElementById('ttsRate').value) || 0.95,
  };
  TTS_FIELD_IDS.forEach((id) => { config[id] = document.getElementById(id).value.trim(); });
  return config;
}

function updateTtsVisibility() {
  const engine = document.getElementById('ttsEngine').value;
  document.getElementById('tts-browser-section').hidden = engine !== 'browser';
  document.getElementById('tts-openai-section').hidden = engine !== 'openai';
  document.getElementById('tts-gemini-section').hidden = engine !== 'gemini';
  document.getElementById('tts-local-section').hidden = engine !== 'local';
  document.getElementById('tts-external-note').hidden = engine === 'browser';
  updateVisibility();
}

async function renderVoiceOptions() {
  const select = document.getElementById('ttsVoice');
  const current = select.value || savedVoiceURI;
  const accent = document.getElementById('ttsAccent').value;
  const voices = await window.ReadAnkiTTS.loadVoices();
  const list = window.ReadAnkiTTS.englishVoices(voices, accent);
  const auto = window.ReadAnkiTTS.pickVoice(voices, { accent, voiceURI: '' });
  select.replaceChildren();
  const autoOption = document.createElement('option');
  autoOption.value = '';
  autoOption.textContent = `自動（おすすめ）${auto ? `: ${auto.name}` : ''}`;
  select.appendChild(autoOption);
  for (const voice of list) {
    const option = document.createElement('option');
    option.value = voice.voiceURI;
    option.textContent = `${window.ReadAnkiTTS.voiceScore(voice) >= 3 ? '★ ' : ''}${voice.name}${voice.localService ? '' : '（オンライン）'}`;
    select.appendChild(option);
  }
  if (!list.length) autoOption.textContent += '（このアクセントの声がありません）';
  select.value = list.some((v) => v.voiceURI === current) ? current : '';
}

chrome.storage.local.get('ttsConfig').then(({ ttsConfig = {} }) => {
  const config = { ...window.ReadAnkiTTS.DEFAULTS, ...ttsConfig };
  document.getElementById('ttsEngine').value = config.engine;
  document.getElementById('ttsAccent').value = config.accent;
  document.getElementById('ttsRate').value = config.rate;
  document.getElementById('ttsRateLabel').textContent = Number(config.rate).toFixed(2);
  TTS_FIELD_IDS.forEach((id) => { if (config[id]) document.getElementById(id).value = config[id]; });
  savedVoiceURI = config.voiceURI || '';
  updateTtsVisibility();
  renderVoiceOptions();
});

document.getElementById('ttsEngine').addEventListener('change', updateTtsVisibility);
document.getElementById('ttsAccent').addEventListener('change', () => {
  document.getElementById('ttsVoice').value = '';
  renderVoiceOptions();
});
document.getElementById('ttsRate').addEventListener('input', (e) => {
  document.getElementById('ttsRateLabel').textContent = Number(e.target.value).toFixed(2);
});

document.getElementById('tts-preview').addEventListener('click', () => {
  const msg = document.getElementById('tts-msg');
  const config = readTtsForm();
  msg.textContent = config.engine === 'browser' ? '' : '音声を取得中…';
  window.ReadAnkiTTS.speak('Reading the news every day is a great way to improve your English.', {
    config,
    onFallback: (error) => { msg.textContent = `外部の読み上げに失敗したため、ブラウザの音声で再生しました: ${error.message}`; },
  }).then(() => {
    if (msg.textContent === '音声を取得中…') msg.textContent = '';
  }).catch((error) => { msg.textContent = `読み上げできませんでした: ${error.message}`; });
});

// 「設定を保存」で発音の設定も保存する（APIキーは保存しない。AI設定の欄のものを使う）。
document.getElementById('save-btn').addEventListener('click', async () => {
  if (!document.getElementById('privacyConsent').checked) return;
  const config = readTtsForm();
  if (config.engine === 'local') {
    try {
      const url = new URL(config.localTtsUrl);
      if (!LOOPBACK_HOSTS.includes(url.hostname)) throw new Error();
    } catch {
      document.getElementById('tts-msg').textContent = 'ローカルTTS URL は localhost / 127.0.0.1 のみ指定できます。発音の設定は保存しませんでした。';
      return;
    }
  }
  await chrome.storage.local.set({ ttsConfig: config });
  savedVoiceURI = config.voiceURI;
});
