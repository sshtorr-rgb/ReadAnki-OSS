// ReadAnki - Content Script (UI v3)
// 文法解説(explain)＋SVOC下線表示のみ。構造ツリー(2パス目)は撤去済み。
(function () {
  const myInstanceId = Symbol('readanki-instance');
  window.__readankiActiveInstance = myInstanceId;

  function isStale() {
    return window.__readankiActiveInstance !== myInstanceId;
  }

  const CIRCLED = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩'];
  const ROLE_JP = { S: '主語', V: '動詞', O: '目的語', C: '補語', M: '修飾語' };

  let toolbar = null;
  let popover = null;
  let readankiTip = null;
  let lastSelection = '';
  let lastContext = '';
  let currentSelectionCoords = null;

  // スマホ（Firefox for Android）では長押しで選択するため mouseup が来ない。selectionchange で検知する。
  const IS_TOUCH = window.matchMedia('(pointer: coarse)').matches;
  let selectionTimer = null;

  function handleSelectionChange() {
    if (isStale() || popover) return;
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      const selection = window.getSelection();
      // ツールバーをタップすると選択が外れるため、選択が空になっただけではツールバーを消さない。
      if (!selection || selection.isCollapsed) return;
      checkSelection();
    }, 350);
  }

  function init() {
    if (IS_TOUCH) document.addEventListener('selectionchange', handleSelectionChange);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('keyup', handleKeyUp);
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('click', (e) => {
      if (isStale()) return;
      if (e.target.closest('[data-idx]')) return;
      hideTip();
    });
    // ポップアップ・ショートカットで有効化した時点で既に選択済みなら、すぐツールバーを出す。
    checkSelection();
  }

  function isOurUi(target) {
    return !!(
      (toolbar && toolbar.contains(target)) ||
      (popover && popover.contains(target))
    );
  }

  function handleMouseDown(e) {
    if (isStale()) return;
    if (isOurUi(e.target)) return;
    removeToolbar();
    removePopover();
  }

  function handleKeyUp(e) {
    if (isStale()) return;
    if (e.key === 'Shift' || (e.key && e.key.startsWith('Arrow'))) {
      checkSelection();
    }
  }

  function handleMouseUp(e) {
    if (isStale()) return;
    if (isOurUi(e.target)) return;
    setTimeout(checkSelection, 10);
  }

  function checkSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      if (!popover) removeToolbar();
      return;
    }
    const text = selection.toString().trim();
    if (!text || text.length < 2 || text.length > 500) {
      if (!popover) removeToolbar();
      return;
    }
    let context = text;
    try {
      const anchorNode = selection.anchorNode;
      if (anchorNode && anchorNode.textContent) {
        context = extractContextSentence(anchorNode.textContent, text);
      }
    } catch (e) {}
    lastSelection = text;
    lastContext = context;
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    currentSelectionCoords = {
      x: rect.left + rect.width / 2,
      y: rect.top,
      bottom: rect.bottom,
    };
    showToolbar(currentSelectionCoords, text);
  }

  // 送信・保存する文脈は「選択を含む1文」に限定する（プライバシーポリシーの記載と一致させる）。
  const MAX_CONTEXT_CHARS = 500;

  function extractContextSentence(nodeText, selected) {
    const source = String(nodeText || '').replace(/\s+/g, ' ').trim();
    const target = String(selected || '').replace(/\s+/g, ' ').trim();
    const index = source.indexOf(target);
    if (!target || index === -1) return target.slice(0, MAX_CONTEXT_CHARS);
    const before = source.slice(0, index);
    const after = source.slice(index + target.length);
    const startMatch = before.match(/[.!?。！？]\s+(?=[^.!?。！？]*$)/);
    const start = startMatch ? startMatch.index + startMatch[0].length : 0;
    const endMatch = after.match(/[.!?。！？]/);
    const end = index + target.length + (endMatch ? endMatch.index + 1 : after.length);
    const sentence = source.slice(start, end).trim();
    if (sentence.length <= MAX_CONTEXT_CHARS) return sentence;
    // 1文が長すぎる場合は選択箇所を中心に上限内へ切り詰める。
    const margin = Math.max(0, Math.floor((MAX_CONTEXT_CHARS - target.length) / 2));
    const from = Math.max(start, index - margin);
    return source.slice(from, from + MAX_CONTEXT_CHARS).trim();
  }

  // ---------- フローティングツールバー ----------
  function showToolbar(coords, text) {
    removeToolbar();
    toolbar = document.createElement('div');
    toolbar.id = 'readanki-three-dots-wrapper';
    toolbar.className = 'readanki-dots-wrapper';
    toolbar.innerHTML = `
      <button class="readanki-dot-trigger" id="readanki-dot-trigger" title="ReadAnki: クリックしてメニューを展開">
        <span class="readanki-indicator-dot"></span>
        <span class="readanki-dots-symbol">⋯</span>
        <span class="readanki-dots-tag">ReadAnki</span>
      </button>
      <div class="readanki-toolbar-menu" id="readanki-toolbar-menu" style="display: none;">
        <button class="readanki-btn-mini readanki-btn-collapse" id="readanki-btn-collapse" title="三点リーダーに折りたたむ">
          <span>⋯</span>
        </button>
        <span class="readanki-sep"></span>
        <button class="readanki-btn-mini readanki-btn-primary" id="readanki-btn-explain" title="文法・構文解説 (AI)">
          <span class="readanki-icon">🪄</span>
          <span class="readanki-label">解説</span>
        </button>
        <button class="readanki-btn-mini" id="readanki-btn-image-paste" title="クリップボードのスクリーンショットを解析">
          <span class="readanki-icon">📋</span>
          <span class="readanki-label">画像貼り付け</span>
        </button>
        <button class="readanki-btn-mini" id="readanki-btn-tts" title="発音を聞く">
          <span class="readanki-icon">🔊</span>
        </button>
        <button class="readanki-btn-mini" id="readanki-btn-history" title="解析履歴を開く">
          <span class="readanki-icon">🕘</span>
        </button>
        <button class="readanki-btn-mini" id="readanki-btn-settings" title="設定を開く">
          <span class="readanki-icon">⚙️</span>
        </button>
        <span class="readanki-sep"></span>
        <button class="readanki-btn-mini readanki-btn-close-trigger" id="readanki-btn-close-trigger" title="閉じる">
          <span>✕</span>
        </button>
      </div>
    `;
    document.body.appendChild(toolbar);

    const triggerBtn = toolbar.querySelector('#readanki-dot-trigger');
    const menuDiv = toolbar.querySelector('#readanki-toolbar-menu');

    function positionElement(targetEl) {
      const w = targetEl.offsetWidth || 110;
      const h = targetEl.offsetHeight || 32;
      let left = coords.x - w / 2 + window.scrollX;
      let top = coords.y - h - 8 + window.scrollY;
      // タッチ端末では選択範囲の上にOS標準のメニュー（コピー等）が出るので、下に表示する。
      if (IS_TOUCH || top < window.scrollY + 10) {
        top = coords.bottom + (IS_TOUCH ? 16 : 8) + window.scrollY;
      }
      if (left < 10) left = 10;
      if (left + w > window.innerWidth - 10) {
        left = window.innerWidth - w - 10;
      }
      toolbar.style.left = left + 'px';
      toolbar.style.top = top + 'px';
    }
    positionElement(triggerBtn);

    triggerBtn.onclick = (e) => {
      e.stopPropagation();
      triggerBtn.style.display = 'none';
      menuDiv.style.display = 'inline-flex';
      positionElement(menuDiv);
    };
    toolbar.querySelector('#readanki-btn-collapse').onclick = (e) => {
      e.stopPropagation();
      menuDiv.style.display = 'none';
      triggerBtn.style.display = 'inline-flex';
      positionElement(triggerBtn);
    };
    toolbar.querySelector('#readanki-btn-explain').onclick = (e) => {
      e.stopPropagation();
      openExplanationPopover(coords, text, lastContext);
    };
    toolbar.querySelector('#readanki-btn-image-paste').onclick = (e) => {
      e.stopPropagation();
      pasteScreenshotFromClipboard(coords);
    };
    toolbar.querySelector('#readanki-btn-tts').onclick = (e) => {
      e.stopPropagation();
      playTTS(text);
    };
    toolbar.querySelector('#readanki-btn-history').onclick = (e) => {
      e.stopPropagation();
      removeToolbar();
      chrome.runtime.sendMessage({ action: 'openHistory' });
    };
    toolbar.querySelector('#readanki-btn-settings').onclick = (e) => {
      e.stopPropagation();
      removeToolbar();
      chrome.runtime.sendMessage({ action: 'openOptions' });
    };
    toolbar.querySelector('#readanki-btn-close-trigger').onclick = (e) => {
      e.stopPropagation();
      removeToolbar();
    };
  }

  function removeToolbar() {
    if (toolbar) {
      toolbar.remove();
      toolbar = null;
    }
  }

  function removePopover() {
    if (popover) {
      popover.remove();
      popover = null;
      readankiTip = null;
    }
  }

  function playTTS(text) {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = 'en-US';
      utter.rate = 0.95;
      window.speechSynthesis.speak(utter);
    }
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);
  const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;

  async function imageBlobToPayload(blob) {
    if (!blob || !SUPPORTED_IMAGE_TYPES.has(blob.type)) {
      throw new Error('PNG、JPEG、WebP形式のスクリーンショットを貼り付けてください。');
    }
    if (blob.size > MAX_SCREENSHOT_BYTES) {
      throw new Error('スクリーンショットが大きすぎます。5MB以下の画像を貼り付けてください。');
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('スクリーンショットを読み込めませんでした。'));
      reader.readAsDataURL(blob);
    });
    const match = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);
    if (!match) throw new Error('スクリーンショットを変換できませんでした。');
    return { mimeType: match[1], base64: match[2] };
  }

  async function pasteScreenshotFromClipboard(coords) {
    removeToolbar();
    let clipboardItems;
    try {
      clipboardItems = await navigator.clipboard.read();
    } catch (error) {
      openImagePasteFallback(coords, error.message);
      return;
    }
    for (const item of clipboardItems) {
      const imageType = item.types.find((type) => SUPPORTED_IMAGE_TYPES.has(type));
      if (imageType) {
        try {
          await startImageExplanation(coords, await item.getType(imageType));
        } catch (error) {
          openImagePasteFallback(coords, error.message);
        }
        return;
      }
    }
    openImagePasteFallback(coords, 'クリップボードにスクリーンショットがありません。');
  }

  function openImagePasteFallback(coords, reason) {
    removePopover();
    popover = document.createElement('div');
    popover.innerHTML = `
      <div class="readanki-image-paste" role="dialog" aria-label="スクリーンショット貼り付け">
        <button class="close-x" id="rk-image-paste-close" type="button">&times;</button>
        <div class="rk-image-paste-icon">📋</div>
        <strong>スクリーンショットを貼り付け</strong>
        <p>この枠をクリックしてから <kbd>Ctrl</kbd> + <kbd>V</kbd> を押してください。</p>
        <div class="rk-image-paste-target" id="rk-image-paste-target" contenteditable="true" tabindex="0">ここに貼り付け</div>
        <small>${escapeHtml(reason || 'クリップボードを直接読み取れませんでした。')}</small>
      </div>`;
    document.body.appendChild(popover);
    const dialog = popover.querySelector('.readanki-image-paste');
    const left = Math.max(10, Math.min(coords.x - 150, window.innerWidth - 310));
    const top = Math.max(10, Math.min(coords.y, window.innerHeight - 210));
    dialog.style.left = left + 'px';
    dialog.style.top = top + 'px';
    const target = popover.querySelector('#rk-image-paste-target');
    target.focus();
    popover.querySelector('#rk-image-paste-close').onclick = removePopover;
    target.addEventListener('paste', async (event) => {
      event.preventDefault();
      const items = Array.from(event.clipboardData?.items || []);
      const imageItem = items.find((item) => SUPPORTED_IMAGE_TYPES.has(item.type));
      if (!imageItem) {
        target.textContent = '画像が見つかりません。スクリーンショットをコピーしてから再度貼り付けてください。';
        return;
      }
      try {
        await startImageExplanation(coords, imageItem.getAsFile());
      } catch (error) {
        target.textContent = error.message || '画像を読み込めませんでした。';
      }
    });
  }

  async function startImageExplanation(coords, blob) {
    const image = await imageBlobToPayload(blob);
    openExplanationPopover(coords, '', '', image);
  }

  function numLabel(i) {
    return CIRCLED[i] || String(i + 1);
  }

  // ---------- v3 カード ----------
  const CARD_HTML = `
    <div class="readanki-card-v3">
      <div class="card-header">
        <div class="brand"><span class="dot"></span>ReadAnki<span class="provider" id="rk-provider-badge">解析中…</span></div>
        <button class="close-x" id="rk-close" type="button">&times;</button>
      </div>
      <div class="card-body">
        <div class="read-col">
          <div class="zone-label">原文<span class="ln"></span></div>
          <div class="sentence" id="rk-sentence"></div>
          <div class="gloss" id="rk-gloss"></div>
        </div>
        <div class="grammar-note" id="rk-grammar">
          <div class="rk-loading"><div class="rk-spinner"></div><div>構文と文法を解析中…</div></div>
        </div>
        <div class="rk-vocabulary" id="rk-vocabulary" style="display:none;">
          <div class="zone-label">重要語彙<span class="ln"></span></div>
          <div class="rk-vocabulary-list" id="rk-vocabulary-list"></div>
        </div>
        <div class="footer-actions rk-actions" id="rk-actions" style="display:none;">
          <button class="rk-paraphrase-btn" id="rk-paraphrase-btn" type="button">🔄 言い換え</button>
          <button class="rk-save-history-btn" id="rk-save-history-btn" type="button" title="この解析結果をこの端末の履歴に保存します（保存しなければ残りません）">💾 履歴に保存</button>
        </div>
      </div>
    </div>
    <div class="readanki-tip" id="rk-tip">
      <div class="t-word" id="rk-tip-word"></div>
      <div class="t-general" id="rk-tip-general"></div>
      <div class="t-context" id="rk-tip-context"></div>
    </div>
  `;

  // ---------- ツールチップ＆ハイライト連携 ----------
  function setLinked(idx) {
    if (!popover) return;
    popover.querySelectorAll('[data-idx]').forEach((el) => {
      el.classList.toggle('linked', Number(el.dataset.idx) === idx);
    });
  }
  function hideTip() {
    if (readankiTip) readankiTip.style.display = 'none';
    setLinked(-1);
  }
  function showTip(el, word, general, context) {
    if (!readankiTip) return;
    readankiTip.querySelector('#rk-tip-word').textContent = word;
    readankiTip.querySelector('#rk-tip-general').textContent = general;
    readankiTip.querySelector('#rk-tip-context').textContent = context;
    const r = el.getBoundingClientRect();
    readankiTip.style.display = 'block';
    let left = Math.min(r.left, window.innerWidth - 280);
    if (left < 8) left = 8;
    readankiTip.style.top = (r.bottom + 8) + 'px';
    readankiTip.style.left = left + 'px';
    setLinked(Number(el.dataset.idx));
  }

  // ---------- カードの移動・リサイズ ----------
  function makeCardDraggableAndResizable(cardEl) {
    const header = cardEl.querySelector('.card-header');
    const edgeGap = 10;

    function clampPosition(left, top) {
      const rect = cardEl.getBoundingClientRect();
      return {
        left: Math.max(edgeGap, Math.min(left, window.innerWidth - rect.width - edgeGap)),
        top: Math.max(edgeGap, Math.min(top, window.innerHeight - rect.height - edgeGap)),
      };
    }

    function beginPointerDrag(event, onMove) {
      event.preventDefault();
      const pointerId = event.pointerId;
      const stop = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', stop);
        document.removeEventListener('pointercancel', stop);
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', stop);
      document.addEventListener('pointercancel', stop);
      cardEl.setPointerCapture?.(pointerId);
    }

    header.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('.close-x')) return;
      const rect = cardEl.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      beginPointerDrag(event, (moveEvent) => {
        const position = clampPosition(
          rect.left + moveEvent.clientX - startX,
          rect.top + moveEvent.clientY - startY
        );
        cardEl.style.left = position.left + 'px';
        cardEl.style.top = position.top + 'px';
      });
    });

    const handle = document.createElement('div');
    handle.className = 'card-resize';
    handle.title = 'サイズを変更';
    cardEl.appendChild(handle);

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const rect = cardEl.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      beginPointerDrag(event, (moveEvent) => {
        const maxWidth = Math.max(320, window.innerWidth - rect.left - edgeGap);
        const maxHeight = Math.max(200, window.innerHeight * 0.86);
        cardEl.style.width = Math.min(maxWidth, Math.max(320, rect.width + moveEvent.clientX - startX)) + 'px';
        cardEl.style.height = Math.min(maxHeight, Math.max(200, rect.height + moveEvent.clientY - startY)) + 'px';
      });
    });
  }

  // ---------- メイン: ポップオーバー ----------
  function openExplanationPopover(coords, targetPhrase, contextSentence, image = null) {
    removeToolbar();
    removePopover();

    popover = document.createElement('div');
    popover.innerHTML = CARD_HTML;
    document.body.appendChild(popover);
    readankiTip = popover.querySelector('#rk-tip');

    const w = Math.min(460, window.innerWidth - 20);
    let left = coords.x - w / 2;
    if (left < 10) left = 10;
    if (left + w > window.innerWidth - 10) left = window.innerWidth - w - 10;
    let top = coords.y - 12;
    if (top < 8) top = 8;
    const cardEl = popover.querySelector('.readanki-card-v3');
    cardEl.style.left = left + 'px';
    cardEl.style.top = top + 'px';
    makeCardDraggableAndResizable(cardEl);

    popover.querySelector('#rk-close').onclick = removePopover;
    const currentPopover = popover;

    chrome.runtime.sendMessage(
      image
        ? { action: 'explainImage', image }
        : { action: 'explain', text: targetPhrase, contextSentence: contextSentence },
      (response) => {
        if (popover !== currentPopover) return;
        const resolvedPhrase = image ? response?.targetPhrase || response?.data?.targetPhrase || '' : targetPhrase;
        const resolvedContext = image ? response?.contextSentence || resolvedPhrase : contextSentence;
        renderExplainResponse(response, resolvedPhrase, resolvedContext);
      }
    );
  }

  function renderExplainResponse(response, phrase, context) {
    const grammarEl = popover.querySelector('#rk-grammar');
    const actionsEl = popover.querySelector('#rk-actions');
    const badgeEl = popover.querySelector('#rk-provider-badge');
    const vocabularyEl = popover.querySelector('#rk-vocabulary');
    const vocabularyListEl = popover.querySelector('#rk-vocabulary-list');
    if (!grammarEl) return;

    if (!response || !response.success || !response.data) {
      grammarEl.innerHTML = `
        <div class="rk-error">
          <p>⚠️ 解析に失敗しました。</p>
          <small>${escapeHtml(response?.error || '拡張機能の設定画面でプロバイダまたはAPIキーを確認してください。')}</small>
          <div><button class="rk-btn-sm" id="rk-open-options">設定を開く</button></div>
        </div>`;
      const btn = popover.querySelector('#rk-open-options');
      if (btn) btn.onclick = () => chrome.runtime.sendMessage({ action: 'openOptions' });
      return;
    }

    const data = response.data;
    const provider = response.provider || 'LLM';

    if (badgeEl) badgeEl.textContent = String(provider).toUpperCase();

    // 原文ゾーン: 1回目の structureBreakdown があればそれで表示
    const sentenceEl = popover.querySelector('#rk-sentence');
    const breakdown = Array.isArray(data.structureBreakdown) ? data.structureBreakdown : [];
    if (breakdown.length) {
      breakdown.forEach((b, i) => {
        const role = String(b.role || 'M').toUpperCase();
        let el;
        if (['S', 'V', 'O', 'C'].includes(role)) {
          el = document.createElement('span');
          el.className = 'svoc-wrap role-' + role;
          el.dataset.idx = i;
          el.innerHTML = `<span class="idxb">${numLabel(i)}</span><span class="svoc-label">${role}</span>${escapeHtml(b.chunk || '')}`;
        } else {
          el = document.createElement('span');
          el.className = 'schunk';
          el.dataset.idx = i;
          el.innerHTML = `<span class="idxb">${numLabel(i)}</span>${escapeHtml(b.chunk || '')}`;
        }
        const chunkText = (b.chunk || '').trim();
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          showTip(el, `${numLabel(i)} ${chunkText}`, `役割: ${role}（${ROLE_JP[role] || role}）`, b.note || '');
        });
        sentenceEl.appendChild(el);
      });
    } else {
      sentenceEl.textContent = context || phrase || '';
    }

    const glossEl = popover.querySelector('#rk-gloss');
    glossEl.textContent = data.sentenceTranslation || '';

    grammarEl.textContent = data.grammarPoint || '（文法解説なし）';

    // 履歴は自動保存しない。「履歴に保存」を押すと entryId が付き、未知語★が使えるようになる。
    let entryId = response.entryId || null;
    const unknownToggles = [];

    // 重要語彙: LLMから返された単語・意味・品詞を安全に描画する
    const vocabulary = Array.isArray(data.keyVocabulary) ? data.keyVocabulary : [];
    vocabularyListEl.replaceChildren();
    if (vocabulary.length) {
      const knownUnknown = new Set(
        Array.isArray(response.unknownWords) ? response.unknownWords : []
      );
      
      // 単語定義モードを取得
      chrome.storage.local.get(['ankiConfig'], async (res) => {
        const wordDefMode = res.ankiConfig?.wordDefinitionMode || 'llm-japanese';
        
        for (const item of vocabulary) {
          const wordKey = String(item?.word || '').trim();
          const row = document.createElement('div');
          row.className = 'rk-vocabulary-row';

          const toggle = document.createElement('button');
          toggle.type = 'button';
          toggle.className = 'rk-unknown-toggle';
          const isUnknown = knownUnknown.has(wordKey);
          toggle.setAttribute('aria-pressed', String(isUnknown));
          toggle.classList.toggle('is-unknown', isUnknown);
          toggle.textContent = isUnknown ? '★' : '☆';
          if (!wordKey) {
            toggle.disabled = true;
          } else {
            unknownToggles.push(toggle);
            setUnknownToggleState(toggle);
            toggle.addEventListener('click', () => {
              if (!entryId) return;
              const nextUnknown = toggle.getAttribute('aria-pressed') !== 'true';
              toggle.disabled = true;
              chrome.runtime.sendMessage(
                { action: 'toggleUnknownWord', entryId, word: wordKey, unknown: nextUnknown },
                (res) => {
                  toggle.disabled = false;
                  if (!res || !res.success) {
                    alert('未知語の登録に失敗しました: ' + (res?.error || '不明なエラー'));
                    return;
                  }
                  toggle.setAttribute('aria-pressed', String(nextUnknown));
                  toggle.classList.toggle('is-unknown', nextUnknown);
                  toggle.textContent = nextUnknown ? '★' : '☆';
                }
              );
            });
          }

          const word = document.createElement('span');
          word.className = 'rk-vocabulary-word';
          word.textContent = wordKey || '—';
          
          const meaning = document.createElement('span');
          meaning.className = 'rk-vocabulary-meaning';
          
          const pos = document.createElement('span');
          pos.className = 'rk-vocabulary-pos';
          pos.textContent = String(item?.pos || '');
          
          // 単語定義モードに応じて表示を変更
          if (wordDefMode === 'llm-japanese') {
            meaning.textContent = String(item?.meaning || '');
          } else if (wordDefMode === 'external-link') {
            const link = document.createElement('a');
            link.href = `https://dictionary.cambridge.org/dictionary/english/${encodeURIComponent(wordKey)}`;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = '🔗 辞書で見る';
            link.style.color = '#2563eb';
            link.style.textDecoration = 'none';
            meaning.appendChild(link);
          } else if (wordDefMode === 'llm-paraphrase') {
            meaning.textContent = String(item?.meaning || ''); // LLMが英語言い換えを返す場合
            meaning.style.fontStyle = 'italic';
          } else {
            meaning.textContent = String(item?.meaning || '');
          }
          
          row.append(toggle, word, meaning, pos);
          vocabularyListEl.appendChild(row);
        }
      });
      vocabularyEl.style.display = 'block';
    } else {
      vocabularyEl.style.display = 'none';
    }

    function setUnknownToggleState(toggle) {
      toggle.disabled = !entryId;
      toggle.title = entryId
        ? '未知語としてマーク（履歴タブでまとめて復習できます）'
        : '「履歴に保存」すると未知語として登録できます';
    }

    const saveHistoryBtn = popover.querySelector('#rk-save-history-btn');
    function markHistorySaved() {
      saveHistoryBtn.disabled = true;
      saveHistoryBtn.textContent = '✅ 履歴に保存済み';
    }
    if (entryId) markHistorySaved();
    // プライベートブラウジング中のデータは保存しない（Firefox Add-on Policies 6.3）。
    if (chrome.extension?.inIncognitoContext) {
      saveHistoryBtn.disabled = true;
      saveHistoryBtn.textContent = 'プライベートウィンドウでは履歴に保存しません';
    }
    saveHistoryBtn.onclick = () => {
      if (entryId) return;
      saveHistoryBtn.disabled = true;
      saveHistoryBtn.textContent = '保存中…';
      chrome.runtime.sendMessage(
        { action: 'saveHistory', text: phrase, contextSentence: context, provider, data },
        (res) => {
          if (!saveHistoryBtn.isConnected) return;
          if (res && res.success && res.entryId) {
            entryId = res.entryId;
            markHistorySaved();
            unknownToggles.forEach(setUnknownToggleState);
          } else {
            saveHistoryBtn.disabled = false;
            saveHistoryBtn.textContent = '💾 履歴に保存';
            alert('履歴の保存に失敗しました: ' + (res?.error || '不明なエラー'));
          }
        }
      );
    };

    actionsEl.style.display = 'flex';

    // 言い換えボタン
    popover.querySelector('#rk-paraphrase-btn').onclick = () => {
      const btn = popover.querySelector('#rk-paraphrase-btn');
      btn.disabled = true;
      btn.textContent = '言い換え中…';
      chrome.runtime.sendMessage(
        { action: 'getParaphrase', sentence: context },
        (res) => {
          if (!btn.isConnected) return;
          btn.disabled = false;
          btn.textContent = '🔄 言い換え';
          if (res && res.success && res.data?.paraphrase) {
            const paraphraseDiv = document.createElement('div');
            paraphraseDiv.className = 'rk-paraphrase-result';
            paraphraseDiv.innerHTML = `
              <div class="zone-label">言い換え<span class="ln"></span></div>
              <div class="paraphrase-text">${escapeHtml(res.data.paraphrase)}</div>
            `;
            const grammarEl = popover.querySelector('#rk-grammar');
            if (grammarEl) {
              grammarEl.parentNode.insertBefore(paraphraseDiv, grammarEl.nextSibling);
            }
          } else {
            alert('言い換えの取得に失敗しました: ' + (res?.error || '不明なエラー'));
          }
        }
      );
    };
  }

  // ---------- コンテキストメニュー ----------
  chrome.runtime.onMessage.addListener((request) => {
    if (isStale()) return;
    if (request.action !== 'explainFromContextMenu') return;
    const text = (request.text || lastSelection || '').trim();
    if (!text) return;
    // 右クリック時に注入された直後は選択位置が未取得なので、現在の選択から補う。
    if (!currentSelectionCoords) checkSelection();
    removeToolbar();
    const coords = currentSelectionCoords || {
      x: window.innerWidth / 2,
      y: 80,
      bottom: 120,
    };
    openExplanationPopover(coords, text, lastContext || text);
  });

  init();
})();
