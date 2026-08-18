const BADGE = { color: '#111111', textColor: '#d6ff3f' };

async function setBadge(tabId, active, failed) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: failed ? '#ff5c7a' : BADGE.color });
    if (chrome.action.setBadgeTextColor) {
      await chrome.action.setBadgeTextColor({ tabId, color: failed ? '#ffffff' : BADGE.textColor });
    }
    await chrome.action.setBadgeText({ tabId, text: failed ? '!' : active ? 'ON' : '' });
  } catch {
    // tab or action can disappear during reload
  }
}

async function toggleInspector(tab) {
  if (!tab?.id) return;
  if (!tab.url || !/^https?:|^file:|^about:blank/.test(tab.url)) {
    setBadge(tab.id, false, true);
    return;
  }

  const ping = async () => chrome.tabs.sendMessage(tab.id, { type: 'OGFONTS_TOGGLE' });

  try {
    await ping();
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['vendor/cuelume.js', 'content.js'],
      });
      await ping();
    } catch (err) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['vendor/cuelume.js', 'content.js'],
        });
        await ping();
      } catch (inner) {
        console.warn('OGFonts Inspector: cannot run on this page.', inner || err);
        setBadge(tab.id, false, true);
      }
    }
  }
}

chrome.action.onClicked.addListener(toggleInspector);

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'OGFONTS_STATE' && sender.tab?.id) {
    setBadge(sender.tab.id, !!message.active, false).catch(() => {});
  }
  if (message?.type === 'OGFONTS_FROM_FRAME' && sender.tab?.id) {
    chrome.tabs.sendMessage(sender.tab.id, {
      type: 'OGFONTS_FRAME_DATA',
      snapshot: message.snapshot,
    }).catch(() => {});
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'OGFONTS_PING' });
    setBadge(tabId, !!res?.active, false);
  } catch {
    setBadge(tabId, false, false);
  }
});
