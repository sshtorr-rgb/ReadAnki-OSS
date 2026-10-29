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
  backupEl.hidden = false;
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
  backupEl.hidden = true;
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
const FX = window.ReadAnkiFX;
FX?.mountHud(document.querySelector('.quiz-header'));
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
  setupComposeButton();
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
  FX?.startSession('word');
  quizOverlay.style.display = 'flex';
  renderQuizStep();
}

function closeQuiz() {
  quizOverlay.style.display = 'none';
  composeActive = false;
  route();
}

function renderQuizStep() {
  if (quizIndex >= quizItems.length) {
    quizProgressEl.textContent = '完了';
    if (FX) {
      FX.result(quizBodyEl, { title: 'WORD TEST COMPLETE', rows: [['答えた語', `${quizItems.length}語`]], xpGained: FX.session?.xp || 0, bestKey: 'word' });
      quizBodyEl.insertAdjacentHTML('beforeend', '<div class="quiz-summary"><button class="quiz-primary-btn" id="quiz-finish" type="button">閉じる</button></div>');
    } else {
      quizBodyEl.innerHTML = `
        <div class="quiz-summary">
          <p>${quizItems.length}語のテストが終わりました。</p>
          <button class="quiz-primary-btn" id="quiz-finish" type="button">閉じる</button>
        </div>`;
    }
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
    button.addEventListener('click', () => scheduleReview(item, REVIEW_STEPS[Number(button.dataset.step)][3], button));
  });
}

async function scheduleReview(item, delayMs, button) {
  try {
    const latest = await loadBook(item.page);
    const target = latest?.words.find((w) => w.word === item.word);
    if (target) {
      target.reviewAt = Date.now() + delayMs;
      await saveBook(latest);
    }
    // 「簡単」「覚えた」だけがコンボと経験値の演出になる。「忘れた」「難しい」はコンボが切れてダウングレード。
    const card = quizOverlay.querySelector('.quiz-card');
    if (delayMs >= REVIEW_STEPS[2][3]) FX?.award(10, button, card);
    else FX?.downgrade(2, button, card);
    quizIndex += 1;
    renderQuizStep();
  } catch (error) {
    const msg = document.getElementById('quiz-msg');
    if (msg) msg.textContent = '復習の予定を保存できませんでした: ' + error.message;
  }
}

document.getElementById('wb-quiz-open').addEventListener('click', openQuiz);
document.getElementById('quiz-close').addEventListener('click', closeQuiz);
// 作文テスト中は、書いた英文や編集中のカードが消えないよう、外側を押しても閉じない
quizOverlay.addEventListener('click', (event) => { if (event.target === quizOverlay && !composeActive) closeQuiz(); });

// ---------- 作文テスト ----------
// 単語帳の語をいくつかずつ1文に詰め込んだ和文英訳の問題をAIに作ってもらい、和訳を見て英文を書く。
// 未知語以外の部分には入試レベルの慣用表現が入り、答え合わせで解説を表示する。最後にAnkiへ送れる（確認・編集してから）。
const COMPOSE_MAX_WORDS = 30;
const composeButton = document.getElementById('wb-compose-open');
const composePerEl = document.getElementById('wb-compose-per');
let composeItems = [];
let composeIndex = 0;
let composeActive = false;

function composeWords() {
  const due = dueItems(quizBooks);
  const dueKeys = new Set(due.map((w) => `${w.page}\n${w.word}`));
  const rest = quizBooks.flatMap((book) => book.words.map((w) => ({ ...w, page: book.page })))
    .filter((w) => !dueKeys.has(`${w.page}\n${w.word}`));
  return [...due, ...rest].slice(0, COMPOSE_MAX_WORDS);
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 英文の中の未知語（mark）と慣用表現（下線）を強調する。エスケープしてから印を付ける。
function composeHighlight(en, item) {
  let html = escapeHtml(en);
  item.idioms.forEach((idiom) => {
    const text = escapeHtml(idiom.expression);
    if (text) html = html.replace(new RegExp(regexEscape(text), 'i'), (m) => `<span class="compose-idiom">${m}</span>`);
  });
  item.targets.forEach((t) => {
    const text = escapeHtml(t.used || t.word);
    if (!text) return;
    html = html.replace(new RegExp(`(^|[^A-Za-z>])(${regexEscape(text)}[A-Za-z]*)`, 'i'), (m, pre, w) => `${pre}<mark>${w}</mark>`);
  });
  return html;
}

// 自分の英文にその語が入っているか（語の先頭が一致すればよい。熟語は主な語がそれぞれ入っていればよい）
function usesWord(text, word) {
  const parts = String(word || '').toLowerCase().split(/\s+/).map((p) => p.replace(/[^a-z'-]/g, '')).filter((p) => p.length > 2);
  const lower = ` ${String(text || '').toLowerCase()}`;
  const has = (w) => new RegExp(`[^a-z]${regexEscape(w.length > 4 ? w.slice(0, Math.max(4, w.length - 2)) : w)}`).test(lower);
  return parts.length ? parts.every(has) : has(String(word || '').toLowerCase());
}

function setupComposeButton() {
  const total = quizBooks.reduce((n, b) => n + b.words.length, 0);
  composeButton.disabled = total < 2;
  composeButton.title = total < 2
    ? '作文テストには2語以上必要です。'
    : '単語帳の語をいくつかずつ1文に詰め込んだ和文英訳の問題をAIが作ります';
}

async function openCompose() {
  const words = composeWords();
  if (words.length < 2) return;
  const per = Number(composePerEl.value) || 5;
  composeButton.disabled = true;
  msgEl.textContent = `作文テストを作成中…（${words.length}語・1文に${per}語。送るのは単語と意味だけで、記事の文・URL・タイトルは送りません）`;
  try {
    const res = await chrome.runtime.sendMessage({
      action: 'composeWordbookQuiz',
      perSentence: per,
      words: words.map((w) => ({ word: w.word, ja: w.ja || '' })),
    });
    if (!res?.success) throw new Error(res?.error || '不明なエラー');
    const byWord = new Map(words.map((w) => [w.word.toLowerCase(), w]));
    composeItems = res.items.map((item) => {
      const first = byWord.get(String(item.targets[0]?.word || '').toLowerCase());
      const book = quizBooks.find((b) => b.page === first?.page);
      return { ...item, answer: '', page: first?.page || '', title: book?.title || '', send: true, sent: false };
    });
    composeIndex = 0;
    composeActive = true;
    composeResultShown = false;
    FX?.startSession('compose');
    msgEl.textContent = '';
    quizOverlay.style.display = 'flex';
    renderComposeStep();
  } catch (error) {
    msgEl.textContent = '作文テストを作れませんでした: ' + error.message;
  } finally {
    setupComposeButton();
  }
}

function renderComposeStep() {
  if (composeIndex >= composeItems.length) return renderComposeEdit();
  const item = composeItems[composeIndex];
  quizProgressEl.textContent = `作文テスト ${composeIndex + 1} / ${composeItems.length}`;
  quizBodyEl.innerHTML = `
    <div class="compose-ja">${escapeHtml(item.ja)}</div>
    <div class="compose-label">使う語句</div>
    <div class="compose-hints">${item.targets.map((t) => `<span class="compose-hint">${escapeHtml(t.word)}</span>`).join('')}</div>
    <label class="compose-label" for="compose-input">英文を書いてください</label>
    <textarea class="compose-input" id="compose-input" spellcheck="false" placeholder="ここに英文を書く"></textarea>
    <div class="compose-row">
      <button class="quiz-primary-btn" id="compose-check" type="button">答え合わせ</button>
      <button class="quiz-reveal-btn" id="compose-skip" type="button">わからない（答えを見る）</button>
    </div>`;
  const input = document.getElementById('compose-input');
  input.value = item.answer;
  input.focus();
  const check = () => { item.answer = input.value.trim(); renderComposeAnswer(item); };
  document.getElementById('compose-check').addEventListener('click', check);
  document.getElementById('compose-skip').addEventListener('click', check);
}

// 作文の格付け: 単語帳の語を全部使えて、慣用表現も使えたら S。全部使えたら A。6割以上で B。それ未満は C。
function composeScore(item) {
  if (!item.answer) return { rank: '', xp: 3, used: 0, idiom: false };
  const used = item.targets.filter((t) => usesWord(item.answer, t.used || t.word)).length;
  const idiom = item.idioms.some((i) => i.expression && usesWord(item.answer, i.expression));
  const ratio = item.targets.length ? used / item.targets.length : 0;
  const rank = ratio === 1 ? (idiom ? 'S' : 'A') : ratio >= 0.6 ? 'B' : 'C';
  return { rank, used, idiom, perfect: ratio === 1, xp: 10 + used * 8 + (idiom ? 15 : 0) + (ratio === 1 ? 30 : 0) };
}

function renderComposeAnswer(item) {
  const missing = item.targets.filter((t) => t.missing).map((t) => t.word);
  const score = composeScore(item);
  quizBodyEl.innerHTML = `
    <div class="fx-stamp-slot" id="compose-stamp"></div>
    ${score.perfect ? `<div class="fx-perfect">PERFECT — 全語制覇${score.idiom ? '＋慣用表現' : ''}</div>` : ''}
    <div class="compose-ja">${escapeHtml(item.ja)}</div>
    <div class="compose-label">使う語句（緑: あなたの英文に入っている／赤: 入っていない）</div>
    <div class="compose-hints">${item.targets.map((t) => {
      const used = item.answer && usesWord(item.answer, t.used || t.word);
      return `<span class="compose-hint ${item.answer ? (used ? 'is-used' : 'is-unused') : ''}">${escapeHtml(t.word)}${t.ja ? ` = ${escapeHtml(t.ja)}` : ''}</span>`;
    }).join('')}</div>
    <div class="compose-label">あなたの英文</div>
    <div class="compose-mine">${item.answer ? escapeHtml(item.answer) : '（未回答）'}</div>
    <div class="compose-label">模範解答 <button class="wb-icon" id="compose-tts" type="button" title="発音を聞く">🔊</button></div>
    <div class="compose-en">${composeHighlight(item.en, item)}</div>
    ${missing.length ? `<div class="compose-warn">※ 模範解答に入っていない語句があります: ${escapeHtml(missing.join(' / '))}</div>` : ''}
    ${item.idioms.length ? `
      <div class="compose-label">慣用表現（下線）</div>
      <ul class="compose-idioms">${item.idioms.map((idiom) => `
        <li><b>${escapeHtml(idiom.pattern || idiom.expression)}</b>${idiom.meaning ? `：${escapeHtml(idiom.meaning)}` : ''}${idiom.explanation ? `<br>${escapeHtml(idiom.explanation)}` : ''}</li>`).join('')}
      </ul>` : ''}
    <div class="compose-row">
      <button class="quiz-primary-btn" id="compose-next" type="button">${composeIndex + 1 < composeItems.length ? '次の問題へ' : FX ? '結果を見る' : 'Ankiに送る内容を確認する'}</button>
    </div>`;
  document.getElementById('compose-tts').addEventListener('click', () => window.ReadAnkiTTS?.speak(item.en));
  document.getElementById('compose-next').addEventListener('click', () => {
    composeIndex += 1;
    if (composeIndex >= composeItems.length && FX && !composeResultShown) renderComposeResult();
    else renderComposeStep();
  });
  if (FX && !item.scored) {
    item.scored = true;
    item.rank = score.rank;
    const card = quizOverlay.querySelector('.quiz-card');
    if (score.rank) FX.stamp(document.getElementById('compose-stamp'), score.rank, card);
    // S / A / B はコンボが続き、C と未回答はダウングレード
    const anchor = quizBodyEl.querySelector('.compose-en') || card;
    setTimeout(() => {
      if (['S', 'A', 'B'].includes(score.rank)) FX.award(score.xp, anchor, card, score.perfect ? { label: 'PERFECT' } : {});
      else FX.downgrade(score.xp, anchor, card);
    }, score.rank ? 420 : 0);
  }
}

let composeResultShown = false;

function renderComposeResult() {
  composeResultShown = true;
  quizProgressEl.textContent = '作文テスト 結果';
  const ranks = composeItems.map((item) => item.rank).filter(Boolean);
  const count = (r) => ranks.filter((x) => x === r).length;
  FX.result(quizBodyEl, {
    title: 'COMPOSITION COMPLETE',
    rows: [['問題', `${composeItems.length}問`], ['S / A', `${count('S')} / ${count('A')}`], ['B / C', `${count('B')} / ${count('C')}`]],
    xpGained: FX.session?.xp || 0,
    bestKey: 'compose',
  });
  quizBodyEl.insertAdjacentHTML('beforeend', '<div class="quiz-summary"><button class="quiz-primary-btn" id="compose-to-edit" type="button">Ankiに送る内容を確認する</button></div>');
  document.getElementById('compose-to-edit').addEventListener('click', renderComposeStep);
}

// Ankiの日英カード（表: 問題の和文、裏: 模範解答の英文、解説: 使う語句と慣用表現）の初期値
function composeCardText(item) {
  if (item.card) return item.card;
  const words = item.targets.map((t) => `${t.word}${t.ja ? `（${t.ja}）` : ''}`).join(' / ');
  const idioms = item.idioms.map((idiom) => `■ ${idiom.pattern || idiom.expression}${idiom.meaning ? `：${idiom.meaning}` : ''}${idiom.explanation ? `\n${idiom.explanation}` : ''}`).join('\n');
  item.card = {
    front: `${item.ja}\n使う語句: ${item.targets.map((t) => t.word).join(' / ')}`,
    back: item.en,
    extra: [`使う語句: ${words}`, idioms ? `慣用表現:\n${idioms}` : ''].filter(Boolean).join('\n\n'),
  };
  return item.card;
}

const textToHtml = (text) => escapeHtml(String(text || '').trim()).replace(/\n/g, '<br>');

function renderComposeEdit() {
  quizProgressEl.textContent = 'Ankiに送る内容の確認';
  quizBodyEl.innerHTML = `
    <p class="quiz-msg" style="margin-top:0">日英カード（設定の「Japanese-English」のデッキ・ノートタイプ）として送ります。内容は自由に直せます。送らない問題はチェックを外してください。入力型のノートタイプ（例: 基本 (文字入力解答)）では解説が入らないため、解説も入れたい場合は設定画面の「解説付きの専用ノートタイプを作成して使う」を使ってください。</p>
    <div id="compose-edits"></div>
    <div class="compose-row">
      <button class="quiz-primary-btn" id="compose-send" type="button"></button>
      <button class="quiz-reveal-btn" id="compose-close" type="button">送らずに閉じる</button>
    </div>
    <div class="quiz-msg" id="compose-msg"></div>`;
  const list = document.getElementById('compose-edits');
  const sendButton = document.getElementById('compose-send');
  const refreshSend = () => {
    const n = composeItems.filter((item) => item.send && !item.sent).length;
    sendButton.textContent = n ? `選んだ${n}問をAnkiに送る` : '送る問題がありません';
    sendButton.disabled = !n;
  };
  composeItems.forEach((item, i) => {
    const card = composeCardText(item);
    const box = document.createElement('section');
    box.className = `compose-edit${item.send ? '' : ' is-off'}`;
    box.innerHTML = `
      <div class="compose-edit-head">
        <label><input type="checkbox" ${item.send ? 'checked' : ''} ${item.sent ? 'disabled' : ''}> 問題 ${i + 1}</label>
        <span class="compose-edit-status">${item.sent ? '✅ 送信済み' : ''}</span>
      </div>
      <label class="compose-label">表面（問題）</label><textarea data-key="front"></textarea>
      <label class="compose-label">裏面（英文・正解）</label><textarea data-key="back"></textarea>
      <label class="compose-label">解説</label><textarea data-key="extra" style="min-height: 90px"></textarea>`;
    box.querySelectorAll('textarea').forEach((area) => {
      area.value = card[area.dataset.key];
      area.disabled = item.sent;
      area.addEventListener('input', () => { card[area.dataset.key] = area.value; });
    });
    box.querySelector('input').addEventListener('change', (event) => {
      item.send = event.target.checked;
      box.classList.toggle('is-off', !item.send);
      refreshSend();
    });
    item.statusEl = box.querySelector('.compose-edit-status');
    list.appendChild(box);
  });
  refreshSend();
  sendButton.addEventListener('click', () => sendComposeToAnki(sendButton, refreshSend));
  document.getElementById('compose-close').addEventListener('click', closeQuiz);
}

async function sendComposeToAnki(button, refreshSend) {
  const targets = composeItems.filter((item) => item.send && !item.sent);
  const msg = document.getElementById('compose-msg');
  button.disabled = true;
  const failures = [];
  for (const item of targets) {
    const card = composeCardText(item);
    if (!card.front.trim() || !card.back.trim()) {
      failures.push(`問題${composeItems.indexOf(item) + 1}: 表面と裏面は空にできません`);
      continue;
    }
    item.statusEl.textContent = '送信中…';
    const res = await chrome.runtime.sendMessage({
      action: 'addToAnki',
      articlePage: item.page,
      card: {
        cardType: 'ja-en',
        targetPhrase: item.targets.map((t) => t.word).join(' / '),
        contextSentence: card.back.trim(),
        articleTitle: item.title,
        fields: { Front: textToHtml(card.front), Back: escapeHtml(card.back.trim()), Extra: textToHtml(card.extra) },
      },
    }).catch((error) => ({ success: false, error: error.message }));
    if (res?.success) {
      item.sent = true;
      item.statusEl.textContent = '✅ 送信済み';
    } else {
      item.statusEl.textContent = '送れませんでした';
      failures.push(`問題${composeItems.indexOf(item) + 1}: ${res?.error || '不明なエラー'}`);
    }
  }
  const ok = targets.filter((item) => item.sent).length;
  msg.textContent = `Ankiに${ok}問を送りました。` + (failures.length ? ` ${failures.join(' ／ ')}` : '');
  if (ok) renderComposeEdit();
  else refreshSend();
  const after = document.getElementById('compose-msg');
  if (after) after.textContent = msg.textContent;
}

composeButton.addEventListener('click', openCompose);

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
      articlePage: book.page,
      card: {
        articleTitle: book.title || '',
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

// ---------- バックアップ（書き出し・読み込み） ----------
// 単語帳（復習の予定を含む）・解析履歴・テストの記録を JSON ファイルにする。APIキーや設定は含めない。
const backupEl = document.getElementById('wb-backup');
const importFileEl = document.getElementById('wb-import-file');
const MAX_IMPORT_BYTES = 30 * 1024 * 1024;

document.getElementById('wb-export').addEventListener('click', async () => {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'exportUserData' });
    if (!res?.success) throw new Error(res?.error || '不明なエラー');
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const url = URL.createObjectURL(new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `readanki-backup-${stamp}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    const words = res.data.wordbooks.reduce((n, b) => n + (b.words?.length || 0), 0);
    msgEl.textContent = `📤 書き出しました（単語帳 ${res.data.wordbooks.length}記事・${words}語、解析履歴 ${res.data.history.length}件、テストの記録）。APIキーや設定は含まれていません。`;
  } catch (error) {
    msgEl.textContent = '書き出せませんでした: ' + error.message;
  }
});

document.getElementById('wb-import').addEventListener('click', () => importFileEl.click());

importFileEl.addEventListener('change', async () => {
  const file = importFileEl.files?.[0];
  importFileEl.value = '';
  if (!file) return;
  const mode = document.getElementById('wb-import-mode').value;
  try {
    if (file.size > MAX_IMPORT_BYTES) throw new Error('ファイルが大きすぎます（30MBまで）。');
    let data;
    try { data = JSON.parse(await file.text()); } catch { throw new Error('JSONとして読めないファイルです。'); }
    if (data?.format !== 'readanki-backup') throw new Error('ReadAnkiのバックアップファイルではありません。');
    const books = Array.isArray(data.wordbooks) ? data.wordbooks.length : 0;
    const history = Array.isArray(data.history) ? data.history.length : 0;
    const question = mode === 'replace'
      ? `今の単語帳・解析履歴・テストの記録をすべて消して、このファイル（単語帳 ${books}記事、解析履歴 ${history}件）に置き換えます。元に戻せません。よろしいですか？`
      : `このファイル（単語帳 ${books}記事、解析履歴 ${history}件）を今のデータに追加します。同じ記事の同じ語、同じ履歴は今のものを残します。よろしいですか？`;
    if (!confirm(question)) return;
    const res = await chrome.runtime.sendMessage({ action: 'importUserData', data, mode });
    if (!res?.success) throw new Error(res?.error || '不明なエラー');
    msgEl.textContent = `📥 読み込みました: 単語帳に${res.addedBooks}記事・${res.addedWords}語、解析履歴に${res.addedHistory}件を追加（合計 ${res.totalBooks}記事・履歴${res.totalHistory}件）。`
      + (res.skippedBooks ? ` 単語帳の上限のため${res.skippedBooks}記事は読み込めませんでした。` : '');
    route();
  } catch (error) {
    msgEl.textContent = '読み込めませんでした: ' + error.message;
  }
});

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
