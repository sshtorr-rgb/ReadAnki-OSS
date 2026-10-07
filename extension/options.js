function updateVisibility() {
  const p = document.getElementById('provider').value;
  document.getElementById('local-openai-section').style.display =
    p === 'local-openai' ? 'block' : 'none';
  document.getElementById('ollama-section').style.display = p === 'ollama' ? 'block' : 'none';
  document.getElementById('openai-section').style.display = p === 'openai' ? 'block' : 'none';
  document.getElementById('gemini-section').style.display = p === 'gemini' ? 'block' : 'none';
}

document.getElementById('provider').addEventListener('change', updateVisibility);

document.querySelectorAll('[data-preset-url]').forEach((el) => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    const url = el.getAttribute('data-preset-url');
    if (url) document.getElementById('localOpenAiUrl').value = url;
  });
});

Promise.all([
  chrome.storage.local.get(['llmConfig', 'ankiConfig', 'privacyConsent', 'persistApiKeys']),
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
    document.getElementById('wordDefinitionMode').value = res.ankiConfig.wordDefinitionMode || 'llm-japanese';
  }
  document.getElementById('privacyConsent').checked = !!res.privacyConsent;
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
    document.getElementById('save-msg').textContent = '利用にはデータ処理への同意が必要です。';
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
    // Firefox版はAnki連携を持たないため、語義の表示方法だけを保存する（以前のAnki設定は消える）。
    const ankiConfig = { wordDefinitionMode: document.getElementById('wordDefinitionMode').value };
    await chrome.storage.local.set({ llmConfig, ankiConfig, privacyConsent: true, persistApiKeys });
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

