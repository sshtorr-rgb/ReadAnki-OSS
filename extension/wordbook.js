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

function currentPage() {
  const raw = new URLSearchParams(location.hash.slice(1)).get('page') || '';
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
  if (!books.length) {
    emptyState('まだ単語帳はありません', '記事の英単語を選んで、⋯ の横の「＋単語」を押すと、その記事の単語帳ができます。');
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
    emptyState('この記事の単語帳はまだありません', '記事の英単語を選んで、⋯ の横の「＋単語」を押すと追加されます。');
    return;
  }
  document.getElementById('wb-heading').textContent = book.title || '単語帳';
  document.getElementById('wb-subtitle').textContent = `${book.words.length}語 ・ 最終更新 ${formatDate(book.updatedAt)}`;
  actionsEl.hidden = false;
  const openLink = document.getElementById('wb-open-page');
  openLink.href = book.page;
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
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(item.word);
    u.lang = 'en-US';
    speechSynthesis.speak(u);
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
  if (page ? changes[`wordbook:${page}`] : changes.wordbookIndex) route();
});
route();
