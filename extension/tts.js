// ReadAnki - 読み上げ（発音）共通モジュール
// 解説カード・ツールバー（content script）、単語帳、設定画面の試聴から使う。
// 既定はブラウザ内蔵の音声（無料・外部送信なし）。設定で外部TTSを選んだ場合だけ background 経由で音声を取得する。
(function () {
  if (window.ReadAnkiTTS) return;

  const ACCENTS = { us: 'en-US', gb: 'en-GB', au: 'en-AU', in: 'en-IN' };
  const DEFAULTS = { engine: 'browser', accent: 'us', voiceURI: '', rate: 0.95 };
  const SLOW_FACTOR = 0.75;
  const MAX_CHUNK = 200;

  function getConfig() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get('ttsConfig', (res) => resolve({ ...DEFAULTS, ...(res?.ttsConfig || {}) }));
      } catch {
        resolve({ ...DEFAULTS });
      }
    });
  }

  // getVoices() は最初の呼び出しで空のことがあるため、voiceschanged を最大1.5秒待つ。
  function loadVoices() {
    if (!('speechSynthesis' in window)) return Promise.resolve([]);
    const now = speechSynthesis.getVoices();
    if (now.length) return Promise.resolve(now);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        speechSynthesis.removeEventListener('voiceschanged', done);
        resolve(speechSynthesis.getVoices());
      };
      const timer = setTimeout(done, 1500);
      speechSynthesis.addEventListener('voiceschanged', done);
    });
  }

  function voiceLang(voice) {
    return String(voice.lang || '').replace('_', '-');
  }

  // 名前から音質の目安を付ける（Natural/Online > Google > Premium/Enhanced > その他）。
  function voiceScore(voice) {
    const name = String(voice.name || '');
    if (/natural|online/i.test(name)) return 4;
    if (/google/i.test(name)) return 3;
    if (/premium|enhanced|neural/i.test(name)) return 2;
    if (voice.localService === false) return 1;
    return 0;
  }

  function englishVoices(voices, accent) {
    const lang = ACCENTS[accent] || ACCENTS.us;
    return voices
      .filter((v) => voiceLang(v).toLowerCase() === lang.toLowerCase())
      .sort((a, b) => voiceScore(b) - voiceScore(a));
  }

  function pickVoice(voices, config) {
    if (config.voiceURI) {
      const chosen = voices.find((v) => v.voiceURI === config.voiceURI);
      if (chosen) return chosen;
    }
    const sameAccent = englishVoices(voices, config.accent);
    if (sameAccent.length) return sameAccent[0];
    return voices
      .filter((v) => /^en\b/i.test(voiceLang(v)))
      .sort((a, b) => voiceScore(b) - voiceScore(a))[0] || null;
  }

  // ネットワーク音声は長い文が途中で止まることがあるため、文ごと（最大200文字）に分けて順に読む。
  function splitText(text) {
    const chunks = [];
    for (const sentence of String(text).split(/(?<=[.!?;:])\s+/)) {
      let rest = sentence.trim();
      while (rest.length > MAX_CHUNK) {
        let cut = rest.lastIndexOf(' ', MAX_CHUNK);
        if (cut < MAX_CHUNK / 2) cut = MAX_CHUNK;
        chunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      if (rest) chunks.push(rest);
    }
    return chunks;
  }

  async function speakBrowser(text, config, slow) {
    if (!('speechSynthesis' in window)) throw new Error('このブラウザは読み上げに対応していません。');
    speechSynthesis.cancel();
    const voice = pickVoice(await loadVoices(), config);
    const rate = Math.min(2, Math.max(0.3, Number(config.rate) || DEFAULTS.rate)) * (slow ? SLOW_FACTOR : 1);
    for (const chunk of splitText(text)) {
      const utter = new SpeechSynthesisUtterance(chunk);
      if (voice) utter.voice = voice;
      utter.lang = voice ? voiceLang(voice) : ACCENTS[config.accent] || ACCENTS.us;
      utter.rate = rate;
      speechSynthesis.speak(utter);
    }
  }

  let audioCtx = null;
  let currentSource = null;

  // クリック直後（ユーザー操作中）に作っておき、外部音声の取得を待つ間に再生許可が切れないようにする。
  function ensureAudioContext() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtx || audioCtx.state === 'closed') audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function pcm16ToBuffer(ctx, bytes, sampleRate) {
    const samples = Math.floor(bytes.length / 2);
    const buffer = ctx.createBuffer(1, samples, sampleRate || 24000);
    const view = new DataView(bytes.buffer, bytes.byteOffset, samples * 2);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
    return buffer;
  }

  function stop() {
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    if (currentSource) {
      try { currentSource.stop(); } catch {}
      currentSource = null;
    }
  }

  async function speakExternal(text, slow, ctx, configOverride) {
    if (!ctx) throw new Error('このブラウザは音声の再生に対応していません。');
    const res = await chrome.runtime.sendMessage({ action: 'synthesizeSpeech', text, slow, config: configOverride });
    if (!res?.success) throw new Error(res?.error || '音声を取得できませんでした。');
    const bytes = base64ToBytes(res.data);
    const buffer = res.format === 'pcm16'
      ? pcm16ToBuffer(ctx, bytes, res.sampleRate)
      : await ctx.decodeAudioData(bytes.buffer.slice(0));
    stop();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start();
    currentSource = source;
  }

  // opts.slow: ゆっくり / opts.config: 設定画面の試聴用（未保存の値） / opts.onFallback(error): 外部TTS失敗時の通知
  async function speak(text, opts = {}) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (!value) return;
    const ctx = ensureAudioContext();
    const config = { ...(await getConfig()), ...(opts.config || {}) };
    if (config.engine && config.engine !== 'browser') {
      try {
        await speakExternal(value, !!opts.slow, ctx, opts.config);
        return;
      } catch (error) {
        if (typeof opts.onFallback === 'function') opts.onFallback(error);
      }
    }
    await speakBrowser(value, config, !!opts.slow);
  }

  window.ReadAnkiTTS = { speak, stop, loadVoices, englishVoices, pickVoice, voiceScore, ACCENTS, DEFAULTS };
})();
