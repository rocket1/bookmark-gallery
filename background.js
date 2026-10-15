// Opens the Bookmark Gallery page when the toolbar button is clicked.
// If it's already open in a tab, just focus that tab instead of opening a duplicate.

// Firefox runs this as an MV2 background script (browser.browserAction);
// Chrome runs it as an MV3 service worker (chrome.action).
if (typeof globalThis.browser === "undefined") globalThis.browser = chrome;
const toolbarButton = browser.action || browser.browserAction;

toolbarButton.onClicked.addListener(async () => {
  const galleryUrl = browser.runtime.getURL("pages/bookmarks.html");

  // Chrome ignores tabs.query's url filter without the "tabs" permission, but
  // runtime.getContexts finds our own pages with no permission at all.
  const existing = browser.runtime.getContexts
    ? (await browser.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [galleryUrl] }))
        .map((c) => ({ id: c.tabId, windowId: c.windowId }))
    : await browser.tabs.query({ url: galleryUrl });

  if (existing.length > 0) {
    const tab = existing[0];
    await browser.tabs.update(tab.id, { active: true });
    await browser.windows.update(tab.windowId, { focused: true });
  } else {
    await browser.tabs.create({ url: galleryUrl });
  }
});
