const listEl = document.getElementById('history-list');
const searchEl = document.getElementById('search-input');
const countEl = document.getElementById('history-count');
const clearButton = document.getElementById('clear-history');
const exportUnknownButton = document.getElementById('export-unknown');
const generateSentenceQuizButton = document.getElementById('generate-sentence-quiz');
let entries = [];

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(timestamp) {
  return new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
}

async function loadHistory() {
  const { historyIndex = [] } = await chrome.storage.local.get('historyIndex');
  const ids = Array.isArray(historyIndex) ? historyIndex : [];
  if (!ids.length) return [];
  const values = await chrome.storage.local.get(ids.map((id) => `history:${id}`));
  return ids.map((id) => values[`history:${id}`]).filter(Boolean);
}

function detailsHtml(entry) {
  const data = entry.explanation || {};
  const breakdown = Array.isArray(data.structureBreakdown) ? data.structureBreakdown : [];
  const vocabulary = Array.isArray(data.keyVocabulary) ? data.keyVocabulary : [];
  const section = (title, value, className = 'detail-text') => value ? `<section class="detail-section"><p class="detail-label">${title}</p><p class="${className}">${escapeHtml(value)}</p></section>` : '';
  const list = (title, items, renderer) => items.length ? `<section class="detail-section"><p class="detail-label">${title}</p><ul class="list">${items.map(renderer).join('')}</ul></section>` : '';
  return `
    ${section('対象文', entry.contextSentence, 'context')}
    ${section('品詞・構文', data.partOfSpeech)}
    ${section('文の和訳', data.sentenceTranslation)}
    ${list('文法・構文分解', breakdown, (item) => `<li><strong>${escapeHtml(item.chunk)}</strong> [${escapeHtml(item.role)}] ${escapeHtml(item.note)}</li>`)}
    ${section('実践文法ポイント', data.grammarPoint)}
    ${section('ニュアンス', data.nuanceNotes)}
    ${list('重要語彙', vocabulary, (item) => `<li><strong>${escapeHtml(item.word)}</strong> [${escapeHtml(item.pos)}] ${escapeHtml(item.meaning)}</li>`)}
  `;
}

function render() {
  const query = searchEl.value.trim().toLocaleLowerCase();
  const filtered = entries.filter((entry) => {
    const data = entry.explanation || {};
    return !query || `${entry.targetPhrase} ${data.sentenceTranslation || ''}`.toLocaleLowerCase().includes(query);
  });
  countEl.textContent = entries.length ? `${filtered.length} / ${entries.length} 件` : '';
  if (!filtered.length) {
    const template = document.getElementById('empty-template');
    listEl.replaceChildren(template.content.cloneNode(true));
    const title = listEl.querySelector('h2');
    if (entries.length && title) {
      title.textContent = '一致する履歴はありません';
      listEl.querySelector('p').textContent = '検索語を変えてもう一度お試しください。';
    }
    return;
  }
  listEl.innerHTML = filtered.map((entry) => {
    const data = entry.explanation || {};
    const phrase = entry.targetPhrase || data.targetPhrase || '（対象フレーズなし）';
    return `<article class="history-item">
      <div class="history-item-header">
        <button class="history-summary" type="button" aria-expanded="false">
        <div><h2 class="phrase">${escapeHtml(phrase)}</h2>
        <p class="meaning">${escapeHtml(data.sentenceTranslation || '訳なし')}</p>
        <div class="meta"><time>${escapeHtml(formatDate(entry.createdAt))}</time><span class="badge">${escapeHtml(entry.provider || 'LLM')}</span>${Array.isArray(entry.unknownWords) && entry.unknownWords.length ? `<span class="badge" style="color:#b45309;background:#fff7ed;">未知語 ${entry.unknownWords.length}</span>` : ''}</div></div>
        <span class="chevron" aria-hidden="true">⌄</span>
        </button>
        <button class="delete-history-button" type="button" data-history-id="${escapeHtml(entry.id)}" aria-label="${escapeHtml(phrase)}を削除" title="この履歴を削除">🗑️</button>
      </div>
      <div class="history-detail">${detailsHtml(entry)}</div>
    </article>`;
  }).join('');
  listEl.querySelectorAll('.history-summary').forEach((button) => {
    button.addEventListener('click', () => {
      const item = button.closest('.history-item');
      const open = item.classList.toggle('is-open');
      button.setAttribute('aria-expanded', String(open));
    });
  });
  listEl.querySelectorAll('.delete-history-button').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.dataset.historyId;
      const entry = entries.find((item) => item.id === id);
      if (!entry || !confirm(`「${entry.targetPhrase || 'この履歴'}」を削除しますか？`)) return;
      const { historyIndex = [] } = await chrome.storage.local.get('historyIndex');
      await chrome.storage.local.remove(`history:${id}`);
      await chrome.storage.local.set({ historyIndex: historyIndex.filter((indexId) => indexId !== id) });
      entries = entries.filter((item) => item.id !== id);
      render();
      updateQuizButton();
    });
  });
}

searchEl.addEventListener('input', render);
clearButton.addEventListener('click', async () => {
  if (!entries.length || !confirm(`解析履歴 ${entries.length} 件をすべて削除しますか？`)) return;
  const { historyIndex = [] } = await chrome.storage.local.get('historyIndex');
  await chrome.storage.local.remove(historyIndex.map((id) => `history:${id}`));
  await chrome.storage.local.set({ historyIndex: [] });
  entries = [];
  render();
  updateQuizButton();
});

loadHistory().then((loaded) => { entries = loaded; render(); updateQuizButton(); }).catch((error) => {
  console.error('ReadAnki: failed to load history', error);
  listEl.textContent = '履歴を読み込めませんでした。';
});

// ==================== 未知語テスト ====================
const quizOpenButton = document.getElementById('open-quiz');
const quizCountEl = document.getElementById('quiz-count');
const quizOverlay = document.getElementById('quiz-overlay');
const quizProgressEl = document.getElementById('quiz-progress');
const quizBodyEl = document.getElementById('quiz-body');
const quizCloseButton = document.getElementById('quiz-close');

let quizItems = [];
let quizIndex = 0;
let sentenceQuizItems = [];
let sentenceQuizIndex = 0;

// 全エントリの unknownWords を、出題用の平坦なリストに展開する。
// 意味・品詞は該当エントリの keyVocabulary から該当する語を探して補う。
function collectUnknownItems() {
  const items = [];
  entries.forEach((entry) => {
    const words = Array.isArray(entry.unknownWords) ? entry.unknownWords : [];
    if (!words.length) return;
    const vocab = Array.isArray(entry.explanation?.keyVocabulary) ? entry.explanation.keyVocabulary : [];
    words.forEach((w) => {
      const vocabItem = vocab.find((v) => String(v?.word || '').trim() === w);
      items.push({
        entryId: entry.id,
        word: w,
        meaning: vocabItem?.meaning || '（意味の記録なし）',
        pos: vocabItem?.pos || '',
        contextSentence: entry.contextSentence || entry.targetPhrase || '',
        createdAt: entry.createdAt || 0,
      });
    });
  });
  return items;
}

// 未知語を時系列順に15個ずつのチャンクに分割
function groupUnknownWordsIntoChunks(items, chunkSize = 15) {
  const sortedItems = [...items].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const chunks = [];
  for (let i = 0; i < sortedItems.length; i += chunkSize) {
    chunks.push(sortedItems.slice(i, i + chunkSize));
  }
  return chunks;
}

function updateQuizButton() {
  const count = collectUnknownItems().length;
  const chunks = groupUnknownWordsIntoChunks(collectUnknownItems());
  quizCountEl.textContent = String(count);
  quizOpenButton.style.display = count > 0 ? 'inline-flex' : 'none';
  generateSentenceQuizButton.style.display = chunks.length > 0 ? 'inline-flex' : 'none';
  exportUnknownButton.style.display = count > 0 ? 'inline-flex' : 'none';
}

// HTMLエスケープ後の文字列に対してハイライトするため、
// 単語の前後に記号が付く場合（"word," 等）は一致しないことがある。取りこぼしはそのまま非強調表示にする。
function highlightWord(sentence, word) {
  const escaped = escapeHtml(sentence);
  const w = escapeHtml(word.trim());
  if (!w) return escaped;
  const escapedForRegex = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escapedForRegex, 'i');
  return escaped.replace(re, (m) => `<mark>${m}</mark>`);
}

function renderQuizStep() {
  if (quizIndex >= quizItems.length) {
    quizProgressEl.textContent = '完了';
    quizBodyEl.innerHTML = `
      <div class="quiz-summary">
        <p>今回のセットはこれで終わりです。</p>
        <button class="quiz-primary-btn" id="quiz-finish">閉じる</button>
      </div>`;
    document.getElementById('quiz-finish').addEventListener('click', closeQuiz);
    return;
  }
  const item = quizItems[quizIndex];
  quizProgressEl.textContent = `${quizIndex + 1} / ${quizItems.length}`;
  quizBodyEl.innerHTML = `
    <div class="quiz-sentence">${highlightWord(item.contextSentence, item.word)}</div>
    <button class="quiz-reveal-btn" id="quiz-reveal">答えを見る</button>
    <div class="quiz-msg"></div>
  `;
  document.getElementById('quiz-reveal').addEventListener('click', () => showAnswer(item));
}

function showAnswer(item) {
  quizBodyEl.innerHTML = `
    <div class="quiz-sentence">${highlightWord(item.contextSentence, item.word)}</div>
    <div class="quiz-answer">
      <div class="quiz-answer-word">${escapeHtml(item.word)}</div>
      ${item.pos ? `<div class="quiz-answer-pos">${escapeHtml(item.pos)}</div>` : ''}
      <div class="quiz-answer-meaning">${escapeHtml(item.meaning)}</div>
    </div>
    <div class="quiz-actions">
      <button class="quiz-btn-forgot" id="quiz-forgot">忘れた (3分後)</button>
      <button class="quiz-btn-difficult" id="quiz-difficult">難しい (10分後)</button>
      <button class="quiz-btn-easy" id="quiz-easy">簡単 (3時間後)</button>
      <button class="quiz-btn-remembered" id="quiz-remembered">覚えた (6日後)</button>
    </div>
    <div class="quiz-msg" id="quiz-msg"></div>
  `;
  document.getElementById('quiz-forgot').addEventListener('click', () => scheduleReview(item, 3 * 60 * 1000));
  document.getElementById('quiz-difficult').addEventListener('click', () => scheduleReview(item, 10 * 60 * 1000));
  document.getElementById('quiz-easy').addEventListener('click', () => scheduleReview(item, 3 * 60 * 60 * 1000));
  document.getElementById('quiz-remembered').addEventListener('click', () => scheduleReview(item, 6 * 24 * 60 * 60 * 1000));
}

async function scheduleReview(item, delayMs) {
  const reviewTime = Date.now() + delayMs;
  
  // Store review schedule in entry metadata
  const entry = entries.find((e) => e.id === item.entryId);
  if (!entry) return;
  
  if (!entry.reviewSchedule) entry.reviewSchedule = {};
  entry.reviewSchedule[item.word] = reviewTime;
  
  // Update storage
  try {
    await chrome.storage.local.set({ [`history:${entry.id}`]: entry });
    
    // Move to next question
    quizIndex += 1;
    renderQuizStep();
  } catch (err) {
    const msg = document.getElementById('quiz-msg');
    if (msg) msg.textContent = 'レビュー予定の保存に失敗しました: ' + err.message;
  }
}

async function markKnown(item) {
  const res = await chrome.runtime.sendMessage({
    action: 'toggleUnknownWord',
    entryId: item.entryId,
    word: item.word,
    unknown: false,
  });
  if (!res || !res.success) {
    const msg = document.getElementById('quiz-msg');
    if (msg) msg.textContent = '未知語の解除に失敗しました: ' + (res?.error || '不明なエラー');
    return;
  }
  const entry = entries.find((e) => e.id === item.entryId);
  if (entry) entry.unknownWords = res.unknownWords;
  quizItems = quizItems.filter((_, i) => i !== quizIndex);
  updateQuizButton();
  render();
  renderQuizStep();
}

// 現状はAnki設計未整理のため、単語専用カードではなく既存のBasicノート
// （英文＋文訳＋文法解説）をそのまま流用する。Clozeは buildClozeNote 側の
// 既知バグ（編集済みfieldsが無視される）を踏むため、ここではBasic固定にしている。
async function sendToAnki(item, btn) {
  const entry = entries.find((e) => e.id === item.entryId);
  if (!entry) return;
  btn.disabled = true;
  btn.textContent = '送信中…';
  const res = await chrome.runtime.sendMessage({
    action: 'addToAnki',
    card: {
      targetPhrase: entry.targetPhrase,
      contextSentence: entry.contextSentence,
      explanation: entry.explanation,
      cardType: 'basic',
    },
  });
  if (res && res.success) {
    btn.textContent = '✅ 追加済み';
  } else {
    btn.textContent = '📥 この例文をAnkiに追加';
    btn.disabled = false;
    const msg = document.getElementById('quiz-msg');
    if (msg) msg.textContent = 'Anki追加に失敗しました: ' + (res?.error || 'Ankiが起動しているか確認してください');
  }
}

function openQuiz() {
  quizItems = collectUnknownItems();
  quizIndex = 0;
  quizOverlay.style.display = 'flex';
  renderQuizStep();
}

function closeQuiz() {
  quizOverlay.style.display = 'none';
}

quizOpenButton.addEventListener('click', openQuiz);
quizCloseButton.addEventListener('click', closeQuiz);
quizOverlay.addEventListener('click', (e) => {
  if (e.target === quizOverlay) closeQuiz();
});

// ==================== 例文テスト生成 ====================
generateSentenceQuizButton.addEventListener('click', async () => {
  const chunks = groupUnknownWordsIntoChunks(collectUnknownItems());
  if (!chunks.length) return;
  
  if (!confirm(`${chunks.length}グループの15語セットがあります。最初のグループで例文テストを生成しますか？`)) return;
  
  generateSentenceQuizButton.disabled = true;
  generateSentenceQuizButton.textContent = '生成中…';
  
  try {
    const firstChunk = chunks[0];
    const res = await chrome.runtime.sendMessage({
      action: 'generateExampleSentences',
      words: firstChunk
    });
    
    if (res && res.success && res.data) {
      sentenceQuizItems = firstChunk.map((item, idx) => ({
        ...item,
        generatedSentence: res.data.sentence || '',
        generatedMeanings: res.data.words || []
      }));
      sentenceQuizIndex = 0;
      openSentenceQuiz();
    } else {
      alert('例文の生成に失敗しました: ' + (res?.error || '不明なエラー'));
    }
  } catch (err) {
    alert('例文の生成に失敗しました: ' + err.message);
  } finally {
    generateSentenceQuizButton.disabled = false;
    generateSentenceQuizButton.textContent = '📝 例文テスト生成 (15語)';
  }
});

function openSentenceQuiz() {
  quizOverlay.style.display = 'flex';
  renderSentenceQuizStep();
}

function renderSentenceQuizStep() {
  if (sentenceQuizIndex >= sentenceQuizItems.length) {
    quizProgressEl.textContent = '完了';
    quizBodyEl.innerHTML = `
      <div class="quiz-summary">
        <p>例文テストが完了しました。</p>
        <button class="quiz-primary-btn" id="quiz-finish">閉じる</button>
      </div>`;
    document.getElementById('quiz-finish').addEventListener('click', closeQuiz);
    return;
  }
  
  const item = sentenceQuizItems[sentenceQuizIndex];
  quizProgressEl.textContent = `${sentenceQuizIndex + 1} / ${sentenceQuizItems.length}`;
  
  // 生成された例文を表示し、単語をハイライト
  const highlightedSentence = highlightWord(item.generatedSentence, item.word);
  
  quizBodyEl.innerHTML = `
    <div class="quiz-sentence">${highlightedSentence}</div>
    <button class="quiz-reveal-btn" id="quiz-reveal">答えを見る</button>
    <div class="quiz-msg"></div>
  `;
  
  document.getElementById('quiz-reveal').addEventListener('click', () => showSentenceAnswer(item));
}

function showSentenceAnswer(item) {
  const generatedMeaning = item.generatedMeanings.find(g => g.word === item.word);
  
  quizBodyEl.innerHTML = `
    <div class="quiz-sentence">${highlightWord(item.generatedSentence, item.word)}</div>
    <div class="quiz-answer">
      <div class="quiz-answer-word">${escapeHtml(item.word)}</div>
      ${item.pos ? `<div class="quiz-answer-pos">${escapeHtml(item.pos)}</div>` : ''}
      <div class="quiz-answer-meaning">${escapeHtml(item.meaning)}</div>
      ${generatedMeaning ? `<div class="quiz-generated-meaning">生成された意味: ${escapeHtml(generatedMeaning.meaning || '')}</div>` : ''}
    </div>
    <div class="quiz-actions">
      <button class="quiz-btn-forgot" id="quiz-forgot">忘れた (3分後)</button>
      <button class="quiz-btn-difficult" id="quiz-difficult">難しい (10分後)</button>
      <button class="quiz-btn-easy" id="quiz-easy">簡単 (3時間後)</button>
      <button class="quiz-btn-remembered" id="quiz-remembered">覚えた (6日後)</button>
    </div>
    <div class="quiz-msg" id="quiz-msg"></div>
  `;
  
  document.getElementById('quiz-forgot').addEventListener('click', () => scheduleReviewInSentenceQuiz(item, 3 * 60 * 1000));
  document.getElementById('quiz-difficult').addEventListener('click', () => scheduleReviewInSentenceQuiz(item, 10 * 60 * 1000));
  document.getElementById('quiz-easy').addEventListener('click', () => scheduleReviewInSentenceQuiz(item, 3 * 60 * 60 * 1000));
  document.getElementById('quiz-remembered').addEventListener('click', () => scheduleReviewInSentenceQuiz(item, 6 * 24 * 60 * 60 * 1000));
}

async function scheduleReviewInSentenceQuiz(item, delayMs) {
  const reviewTime = Date.now() + delayMs;
  
  // Store review schedule in entry metadata
  const entry = entries.find((e) => e.id === item.entryId);
  if (!entry) return;
  
  if (!entry.reviewSchedule) entry.reviewSchedule = {};
  entry.reviewSchedule[item.word] = reviewTime;
  
  // Update storage
  try {
    await chrome.storage.local.set({ [`history:${entry.id}`]: entry });
    
    // Move to next question
    sentenceQuizIndex += 1;
    renderSentenceQuizStep();
  } catch (err) {
    const msg = document.getElementById('quiz-msg');
    if (msg) msg.textContent = 'レビュー予定の保存に失敗しました: ' + err.message;
  }
}

async function markKnownInSentenceQuiz(item) {
  const res = await chrome.runtime.sendMessage({
    action: 'toggleUnknownWord',
    entryId: item.entryId,
    word: item.word,
    unknown: false,
  });
  if (!res || !res.success) {
    const msg = document.getElementById('quiz-msg');
    if (msg) msg.textContent = '未知語の解除に失敗しました: ' + (res?.error || '不明なエラー');
    return;
  }
  const entry = entries.find((e) => e.id === item.entryId);
  if (entry) entry.unknownWords = res.unknownWords;
  sentenceQuizItems = sentenceQuizItems.filter((_, i) => i !== sentenceQuizIndex);
  updateQuizButton();
  render();
  renderSentenceQuizStep();
}

async function sendSentenceToAnki(item, btn) {
  const entry = entries.find((e) => e.id === item.entryId);
  if (!entry) return;
  
  // 生成された例文を使用してAnkiカードを作成
  const modifiedExplanation = {
    ...entry.explanation,
    sentenceTranslation: item.generatedSentence || entry.explanation.sentenceTranslation
  };
  
  btn.disabled = true;
  btn.textContent = '送信中…';
  
  const res = await chrome.runtime.sendMessage({
    action: 'addToAnki',
    card: {
      targetPhrase: item.word,
      contextSentence: item.generatedSentence || entry.contextSentence,
      explanation: modifiedExplanation,
      cardType: 'vocab-cloze',
    },
  });
  
  if (res && res.success) {
    btn.textContent = '✅ 追加済み';
  } else {
    btn.textContent = '📥 この例文をAnkiに追加';
    btn.disabled = false;
    const msg = document.getElementById('quiz-msg');
    if (msg) msg.textContent = 'Anki追加に失敗しました: ' + (res?.error || 'Ankiが起動しているか確認してください');
  }
}

// ==================== 未知語エクスポート ====================
exportUnknownButton.addEventListener('click', async () => {
  const items = collectUnknownItems();
  if (!items.length) return;
  
  if (!confirm(`${items.length}件の未知語をAnkiにエクスポートしますか？\n各未知語の例文が含まれるカードを追加します。`)) return;
  
  exportUnknownButton.disabled = true;
  exportUnknownButton.textContent = 'エクスポート中…';
  
  let successCount = 0;
  let failCount = 0;
  
  for (const item of items) {
    try {
      const entry = entries.find((e) => e.id === item.entryId);
      if (!entry) continue;
      
      const res = await chrome.runtime.sendMessage({
        action: 'addToAnki',
        card: {
          targetPhrase: entry.targetPhrase,
          contextSentence: entry.contextSentence,
          explanation: entry.explanation,
          cardType: 'vocab-cloze',
        },
      });
      
      if (res && res.success) {
        successCount++;
      } else {
        failCount++;
      }
    } catch (err) {
      failCount++;
    }
  }
  
  exportUnknownButton.disabled = false;
  exportUnknownButton.textContent = '📥 未知語をAnkiにエクスポート';
  
  alert(`エクスポート完了:\n成功: ${successCount}件\n失敗: ${failCount}件`);
});
