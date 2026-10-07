// ReadAnki - Content Script (UI v3)
// 文法解説(explain)＋SVOC下線表示のみ。構造ツリー(2パス目)は撤去済み。
(function () {
  const myInstanceId = Symbol('readanki-instance');
  window.__readankiActiveInstance = myInstanceId;

  function isStale() {
    return window.__readankiActiveInstance !== myInstanceId;
  }

  const CIRCLED = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩'];
  const ROLE_JP = { S: '主語', V: '動詞', O: '目的語', C: '補語', M: '修飾語', '?': '未解析' };

  let toolbar = null;
  let popover = null;
  let readankiTip = null;
  let lastSelection = '';
  let lastContext = '';
  let currentSelectionCoords = null;

  // ページ側のスクリプトが作った偽の操作（el.click()・dispatchEvent など）では、ReadAnkiを動かさない。
  // ReadAnkiの画面は通常のDOMに置いているため、ページから要素を押されると、利用者のAPIキーでAIを呼んだり、
  // 書き換えた内容をAnkiへ送ったりできてしまう。本物の操作は isTrusted が true になる。
  const GUARDED_EVENTS = ['click', 'dblclick', 'auxclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup',
    'keydown', 'keyup', 'keypress', 'input', 'change', 'paste', 'submit'];
  function blockSyntheticEventsOnOurUi(e) {
    if (e.isTrusted || isStale()) return;
    const target = e.target;
    if (!(target instanceof Node)) return;
    if (isOurUi(target) || (wordbookToast && wordbookToast.contains(target))) {
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  }

  function init() {
    // 捕捉段階で window に付けると、ReadAnkiの各ボタンのハンドラより先に動く。
    GUARDED_EVENTS.forEach((type) => window.addEventListener(type, blockSyntheticEventsOnOurUi, true));
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('keyup', handleKeyUp);
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('click', (e) => {
      if (isStale() || !e.isTrusted) return;
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
    if (isStale() || !e.isTrusted) return;
    if (isOurUi(e.target)) return;
    removeToolbar();
    removePopover();
  }

  function handleKeyUp(e) {
    if (isStale() || !e.isTrusted) return;
    if (e.key === 'Shift' || (e.key && e.key.startsWith('Arrow'))) {
      checkSelection();
    }
  }

  function handleMouseUp(e) {
    if (isStale() || !e.isTrusted) return;
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
      // リンク（人名など）で文が分かれていても1文全体を取れるよう、段落などのブロック要素の文字から探す。
      const range = selection.getRangeAt(0);
      const block = closestBlock(range.commonAncestorContainer);
      if (block && block.textContent) {
        const before = document.createRange();
        before.setStart(block, 0);
        before.setEnd(range.startContainer, range.startOffset);
        const offsetHint = before.toString().replace(/\s+/g, ' ').trimStart().length;
        context = extractContextSentence(block.textContent, text, offsetHint);
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

  const BLOCK_TAGS = /^(P|LI|DD|DT|BLOCKQUOTE|H[1-6]|TD|TH|CAPTION|FIGCAPTION|PRE|ARTICLE|SECTION|ASIDE|MAIN|DIV|BODY)$/;

  function closestBlock(node) {
    let el = node && node.nodeType === 1 ? node : node?.parentElement;
    while (el && !BLOCK_TAGS.test(el.tagName)) el = el.parentElement;
    return el || null;
  }

  function extractContextSentence(nodeText, selected, offsetHint = 0) {
    const source = String(nodeText || '').replace(/\s+/g, ' ').trim();
    const target = String(selected || '').replace(/\s+/g, ' ').trim();
    // 同じ語句が段落内に複数あるときは、選択した位置に近いものを使う
    let index = source.indexOf(target, Math.max(0, offsetHint - 5));
    if (index === -1) index = source.indexOf(target);
    if (!target || index === -1) return target.slice(0, MAX_CONTEXT_CHARS);
    const before = source.slice(0, index);
    const after = source.slice(index + target.length);
    const startMatch = before.match(/[.!?。！？]\s+(?=[^.!?。！？]*$)/);
    const start = startMatch ? startMatch.index + startMatch[0].length : 0;
    // 選択が文末記号で終わっている場合は、次の文まで広げない。
    const endsSentence = /[.!?。！？]["'”’)\]]*$/.test(target);
    const endMatch = endsSentence ? { index: -1 } : after.match(/[.!?。！？]/);
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
      <span class="readanki-collapsed-group" id="readanki-collapsed-group">
        <button class="readanki-dot-trigger" id="readanki-dot-trigger" title="ReadAnki: クリックしてメニューを展開">
          <span class="readanki-indicator-dot"></span>
          <span class="readanki-dots-symbol">⋯</span>
          <span class="readanki-dots-tag">ReadAnki</span>
        </button>
        <button class="readanki-word-trigger" id="readanki-word-add" title="選んだ単語を、この記事の単語帳に追加（送信はしません）">＋単語</button>
      </span>
      <div class="readanki-toolbar-menu" id="readanki-toolbar-menu" style="display: none;">
        <button class="readanki-btn-mini readanki-btn-collapse" id="readanki-btn-collapse" title="三点リーダーに折りたたむ">
          <span>⋯</span>
        </button>
        <span class="readanki-sep"></span>
        <button class="readanki-btn-mini readanki-btn-primary" id="readanki-btn-explain" title="文法・構文解説 (AI)">
          <span class="readanki-icon">🪄</span>
          <span class="readanki-label">解説</span>
        </button>
        <button class="readanki-btn-mini" id="readanki-btn-word" title="選んだ単語を、この記事の単語帳に追加（送信はしません）">
          <span class="readanki-icon">📚</span>
          <span class="readanki-label">単語</span>
        </button>
        <button class="readanki-btn-mini" id="readanki-btn-image-paste" title="クリップボードのスクリーンショットを解析">
          <span class="readanki-icon">📋</span>
          <span class="readanki-label">画像貼り付け</span>
        </button>
        <button class="readanki-btn-mini" id="readanki-btn-quick-anki" title="Ankiへ追加（試験中の機能です）">
          <span class="readanki-icon">📥</span>
          <span class="readanki-label">Anki</span>
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
    const collapsedGroup = toolbar.querySelector('#readanki-collapsed-group');
    const menuDiv = toolbar.querySelector('#readanki-toolbar-menu');

    function positionElement(targetEl) {
      const w = targetEl.offsetWidth || 110;
      const h = targetEl.offsetHeight || 32;
      let left = coords.x - w / 2 + window.scrollX;
      let top = coords.y - h - 8 + window.scrollY;
      if (top < window.scrollY + 10) {
        top = coords.bottom + 8 + window.scrollY;
      }
      if (left < 10) left = 10;
      if (left + w > window.innerWidth - 10) {
        left = window.innerWidth - w - 10;
      }
      toolbar.style.left = left + 'px';
      toolbar.style.top = top + 'px';
    }
    positionElement(collapsedGroup);

    triggerBtn.onclick = (e) => {
      e.stopPropagation();
      collapsedGroup.style.display = 'none';
      menuDiv.style.display = 'inline-flex';
      positionElement(menuDiv);
    };
    toolbar.querySelector('#readanki-btn-collapse').onclick = (e) => {
      e.stopPropagation();
      menuDiv.style.display = 'none';
      collapsedGroup.style.display = 'inline-flex';
      positionElement(collapsedGroup);
    };
    toolbar.querySelector('#readanki-btn-explain').onclick = (e) => {
      e.stopPropagation();
      openExplanationPopover(coords, text, lastContext);
    };
    const addWord = (e) => {
      e.stopPropagation();
      addToWordbook(text, lastContext);
    };
    toolbar.querySelector('#readanki-word-add').onclick = addWord;
    toolbar.querySelector('#readanki-btn-word').onclick = addWord;
    toolbar.querySelector('#readanki-btn-image-paste').onclick = (e) => {
      e.stopPropagation();
      pasteScreenshotFromClipboard(coords);
    };
    toolbar.querySelector('#readanki-btn-quick-anki').onclick = (e) => {
      e.stopPropagation();
      openExplanationPopover(coords, text, lastContext);
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

  // ---------- 記事ごとの単語帳 ----------
  // 選んだ語とその1文を、この記事の単語帳（端末内）に追加する。ここでは外部へ送信しない。
  function addToWordbook(word, context) {
    const value = String(word || '').replace(/\s+/g, ' ').trim();
    if (value.length > 60) {
      showWordbookToast('単語帳には、単語・熟語（60文字まで）を選んで追加してください。');
      return;
    }
    chrome.runtime.sendMessage(
      { action: 'addWordbookWord', word: value, context, title: document.title },
      (res) => {
        if (isStale()) return;
        if (!res?.success) {
          showWordbookToast('単語帳に追加できませんでした: ' + (res?.error || '不明なエラー'));
          return;
        }
        removeToolbar();
        showWordbookToast(
          res.duplicate ? `「${value}」は登録済みです（この記事: ${res.count}語）` : `「${value}」を単語帳に追加しました（この記事: ${res.count}語）`,
          res.page
        );
      }
    );
  }

  let wordbookToast = null;
  let wordbookToastTimer = null;

  function showWordbookToast(message, page) {
    if (wordbookToast) wordbookToast.remove();
    clearTimeout(wordbookToastTimer);
    wordbookToast = document.createElement('div');
    wordbookToast.className = 'readanki-wordbook-toast';
    const text = document.createElement('span');
    text.textContent = message;
    wordbookToast.appendChild(text);
    if (page) {
      const open = document.createElement('button');
      open.type = 'button';
      open.textContent = '単語帳を開く';
      open.onclick = () => chrome.runtime.sendMessage({ action: 'openWordbook', page });
      wordbookToast.appendChild(open);
    }
    document.body.appendChild(wordbookToast);
    wordbookToastTimer = setTimeout(() => {
      wordbookToast?.remove();
      wordbookToast = null;
    }, 4000);
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

  // 読み上げは tts.js（設定画面で選んだ声・方式）に任せる。外部TTSが失敗したらブラウザ音声で読み、その旨を表示する。
  function playTTS(text, slow = false) {
    if (!window.ReadAnkiTTS) return;
    window.ReadAnkiTTS.speak(text, {
      slow,
      onFallback: (error) => showWordbookToast('外部の読み上げに失敗したため、ブラウザの音声で読み上げます: ' + error.message),
    }).catch((error) => showWordbookToast('読み上げできませんでした: ' + error.message));
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
          <div class="rk-tts-row" id="rk-tts-row" style="display:none;">
            <button type="button" class="rk-tts-btn" id="rk-tts-target" title="選択部分を読み上げる">🔊 選択部分</button>
            <button type="button" class="rk-tts-btn" id="rk-tts-context" title="文全体を読み上げる">🔊 文全体</button>
            <button type="button" class="rk-tts-btn" id="rk-tts-slow" aria-pressed="false" title="ゆっくり読み上げる">🐢 ゆっくり</button>
          </div>
        </div>
        <div class="grammar-note" id="rk-grammar">
          <div class="rk-loading"><div class="rk-spinner"></div><div>構文と文法を解析中…</div></div>
        </div>
        <div class="rk-vocabulary" id="rk-vocabulary" style="display:none;">
          <div class="zone-label">重要語彙<span class="ln"></span></div>
          <div class="rk-vocabulary-list" id="rk-vocabulary-list"></div>
        </div>
        <div class="footer-actions rk-actions" id="rk-actions" style="display:none;">
          <button class="rk-edit-toggle" id="rk-edit-toggle" type="button">✎ 編集・カード形式</button>
          <button class="rk-paraphrase-btn" id="rk-paraphrase-btn" type="button">🔄 言い換え</button>
          <button class="rk-save-history-btn" id="rk-save-history-btn" type="button" title="この解析結果をこの端末の履歴に保存します（保存しなければ残りません）">💾 履歴に保存</button>
          <span class="rk-anki-wrap">
            <button class="btn-add" id="rk-anki-btn" type="button">Ankiに追加（試験中）</button>
            <small class="rk-beta-note">Anki追加は試験中の機能です</small>
          </span>
        </div>
        <div class="rk-edit-fields" id="rk-edit-fields">
          <div class="rk-cardtype">
            <label><input type="radio" name="rk-cardtype" value="vocab-cloze" checked> 語彙Cloze（穴を単語で選択）</label>
            <label><input type="radio" name="rk-cardtype" value="grammar"> Grammar（文法学習）</label>
            <label><input type="radio" name="rk-cardtype" value="en-ja"> 英日（英→和）</label>
            <label><input type="radio" name="rk-cardtype" value="ja-en"> 日英（和→英）</label>
          </div>
          <div class="rk-cloze-picker" id="rk-cloze-picker" style="display:none;">
            <div class="rk-cloze-head">穴にする単語（押して切り替え・Shift＋クリックで範囲。続けて選んだ単語が1つの穴になります。何も選ばなければ選択部分全体）</div>
            <div class="rk-cloze-chips rk-cloze-words" id="rk-cloze-chips"></div>
            <label class="rk-cloze-separate"><input type="checkbox" id="rk-cloze-separate"> 穴ごとに別のカードにする（c1, c2…）</label>
            <div class="rk-cloze-hint-row" id="rk-cloze-hint-row">
              <label class="rk-anki-field-label">和訳ヒント（表面・穴の部分の訳）
                <span class="rk-cloze-hint-line">
                  <input type="text" class="rk-cloze-hint" id="rk-cloze-hint" autocomplete="off">
                  <button type="button" class="rk-cloze-hint-auto" id="rk-cloze-hint-auto" title="手で直した内容を捨て、穴に合わせた訳に戻す">↺ 自動</button>
                </span>
              </label>
              <small class="rk-cloze-warn" id="rk-cloze-hint-status" aria-live="polite"></small>
            </div>
            <small class="rk-cloze-warn">※切り替えると「本文（穴埋め）」欄は作り直されます</small>
          </div>
          <div class="rk-anki-fields" id="rk-anki-fields" aria-live="polite"></div>
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

    const w = 460;
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

  const DISPLAY_LABELS = { grammar: '文法の解説', vocabulary: '重要語彙' };

  function applyDisplaySettings(grammarEl, vocabularyEl, hasVocabulary) {
    const currentPopover = popover;
    chrome.storage.local.get(['displayConfig'], (res) => {
      if (popover !== currentPopover) return;
      const config = res.displayConfig || {};
      const targets = { grammar: grammarEl, vocabulary: hasVocabulary ? vocabularyEl : null };
      Object.entries(targets).forEach(([key, el]) => {
        if (!el) return;
        const mode = config[key] || 'show';
        if (mode === 'show') return;
        const shownDisplay = key === 'vocabulary' ? 'block' : '';
        el.style.display = 'none';
        if (mode !== 'collapse') return;
        const reveal = document.createElement('button');
        reveal.type = 'button';
        reveal.className = 'rk-reveal-btn';
        reveal.textContent = `▸ ${DISPLAY_LABELS[key]}を表示`;
        reveal.onclick = () => {
          const hidden = el.style.display === 'none';
          el.style.display = hidden ? shownDisplay : 'none';
          reveal.textContent = `${hidden ? '▾' : '▸'} ${DISPLAY_LABELS[key]}を${hidden ? '隠す' : '表示'}`;
        };
        el.parentNode.insertBefore(reveal, el);
      });
    });
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

    // 選択部分だけを解析した場合は、選択部分とその訳だけを表示する（文全体とその訳は出さない）。
    const isPartial = !!phrase && !!context && context.trim() !== phrase.trim();
    const glossEl = popover.querySelector('#rk-gloss');
    if (isPartial && data.targetTranslation) {
      glossEl.textContent = data.targetTranslation;
    } else {
      glossEl.textContent = data.sentenceTranslation || data.targetTranslation || '';
    }

    // 解析後の読み上げ（選択部分／文全体、ゆっくり切り替え）
    const ttsRow = popover.querySelector('#rk-tts-row');
    const ttsSlow = popover.querySelector('#rk-tts-slow');
    const ttsIsSlow = () => ttsSlow.getAttribute('aria-pressed') === 'true';
    const ttsTarget = phrase || context;
    if (ttsTarget) {
      ttsRow.style.display = 'flex';
      popover.querySelector('#rk-tts-target').onclick = () => playTTS(ttsTarget, ttsIsSlow());
      const ttsContextBtn = popover.querySelector('#rk-tts-context');
      if (isPartial) ttsContextBtn.onclick = () => playTTS(context, ttsIsSlow());
      else ttsContextBtn.style.display = 'none';
      ttsSlow.onclick = () => ttsSlow.setAttribute('aria-pressed', String(!ttsIsSlow()));
    }

    grammarEl.textContent = data.grammarPoint || '（文法解説なし）';

    // 履歴は自動保存しない。「履歴に保存」を押したときだけ端末内に保存する。
    let entryId = response.entryId || null;

    // 重要語彙: LLMから返された単語・意味・品詞を安全に描画する。
    // 各語の「＋」で、ページ上の「＋単語」と同じくこの記事の単語帳に追加する（覚えていない語の管理は単語帳に一本化）。
    const vocabulary = Array.isArray(data.keyVocabulary) ? data.keyVocabulary : [];
    vocabularyListEl.replaceChildren();
    if (vocabulary.length) {
      // 単語定義モードを取得
      chrome.storage.local.get(['ankiConfig'], async (res) => {
        const wordDefMode = res.ankiConfig?.wordDefinitionMode || 'llm-japanese';
        
        for (const item of vocabulary) {
          const wordKey = String(item?.word || '').trim();
          const row = document.createElement('div');
          row.className = 'rk-vocabulary-row';

          const toggle = document.createElement('button');
          toggle.type = 'button';
          toggle.className = 'rk-unknown-toggle rk-wordbook-add';
          toggle.textContent = '＋';
          toggle.title = 'この記事の単語帳に追加（送信はしません）';
          if (!wordKey) {
            toggle.disabled = true;
          } else {
            toggle.addEventListener('click', () => {
              toggle.disabled = true;
              chrome.runtime.sendMessage(
                { action: 'addWordbookWord', word: wordKey, context, title: document.title, ja: wordDefMode === 'llm-japanese' ? String(item?.meaning || '') : '' },
                (res) => {
                  if (!toggle.isConnected) return;
                  if (!res?.success) {
                    toggle.disabled = false;
                    showWordbookToast('単語帳に追加できませんでした: ' + (res?.error || '不明なエラー'));
                    return;
                  }
                  toggle.textContent = '✓';
                  toggle.classList.add('is-unknown');
                  toggle.title = '単語帳に追加済み';
                  showWordbookToast(
                    res.duplicate ? `「${wordKey}」は登録済みです（この記事: ${res.count}語）` : `「${wordKey}」を単語帳に追加しました（この記事: ${res.count}語）`,
                    res.page
                  );
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

    const saveHistoryBtn = popover.querySelector('#rk-save-history-btn');
    function markHistorySaved() {
      saveHistoryBtn.disabled = true;
      saveHistoryBtn.textContent = '✅ 履歴に保存済み';
    }
    if (entryId) markHistorySaved();
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
          } else {
            saveHistoryBtn.disabled = false;
            saveHistoryBtn.textContent = '💾 履歴に保存';
            alert('履歴の保存に失敗しました: ' + (res?.error || '不明なエラー'));
          }
        }
      );
    };

    actionsEl.style.display = 'flex';

    // 設定「解説カードの表示」: 文法の解説・重要語彙を 表示 / 隠す（押すと表示）/ 表示しない
    applyDisplaySettings(grammarEl, vocabularyEl, vocabulary.length > 0);

    // Ankiの実フィールドを形式ごとに取得・保持し、HTML/Cloze記法を直接編集する。
    const currentPopover = popover;
    const editorEl = popover.querySelector('#rk-anki-fields');
    const cardDrafts = {};
    let activeCardType = 'vocab-cloze';

    function saveActiveDraft() {
      if (!cardDrafts[activeCardType]) return;
      editorEl.querySelectorAll('textarea[data-anki-field]').forEach((field) => {
        cardDrafts[activeCardType][field.dataset.ankiField] = field.value;
      });
    }

    function renderAnkiFields(cardType) {
      const fields = cardDrafts[cardType];
      if (!fields) return;
      // 欄の並びと表示名（Ankiのフィールドへは background 側で役割と位置に合わせて当てはめる）
      const FIELD_LAYOUT = {
        'vocab-cloze': [['Text', '本文（穴埋め）', 4], ['Back Extra', '補足（裏面）', 8]],
        'ja-en': [['Front', '日本語（表面）', 3], ['Back', '英文（入力の正解・文字のみ）', 3], ['Extra', '解説（裏面）', 8]],
      };
      const fieldLayout = FIELD_LAYOUT[cardType] || [['Front', '表面', 4], ['Back', '裏面', 8]];
      editorEl.replaceChildren();
      fieldLayout.forEach(([fieldName, labelText, rows]) => {
        const label = document.createElement('label');
        label.className = 'rk-anki-field-label';
        label.textContent = labelText;
        const textarea = document.createElement('textarea');
        textarea.className = 'rk-anki-field-input';
        textarea.dataset.ankiField = fieldName;
        textarea.rows = rows;
        textarea.value = String(fields[fieldName] || '');
        textarea.addEventListener('input', () => {
          cardDrafts[cardType][fieldName] = textarea.value;
          updateAnkiButton();
        });
        label.appendChild(textarea);
        editorEl.appendChild(label);
      });
    }

    function loadAnkiFields(cardType) {
      if (cardDrafts[cardType]) {
        renderAnkiFields(cardType);
        return;
      }
      editorEl.textContent = 'Ankiカード内容を準備中…';
      chrome.runtime.sendMessage(
        {
          action: 'getAnkiFields',
          card: { targetPhrase: phrase, contextSentence: context, explanation: data, cardType },
        },
        (result) => {
          if (popover !== currentPopover || activeCardType !== cardType) return;
          if (!result?.success || !result.fields) {
            editorEl.textContent = `カード内容を取得できませんでした: ${result?.error || '不明なエラー'}`;
            return;
          }
          if (!cardDrafts[cardType]) cardDrafts[cardType] = { ...result.fields };
          renderAnkiFields(cardType);
        }
      );
    }

    // 語彙Cloze: 選択した英文を単語ごとのボタンに分け、穴にする単語を自由に選んで本文欄をその場で作り直す。
    // （AIの構文分解の区切りには縛られない。連続して選んだ単語が1つの穴になる）
    // 表面には、穴の部分の和訳ヒントを付ける。
    const clozePicker = popover.querySelector('#rk-cloze-picker');
    const clozeChipsEl = popover.querySelector('#rk-cloze-chips');
    const clozeSeparateEl = popover.querySelector('#rk-cloze-separate');
    const clozeHintEl = popover.querySelector('#rk-cloze-hint');
    const clozeHintAutoEl = popover.querySelector('#rk-cloze-hint-auto');
    const clozeHintStatusEl = popover.querySelector('#rk-cloze-hint-status');
    const clozeWords = String(phrase || '').split(/\s+/).filter(Boolean).map((text) => ({ text }));
    const selectedWords = new Set();
    const defaultHint = String(data.targetTranslation || data.sentenceTranslation || '').trim();
    const hintCache = new Map();
    let hintEdited = false;
    let lastClickedWord = -1;
    let clozeRequest = 0;
    let hintTimer = null;

    // 選んだ単語を、連続ごとの穴（単語番号の配列）にまとめる
    function clozeGroups() {
      const sorted = [...selectedWords].sort((x, y) => x - y);
      const groups = [];
      sorted.forEach((k) => {
        const last = groups[groups.length - 1];
        if (last && last[last.length - 1] === k - 1) last.push(k);
        else groups.push([k]);
      });
      return groups;
    }
    const groupText = (group) => group.map((k) => clozeWords[k].text).join(' ').replace(/^[,.;:!?]+|[,.;:!?]+$/g, '');
    const wordKey = (value) => (String(value || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).join(' ');

    // 穴が解析結果のチャンク1つとちょうど同じ語なら、そのチャンクの和訳をすぐ使う
    function chunkJaFor(text) {
      const key = wordKey(text);
      const hit = breakdown.find((b) => wordKey(b.chunk) === key);
      return hit ? String(hit.ja || '').trim() : '';
    }

    function syncClozeUi() {
      clozeChipsEl.querySelectorAll('[data-word]').forEach((btn) => {
        btn.setAttribute('aria-pressed', String(selectedWords.has(Number(btn.dataset.word))));
      });
    }

    function sendClozeFields() {
      const requestId = ++clozeRequest;
      chrome.runtime.sendMessage(
        {
          action: 'getAnkiFields',
          card: {
            targetPhrase: phrase, contextSentence: context, explanation: data, cardType: 'vocab-cloze',
            clozeTargets: clozeGroups().map(groupText), clozeSeparate: clozeSeparateEl.checked,
            clozeHint: clozeHintEl.value,
          },
        },
        (result) => {
          if (popover !== currentPopover || requestId !== clozeRequest || !result?.success) return;
          if (activeCardType === 'vocab-cloze') saveActiveDraft();
          cardDrafts['vocab-cloze'] = { ...(cardDrafts['vocab-cloze'] || result.fields), Text: result.fields.Text };
          if (activeCardType === 'vocab-cloze') renderAnkiFields('vocab-cloze');
          updateAnkiButton();
        }
      );
    }

    // 和訳ヒントを穴に合わせて自動で更新する（手で直した後は上書きしない）。
    // チャンク単位の穴は解析結果の訳をすぐ使い、語単位で切った穴だけ少し待ってからAIに訳を問い合わせる。
    function updateHint() {
      clearTimeout(hintTimer);
      if (hintEdited) return sendClozeFields();
      const groups = clozeGroups();
      if (!groups.length) {
        clozeHintEl.value = defaultHint;
        clozeHintStatusEl.textContent = '';
        return sendClozeFields();
      }
      // ja: 訳（取得中は undefined、取得できなかったら空）
      const parts = groups.map((g) => { const text = groupText(g); return { text, ja: chunkJaFor(text) || undefined }; });
      parts.forEach((part) => { if (part.ja === undefined && hintCache.has(part.text)) part.ja = hintCache.get(part.text); });
      const missing = parts.filter((part) => part.ja === undefined);
      const apply = () => {
        if (hintEdited) return;
        clozeHintEl.value = parts.map((part) => (part.ja === undefined ? '…' : part.ja)).filter(Boolean).join(' ／ ');
        sendClozeFields();
      };
      apply();
      if (!missing.length) {
        clozeHintStatusEl.textContent = '';
        return;
      }
      clozeHintStatusEl.textContent = '訳を取得中…';
      hintTimer = setTimeout(async () => {
        for (const part of missing) {
          const res = await chrome.runtime.sendMessage({ action: 'translateClozePart', part: part.text, sentence: context });
          if (popover !== currentPopover) return;
          if (res?.success) {
            hintCache.set(part.text, res.ja);
            part.ja = res.ja;
          } else {
            part.ja = '';
            clozeHintStatusEl.textContent = `訳を取得できませんでした: ${res?.error || '不明なエラー'}（手で入力できます）`;
          }
        }
        if (clozeHintStatusEl.textContent === '訳を取得中…') clozeHintStatusEl.textContent = '';
        apply();
      }, 600);
    }

    function regenerateClozeText() {
      syncClozeUi();
      updateHint();
    }

    if (clozeWords.length) {
      clozeWords.forEach((w, k) => {
        const word = document.createElement('button');
        word.type = 'button';
        word.className = 'rk-cloze-word';
        word.dataset.word = k;
        word.textContent = w.text;
        word.onclick = (event) => {
          // Shift＋クリックで、前にクリックした単語からの範囲をまとめて切り替える
          if (event.shiftKey && lastClickedWord !== -1) {
            const from = Math.min(lastClickedWord, k);
            const to = Math.max(lastClickedWord, k);
            const turnOn = !selectedWords.has(k);
            for (let x = from; x <= to; x++) turnOn ? selectedWords.add(x) : selectedWords.delete(x);
          } else if (selectedWords.has(k)) {
            selectedWords.delete(k);
          } else {
            selectedWords.add(k);
          }
          lastClickedWord = k;
          regenerateClozeText();
        };
        clozeChipsEl.appendChild(word);
      });
      clozeSeparateEl.onchange = () => {
        if (selectedWords.size) updateHint();
      };
      clozeHintEl.value = defaultHint;
      clozeHintEl.addEventListener('input', () => {
        hintEdited = true;
        clozeHintStatusEl.textContent = '';
        sendClozeFields();
      });
      clozeHintAutoEl.onclick = () => {
        hintEdited = false;
        updateHint();
      };
      // 設定で「語彙Clozeの和訳ヒント」を外している場合は欄を隠す
      chrome.storage.local.get(['ankiConfig'], (res) => {
        if (res.ankiConfig?.cardJa?.clozeHint === false) { const row = popover?.querySelector('#rk-cloze-hint-row'); if (row) row.style.display = 'none'; }
      });
      syncClozeUi();
    }

    function updateClozePicker() {
      clozePicker.style.display = clozeWords.length && activeCardType === 'vocab-cloze' ? 'block' : 'none';
    }
    updateClozePicker();

    // 編集トグル
    popover.querySelector('#rk-edit-toggle').onclick = () => {
      popover.querySelector('#rk-edit-fields').classList.toggle('open');
    };

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

    popover.querySelectorAll('input[name="rk-cardtype"]').forEach((input) => {
      input.addEventListener('change', () => {
        if (!input.checked) return;
        saveActiveDraft();
        activeCardType = input.value;
        updateClozePicker();
        loadAnkiFields(activeCardType);
        updateAnkiButton();
      });
    });

    loadAnkiFields(activeCardType);

    // Anki追加: カード形式ごとに「追加済み」を記録し、同じ形式・同じ内容の二重登録だけを防ぐ。
    // 別の形式を選ぶ、または編集欄の内容を変えると、また追加できる。
    const addedSignatures = new Map();
    const ankiBtn = popover.querySelector('#rk-anki-btn');
    const ankiBtnLabel = ankiBtn.textContent;

    function cardSignature(cardType) {
      return JSON.stringify(cardDrafts[cardType] || null);
    }

    function updateAnkiButton() {
      if (!ankiBtn.isConnected || ankiBtn.dataset.sending === 'true') return;
      const alreadyAdded = addedSignatures.get(activeCardType) === cardSignature(activeCardType);
      ankiBtn.disabled = alreadyAdded;
      ankiBtn.textContent = alreadyAdded ? '✅ この形式は追加済み' : ankiBtnLabel;
      ankiBtn.style.background = alreadyAdded ? '#10b981' : '';
    }

    popover.querySelector('#rk-anki-btn').onclick = () => {
      const cardTypeEl = popover.querySelector('input[name="rk-cardtype"]:checked');
      const cardType = cardTypeEl ? cardTypeEl.value : 'basic';
      saveActiveDraft();
      const fields = cardDrafts[cardType];
      if (!fields) {
        alert('Ankiカード内容の準備が完了してから追加してください。');
        return;
      }
      const btn = ankiBtn;
      const sentSignature = cardSignature(cardType);
      btn.disabled = true;
      btn.dataset.sending = 'true';
      btn.textContent = 'Ankiに送信中…';
      chrome.runtime.sendMessage(
        {
          action: 'addToAnki',
          card: { targetPhrase: phrase, contextSentence: context, explanation: data, cardType, fields },
        },
        (ankiRes) => {
          if (!btn.isConnected) return;
          btn.dataset.sending = 'false';
          if (ankiRes && ankiRes.success) {
            addedSignatures.set(cardType, sentSignature);
            updateAnkiButton();
          } else {
            updateAnkiButton();
            alert('AnkiConnectエラー: ' + (ankiRes?.error || 'Ankiが起動しているか確認してください'));
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
