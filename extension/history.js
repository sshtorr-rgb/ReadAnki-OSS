const listEl = document.getElementById('history-list');
const searchEl = document.getElementById('search-input');
const countEl = document.getElementById('history-count');
const clearButton = document.getElementById('clear-history');
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
        <div class="meta"><time>${escapeHtml(formatDate(entry.createdAt))}</time><span class="badge">${escapeHtml(entry.provider || 'LLM')}</span></div></div>
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
});

loadHistory().then((loaded) => { entries = loaded; render(); }).catch((error) => {
  console.error('ReadAnki: failed to load history', error);
  listEl.textContent = '履歴を読み込めませんでした。';
});
