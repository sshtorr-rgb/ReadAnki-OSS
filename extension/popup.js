function openOptionsPage() {
  try {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
    }
  } catch (e) {
    window.open(chrome.runtime.getURL('options.html'));
  }
}

function openHistoryPage() {
  chrome.tabs.create({ url: chrome.runtime.getURL('history.html') });
}

document.getElementById('open-settings').addEventListener('click', (e) => {
  e.preventDefault();
  openOptionsPage();
});

document.getElementById('open-settings-tab').addEventListener('click', (e) => {
  e.preventDefault();
  openOptionsPage();
});

document.getElementById('open-history').addEventListener('click', (e) => {
  e.preventDefault();
  openHistoryPage();
});


document.getElementById('activate-tab').addEventListener('click', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('activate-msg');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('タブが見つかりません。');
    const res = await chrome.runtime.sendMessage({ action: 'activateTab', tabId: tab.id });
    if (!res?.success) throw new Error(res?.error || '有効化できませんでした。');
    window.close();
  } catch (error) {
    msg.textContent = 'このページでは有効化できません（Chromeの設定ページやウェブストアなど）。';
    console.warn('ReadAnki:', error);
  }
});


// ポップアップを開いた時点で activeTab が付与されるため、このタブのURLだけは読める。
document.getElementById('open-wordbook').addEventListener('click', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('activate-msg');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab?.url || '');
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported');
    chrome.tabs.create({ url: chrome.runtime.getURL(`wordbook.html#page=${encodeURIComponent(url.href)}`) });
    window.close();
  } catch {
    msg.textContent = 'このページの単語帳は開けません（通常のウェブサイトで使ってください）。';
  }
});
