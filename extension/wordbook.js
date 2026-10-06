// 記事ごとの単語帳。データは端末内（chrome.storage.local）だけに置く。
// 意味付け（英英・和訳・例文）は「AIで意味を付ける」を押したときだけ background 経由でLLMに頼む。
const contentEl = document.getElementById('wb-content');
const msgEl = document.getElementById('wb-msg');
const actionsEl = document.getElementById('wb-actions');
const defineButton = document.getElementById('wb-define');
const hideToggle = document.getElementById('wb-hide-meaning');

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(timestamp) {
  return new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp || 0);
}

// 文の中の語を強調する（エスケープしてから mark を付ける）。
function highlight(sentence, word) {
  const escaped = escapeHtml(sentence);
  const w = escapeHtml(String(word || '').trim());
  if (!w) return escaped;
  // 活用形（crystallized など）も語の終わりまで強調する。
  const re = new RegExp(`${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[A-Za-z]*`, 'i');
  return escaped.replace(re, (m) => `<mark>${m}</mark>`);
}

// background.js の wordbookPageKey と同じ規則（ページ内リンクと追跡用パラメータを除く）で記事を特定する。
const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src)$/i;

// 旧版の「未知語★」を移した特別な単語帳（background.js の LEGACY_UNKNOWN_BOOK と同じ）
const LEGACY_UNKNOWN_BOOK = 'readanki:unknown-words';

function currentPage() {
  const raw = new URLSearchParams(location.hash.slice(1)).get('page') || '';
  if (raw === LEGACY_UNKNOWN_BOOK) return raw;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.hash = '';
    [...url.searchParams.keys()].forEach((key) => {
      if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
    });
    return url.toString();
  } catch {
    return '';
  }
}

async function loadIndex() {
  const { wordbookIndex = [] } = await chrome.storage.local.get('wordbookIndex');
  return Array.isArray(wordbookIndex) ? wordbookIndex : [];
}

async function loadBook(page) {
  const key = `wordbook:${page}`;
  return (await chrome.storage.local.get(key))[key] || null;
}

async function saveBook(book) {
  await chrome.storage.local.set({ [`wordbook:${book.page}`]: book });
}

function emptyState(title, text) {
  contentEl.innerHTML = `
    <section class="empty-state">
      <div class="empty-icon">📚</div>
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(text)}</p>
    </section>`;
}

// ---------- 一覧 ----------
async function renderList() {
  document.getElementById('wb-heading').textContent = '記事ごとの単語帳';
  document.getElementById('wb-back').hidden = true;
  actionsEl.hidden = true;
  msgEl.textContent = '';
  const index = await loadIndex();
  const values = index.length ? await chrome.storage.local.get(index.map((page) => `wordbook:${page}`)) : {};
  const books = index.map((page) => values[`wordbook:${page}`]).filter(Boolean);
  setupQuizBar(books);
  if (!books.length) {
    emptyState('まだ単語帳はありません', '記事の英単語を選んで、⋯ の横の「＋単語」（または解説カードの重要語彙の「＋」）を押すと、その記事の単語帳ができます。');
    return;
  }
  contentEl.replaceChildren(...books.map((book) => {
    const defined = book.words.filter((w) => w.ja || w.enDefinition).length;
    const item = document.createElement('article');
    item.className = 'wb-book';
    let host = '';
    try { host = new URL(book.page).hostname; } catch {}
    item.innerHTML = `
      <a href="#page=${encodeURIComponent(book.page)}">
        <h2 class="phrase">${escapeHtml(book.title || book.page)}</h2>
        <div class="meta"><span>${escapeHtml(host)}</span><span class="badge">${book.words.length}語</span>${defined < book.words.length ? `<span>意味なし ${book.words.length - defined}語</span>` : ''}<time>${escapeHtml(formatDate(book.updatedAt))}</time></div>
      </a>
      <button class="delete-history-button" type="button" title="この単語帳を削除" aria-label="この単語帳を削除">🗑️</button>`;
    item.querySelector('button').addEventListener('click', () => deleteBook(book));
    return item;
  }));
}

async function deleteBook(book) {
  if (!confirm(`「${book.title || book.page}」の単語帳（${book.words.length}語）を削除しますか？`)) return;
  const index = await loadIndex();
  await chrome.storage.local.remove(`wordbook:${book.page}`);
  await chrome.storage.local.set({ wordbookIndex: index.filter((page) => page !== book.page) });
  if (currentPage()) location.hash = '';
  else renderList();
}

// ---------- 記事ごとの単語帳 ----------
async function renderBook(page) {
  document.getElementById('wb-back').hidden = false;
  const book = await loadBook(page);
  if (!book) {
    document.getElementById('wb-heading').textContent = '単語帳';
    actionsEl.hidden = true;
    setupQuizBar([]);
    emptyState('この記事の単語帳はまだありません', '記事の英単語を選んで、⋯ の横の「＋単語」を押すと追加されます。');
    return;
  }
  document.getElementById('wb-heading').textContent = book.title || '単語帳';
  document.getElementById('wb-subtitle').textContent = `${book.words.length}語 ・ 最終更新 ${formatDate(book.updatedAt)}`;
  actionsEl.hidden = false;
  const openLink = document.getElementById('wb-open-page');
  openLink.hidden = book.page === LEGACY_UNKNOWN_BOOK;
  if (!openLink.hidden) openLink.href = book.page;
  setupQuizBar([book]);
  const notSent = book.words.filter((w) => !w.ankiAdded).length;
  const ankiButton = document.getElementById('wb-anki');
  ankiButton.textContent = notSent ? `📥 Ankiに送る（${notSent}語）` : '📥 Ankiに送信済み';
  ankiButton.disabled = !notSent;
  ankiButton.onclick = () => sendBookToAnki(book);
  const pending = book.words.filter((w) => !w.ja && !w.enDefinition).length;
  defineButton.textContent = pending ? `✨ AIで意味を付ける（${pending}語）` : '✨ AIで意味を付け直す';
  defineButton.onclick = () => defineWords(book, pending > 0);
  document.getElementById('wb-delete-book').onclick = () => deleteBook(book);
  contentEl.classList.toggle('is-hidden-meaning', hideToggle.checked);
  contentEl.replaceChildren(...book.words.map((item, i) => renderWord(book, item, i)));
}

function renderWord(book, item, i) {
  const el = document.createElement('article');
  el.className = 'wb-word';
  const hasMeaning = item.ja || item.enDefinition;
  el.innerHTML = `
    <div class="wb-word-head">
      <h2>${escapeHtml(item.word)}</h2>
      ${item.ja ? `<span class="wb-ja wb-meaning">${escapeHtml(item.ja)}</span>` : ''}
      <span class="wb-tools">
        <button class="wb-icon wb-tts" type="button" title="発音を聞く">🔊</button>
        <button class="wb-icon wb-del" type="button" title="この語を削除">🗑️</button>
      </span>
    </div>
    ${hasMeaning ? `
      ${item.enDefinition ? `<div class="wb-field"><span class="detail-label">英英</span><span class="wb-meaning">${escapeHtml(item.enDefinition)}</span></div>` : ''}
      ${item.example ? `<div class="wb-field"><span class="detail-label">例文</span><span>${highlight(item.example, item.word)}</span></div>` : ''}
    ` : '<div class="wb-field wb-pending">まだ意味が付いていません（「AIで意味を付ける」で作成）</div>'}
    ${item.context ? `<div class="wb-context">${highlight(item.context, item.word)}</div>` : ''}`;
  el.querySelectorAll('.wb-meaning').forEach((m) => m.addEventListener('click', () => m.classList.toggle('is-shown')));
  el.querySelector('.wb-tts').addEventListener('click', () => {
    // 設定画面で選んだ声・方式で読む（外部TTSが失敗したらブラウザ音声で読む）。
    const msg = document.getElementById('wb-msg');
    window.ReadAnkiTTS?.speak(item.word, {
      onFallback: (error) => { msg.textContent = `外部の読み上げに失敗したため、ブラウザの音声で読み上げました: ${error.message}`; },
    }).catch((error) => { msg.textContent = `読み上げできませんでした: ${error.message}`; });
  });
  el.querySelector('.wb-del').addEventListener('click', async () => {
    const latest = await loadBook(book.page);
    if (!latest) return;
    latest.words = latest.words.filter((w) => w.word !== item.word);
    latest.updatedAt = Date.now();
    await saveBook(latest);
    renderBook(book.page);
  });
  return el;
}

async function defineWords(book, onlyPending) {
  const targets = book.words.filter((w) => !onlyPending || (!w.ja && !w.enDefinition));
  if (!targets.length) return;
  defineButton.disabled = true;
  msgEl.textContent = `AIで意味を作成中…（${targets.length}語。送るのは各語と、その語を含む1文だけです）`;
  try {
    for (let i = 0; i < targets.length; i += 30) {
      const chunk = targets.slice(i, i + 30);
      const res = await chrome.runtime.sendMessage({
        action: 'defineWordbookWords',
        words: chunk.map((w) => ({ word: w.word, context: w.context })),
      });
      if (!res?.success) throw new Error(res?.error || '不明なエラー');
      // 作成中に語が追加・削除されても消さないよう、最新の単語帳に結果だけを書き込む。
      const latest = await loadBook(book.page);
      if (!latest) return;
      res.words.forEach((def) => {
        const target = latest.words.find((w) => w.word === def.word);
        if (target) Object.assign(target, { enDefinition: def.enDefinition, ja: def.ja, example: def.example });
      });
      latest.updatedAt = Date.now();
      await saveBook(latest);
    }
    msgEl.textContent = '✅ 意味を付けました。';
  } catch (error) {
    msgEl.textContent = '意味を作成できませんでした: ' + error.message;
  } finally {
    defineButton.disabled = false;
    renderBook(book.page);
  }
}

// ---------- 単語テスト ----------
// 「＋単語」で集めた語を、文の中で意味を思い出す形で出題する。答えた結果で次に出す時期を決め、単語ごとに保存する。
const quizOverlay = document.getElementById('quiz-overlay');
const quizProgressEl = document.getElementById('quiz-progress');
const quizBodyEl = document.getElementById('quiz-body');
const quizModeEl = document.getElementById('wb-quiz-mode');
const REVIEW_STEPS = [
  ['quiz-btn-forgot', '忘れた', '3分後', 3 * 60 * 1000],
  ['quiz-btn-difficult', '難しい', '10分後', 10 * 60 * 1000],
  ['quiz-btn-easy', '簡単', '3時間後', 3 * 60 * 60 * 1000],
  ['quiz-btn-remembered', '覚えた', '6日後', 6 * 24 * 60 * 60 * 1000],
];
let quizBooks = [];
let quizItems = [];
let quizIndex = 0;

function dueItems(books) {
  const now = Date.now();
  return books
    .flatMap((book) => book.words.map((w) => ({ ...w, page: book.page })))
    .filter((w) => !w.reviewAt || w.reviewAt <= now)
    .sort((a, b) => (a.reviewAt || 0) - (b.reviewAt || 0) || (a.addedAt || 0) - (b.addedAt || 0));
}

function setupQuizBar(books) {
  quizBooks = books;
  const bar = document.getElementById('wb-test-bar');
  const total = books.reduce((n, b) => n + b.words.length, 0);
  bar.hidden = total === 0;
  if (!total) return;
  const due = dueItems(books).length;
  const button = document.getElementById('wb-quiz-open');
  button.textContent = `🧠 単語テスト（${books.length > 1 || !currentPage() ? '全単語帳' : 'この記事'}・${due}語）`;
  button.disabled = due === 0;
  document.getElementById('wb-quiz-note').textContent = due === total ? '' : `ほかの${total - due}語は、まだ復習の時期ではありません。`;
}

function quizSentence(item) {
  if (quizModeEl.value === 'example' && item.example) return item.example;
  return item.context || item.example || '';
}

function openQuiz() {
  let items = dueItems(quizBooks);
  if (quizModeEl.value === 'example') items = items.filter((w) => w.example);
  if (!items.length) {
    msgEl.textContent = quizModeEl.value === 'example'
      ? 'AIの例文がある語がありません。先に「✨ AIで意味を付ける」を押してください。'
      : '今テストできる語はありません。';
    return;
  }
  quizItems = items;
  quizIndex = 0;
  quizOverlay.style.display = 'flex';
  renderQuizStep();
}

function closeQuiz() {
  quizOverlay.style.display = 'none';
  route();
}

function renderQuizStep() {
  if (quizIndex >= quizItems.length) {
    quizProgressEl.textContent = '完了';
    quizBodyEl.innerHTML = `
      <div class="quiz-summary">
        <p>${quizItems.length}語のテストが終わりました。</p>
        <button class="quiz-primary-btn" id="quiz-finish" type="button">閉じる</button>
      </div>`;
    document.getElementById('quiz-finish').addEventListener('click', closeQuiz);
    return;
  }
  const item = quizItems[quizIndex];
  quizProgressEl.textContent = `${quizIndex + 1} / ${quizItems.length}`;
  const sentence = quizSentence(item);
  quizBodyEl.innerHTML = `
    <div class="quiz-sentence">${sentence ? highlight(sentence, item.word) : `<mark>${escapeHtml(item.word)}</mark>`}</div>
    <p class="quiz-msg">印の語の意味を思い出してから、答えを見てください。</p>
    <button class="quiz-reveal-btn" id="quiz-reveal" type="button">答えを見る</button>`;
  document.getElementById('quiz-reveal').addEventListener('click', () => showAnswer(item));
}

function showAnswer(item) {
  const sentence = quizSentence(item);
  const other = quizModeEl.value === 'example' ? item.context : item.example;
  quizBodyEl.innerHTML = `
    <div class="quiz-sentence">${sentence ? highlight(sentence, item.word) : ''}</div>
    <div class="quiz-answer">
      <div class="quiz-answer-word">${escapeHtml(item.word)} <button class="wb-icon" id="quiz-tts" type="button" title="発音を聞く">🔊</button></div>
      <div class="quiz-answer-meaning">${escapeHtml(item.ja || '（まだ意味が付いていません。単語帳の「AIで意味を付ける」で作れます）')}</div>
      ${item.enDefinition ? `<div class="quiz-answer-pos">${escapeHtml(item.enDefinition)}</div>` : ''}
      ${other ? `<div class="quiz-answer-pos">${quizModeEl.value === 'example' ? '記事の文' : '例文'}: ${highlight(other, item.word)}</div>` : ''}
    </div>
    <div class="quiz-actions">
      ${REVIEW_STEPS.map(([cls, label, when], i) => `<button class="${cls}" data-step="${i}" type="button">${label}（${when}）</button>`).join('')}
    </div>
    <div class="quiz-msg" id="quiz-msg"></div>`;
  document.getElementById('quiz-tts').addEventListener('click', () => window.ReadAnkiTTS?.speak(item.word));
  quizBodyEl.querySelectorAll('[data-step]').forEach((button) => {
    button.addEventListener('click', () => scheduleReview(item, REVIEW_STEPS[Number(button.dataset.step)][3]));
  });
}

async function scheduleReview(item, delayMs) {
  try {
    const latest = await loadBook(item.page);
    const target = latest?.words.find((w) => w.word === item.word);
    if (target) {
      target.reviewAt = Date.now() + delayMs;
      await saveBook(latest);
    }
    quizIndex += 1;
    renderQuizStep();
  } catch (error) {
    const msg = document.getElementById('quiz-msg');
    if (msg) msg.textContent = '復習の予定を保存できませんでした: ' + error.message;
  }
}

document.getElementById('wb-quiz-open').addEventListener('click', openQuiz);
document.getElementById('quiz-close').addEventListener('click', closeQuiz);
quizOverlay.addEventListener('click', (event) => { if (event.target === quizOverlay) closeQuiz(); });

// ---------- Ankiに送る ----------
// 単語を記事の文（なければAIの例文）の中で穴埋めにし、和訳を表面のヒントにした語彙Clozeカードにする。
async function sendBookToAnki(book) {
  const targets = book.words.filter((w) => !w.ankiAdded);
  if (!targets.length) return;
  if (!confirm(`${targets.length}語を、語彙ClozeカードとしてAnkiに送りますか？`)) return;
  const button = document.getElementById('wb-anki');
  button.disabled = true;
  let ok = 0;
  const failures = [];
  for (const item of targets) {
    button.textContent = `送信中…（${ok + failures.length + 1}/${targets.length}）`;
    const meaning = [item.ja, item.enDefinition].filter(Boolean).join(' / ');
    const res = await chrome.runtime.sendMessage({
      action: 'addToAnki',
      card: {
        targetPhrase: item.word,
        contextSentence: item.context || item.example || item.word,
        explanation: { targetTranslation: item.ja || '', keyVocabulary: meaning ? [{ word: item.word, meaning }] : [] },
        cardType: 'vocab-cloze',
        clozeHint: item.ja || '',
      },
    }).catch((error) => ({ success: false, error: error.message }));
    if (res?.success) {
      ok += 1;
      const latest = await loadBook(book.page);
      const target = latest?.words.find((w) => w.word === item.word);
      if (target) {
        target.ankiAdded = true;
        await saveBook(latest);
      }
    } else {
      failures.push(`${item.word}: ${res?.error || '不明なエラー'}`);
    }
  }
  msgEl.textContent = `Ankiに${ok}語を送りました。` + (failures.length ? ` 送れなかった語: ${failures.join(' ／ ')}` : '');
  renderBook(book.page);
}

hideToggle.addEventListener('change', () => contentEl.classList.toggle('is-hidden-meaning', hideToggle.checked));

function route() {
  const page = currentPage();
  if (page) renderBook(page);
  else renderList();
}

window.addEventListener('hashchange', route);
// 別のタブで単語が追加されたら表示を更新する。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const page = currentPage();
  if (quizOverlay.style.display === 'flex') return;
  if (page ? changes[`wordbook:${page}`] : changes.wordbookIndex) route();
});
route();
