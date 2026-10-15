"use strict";

// Chrome (MV3) has the same promise-based API under `chrome`.
if (typeof globalThis.browser === "undefined") globalThis.browser = chrome;
// Only Firefox has bookmark separators (and getBrowserInfo).
const SUPPORTS_SEPARATORS = typeof browser.runtime.getBrowserInfo === "function";

/* ============================================================
   Constants
   ============================================================ */

const ROW_HEIGHT = 104;      // bookmark rows; must match --row-height in CSS
const HEADER_HEIGHT = 52;    // domain/folder header rows; must match --header-height in CSS
const FOLDER_INDENT_PX = 22; // per nesting level in the Folders view
const BUFFER_ROWS = 6;       // extra rows rendered above/below viewport
const MAX_CONCURRENT_FETCHES = 4;
const FETCH_TIMEOUT_MS = 8000;
const CACHE_PREFIX = "bmgallery::og::";
const PREFS_KEY = "bmgallery::prefs";
const TRASH_KEY = "bmgallery::trash";
// The built-in root folders have different ids per browser (Firefox
// "unfiled_____", Chrome "2", …); detectRootFolders() fills these in from the
// tree before anything uses them.
let ROOT_FOLDER_ID = "root________";
let OTHER_BOOKMARKS_ID = "unfiled_____"; // "Other Bookmarks" — restore fallback, Smart Cleanup's home
let TOOLBAR_ID = "toolbar_____";
let BUILT_IN_FOLDERS = new Set();         // the root and every folder directly under it
const FOLDER_REMAP_KEY = "bmgallery::folderRemap"; // deleted folder id -> id of the folder recreated for it
// Bulk removals move bookmarks into a temporary "staging" folder and delete
// that folder in one call — see removeBookmarks for why.
const STAGING_TITLE = "Bookmark Gallery — removing…";
// Smart cleanup files bookmarks into Other Bookmarks › Smart Cleanup › <category>.
const SMART_ROOT_TITLE = "Smart Cleanup";
const UNCATEGORIZED_TITLE = "Uncategorized";
const SMART_CATEGORY_ORDER = [
  "Recipes", "News & Articles", "Video", "Images", "Music", "Social Media", "Shopping",
  "Code & Dev", "Reference & Docs", "Forum", "Blog", UNCATEGORIZED_TITLE,
];
let SMART_LOOSE_PARENTS = new Set(); // the built-in folders except the toolbar (Menu, Other, Mobile)
const PENDING_REMOVAL_KEY = "bmgallery::pendingRemoval"; // { folderId, batchId } while a staging folder exists
const STAGING_FLUSH = 500; // delete the staging folder after this many moves
const TOAST_MS = 12000;
const IMAGE_DIM_PREFIX = "bmgallery::img::"; // image url -> { w, h } or { failed }
const IMAGE_RETRY_MS = 24 * 60 * 60 * 1000;   // failed images are retried after a day
const IMAGE_DIMS_VERSION = 2;                 // bump to re-probe everything (v2: placeholder detection)
// A redirect to a URL like this means the host swapped in a "this image was
// deleted" picture (e.g. imgur → /removed.png, Flickr → photo_unavailable.png).
const PLACEHOLDER_URL = /removed|deleted|unavailable|not[-_]?found|missing|no[-_]?image|placeholder|\b404\b/i;
const PROBE_CONCURRENCY = 6;
const PROBE_PER_HOST = 2;
const PROBE_MAX_BYTES = 512 * 1024;           // give up on header parsing after this much
const IMAGE_GAP_PX = 14;                      // must match .images-masonry / .images-column gap
const IMAGE_CAPTION_PX = 32;                  // must match .image-card-caption height
const SHIMMER_MS = 1300;        // must match the shimmer animation duration in the CSS
const CLEANUP_PAGE_SIZE = 100; // Clean up lists render this many at a time ("Show more" adds another page)

// Query params that only track where a click came from — ignored when
// deciding whether two bookmarks point at the same page.
const TRACKING_PARAM = /^(utm_\w+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref_src)$/i;

const PIE_COLORS = [
  "#5ea1ff", "#4fd1a5", "#ffce45", "#ff6b6b", "#a78bfa",
  "#ff9f43", "#38bdf8", "#f472b6", "#84cc16", "#f97316",
];

// Domains that strongly imply a category, checked when we don't have (or
// need to double-check) richer signals from the page itself.
const DOMAIN_CATEGORY_RULES = [
  { category: "Images", pattern: /(^|\.)(imgur\.com|redd\.it|giphy\.com|tenor\.com|flickr\.com|staticflickr\.com|500px\.com|unsplash\.com|pexels\.com|imgbb\.com|postimg\.cc|pinimg\.com|pixabay\.com)$/i },
  { category: "Video", pattern: /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|twitch\.tv|dailymotion\.com)$/i },
  { category: "Music", pattern: /(^|\.)(spotify\.com|soundcloud\.com|bandcamp\.com|music\.apple\.com)$/i },
  { category: "Social Media", pattern: /(^|\.)(twitter\.com|x\.com|facebook\.com|instagram\.com|threads\.net|linkedin\.com|tiktok\.com)$/i },
  { category: "Forum", pattern: /(^|\.)(reddit\.com|stackoverflow\.com|.*\.stackexchange\.com|discourse\.org)$/i },
  { category: "Shopping", pattern: /(^|\.)(amazon\.[a-z.]+|etsy\.com|ebay\.[a-z.]+|walmart\.com|target\.com|shopify\.com)$/i },
  { category: "Code & Dev", pattern: /(^|\.)(github\.com|gitlab\.com|npmjs\.com|developer\.mozilla\.org|bitbucket\.org)$/i },
  { category: "Reference & Docs", pattern: /(^|\.)(wikipedia\.org)$/i },
  { category: "News & Articles", pattern: /(^|\.)(nytimes\.com|cnn\.com|bbc\.co\.uk|bbc\.com|reuters\.com|theguardian\.com|washingtonpost\.com|npr\.org|apnews\.com)$/i },
  { category: "Blog", pattern: /(medium\.com|substack\.com|wordpress\.com|blogspot\.com)$/i },
];

// Bot-check / interstitial pages some sites serve to anonymous requests.
// Their title must never replace a bookmark's real title.
const BOT_CHECK_TITLE = /prove your humanity|just a moment\.\.\.|attention required!? \| cloudflare|verify(ing)? you are (a )?human|are you a robot|robot or human\?|security check|access denied|pardon our interruption|checking your browser|ddos-guard/i;

// Reddit answers anonymous page requests with a "Prove your humanity" page,
// but its official oEmbed endpoint (meant for embedding posts) still works.
// It needs a /r/<sub>/comments/<id> URL (bare /comments/<id> is rejected).
const REDDIT_POST_URL = /^https?:\/\/(?:www\.|old\.|new\.|np\.|m\.)?reddit\.com\/r\/[^/]+\/comments\/[a-z0-9]+/i;

const KEYWORD_CATEGORY_RULES = [
  { category: "Recipes", pattern: /\brecipes?\b|\bingredients\b|\bprep time\b|\bcook time\b/i },
  { category: "News & Articles", pattern: /\bbreaking news\b/i },
];

/* ============================================================
   State
   ============================================================ */

let allBookmarks = [];        // full flattened list, fixed order
let filteredBookmarks = [];   // after search + category filter
let displayList = [];         // what the virtual scroller renders: bookmark rows and/or group headers
let ogCache = new Map();      // in-memory mirror of browser.storage.local, url -> record
let imageDims = new Map();    // image url -> { w, h, at } or { failed: true, at }

let viewMode = "list";        // "list" | "domain" | "folders"
let expandedDomains = new Set();
let expandedFolders = null;   // Folders view; defaults to Menu + Toolbar once the roots are known
let bookmarkTree = null;      // root node from getTree(), for the Folders view
let filterActive = false;     // search text or category filter in use
let rowOffsets = [0];         // rowOffsets[i] = top of displayList[i]; last entry = total height
let categoryFilterValue = "all";
let sortMode = "default";

let trash = [];                    // removed-bookmark batches, newest first (persisted)
let folderRemap = {};              // see FOLDER_REMAP_KEY — so later restores reuse a recreated folder
let dupeKeepChoice = new Map();    // duplicate group key -> bookmark id to keep
let brokenSelection = new Set();   // bookmark ids ticked in the broken-links list
let cleanupRenderScheduled = false;
let dupesShown = CLEANUP_PAGE_SIZE;
let brokenShown = CLEANUP_PAGE_SIZE;
let toastTimerId = null;
let toastUndoAction = null;
let smartScope = "loose";      // Smart cleanup: "loose" | "everything"

let fetchQueue = [];
let queuedByUrl = new Map(); // url -> queue item, so enqueueing 30k bookmarks isn't O(n²)
let listQueueItems = new Set();    // queued items owned by the Bookmarks list (rows in view)
let inFlightListItems = new Set(); // list items currently being fetched
let activeFetches = 0;
let activeBulkFetches = 0;
let hostsInFlight = new Set(); // hostnames currently being fetched (max 1 request per host at a time)

let activeTab = "list";
let insightsRenderScheduled = false;
let imagesRenderScheduled = false;
let bulkCheckRunning = false; // true once "Check remaining" (header) has been started
let queuePaused = false;      // true while the user has paused fetching

/* ============================================================
   DOM references
   ============================================================ */

const scrollContainer = document.getElementById("scroll-container");
const spacer = document.getElementById("spacer");
const visibleRowsEl = document.getElementById("visible-rows");
const filterCount = document.getElementById("filter-count");
const searchInput = document.getElementById("search-input");
const categoryFilterEl = document.getElementById("category-filter");
const refreshAllBtn = document.getElementById("refresh-all-btn");
const viewButtons = [...document.querySelectorAll(".view-btn")];
const expandAllBtn = document.getElementById("expand-all-btn");
const collapseAllBtn = document.getElementById("collapse-all-btn");
const emptyState = document.getElementById("empty-state");
const checkStatusLabel = document.getElementById("check-status-label");
const checkFill = document.getElementById("check-fill");
const checkToggleBtn = document.getElementById("check-toggle-btn");

const tabBtnList = document.getElementById("tab-btn-list");
const tabBtnInsights = document.getElementById("tab-btn-insights");
const tabBtnImages = document.getElementById("tab-btn-images");
const viewsBtn = document.getElementById("views-btn");
const viewsBtnLabel = document.getElementById("views-btn-label");
const viewsListEl = document.getElementById("views-list");
const panelList = document.getElementById("panel-list");
const panelInsights = document.getElementById("panel-insights");
const panelImages = document.getElementById("panel-images");
const coverageLabel = document.getElementById("insights-coverage-label");
const imagesCountLabel = document.getElementById("images-count-label");
const imagesMasonryEl = document.getElementById("images-masonry");
const imagesEmptyState = document.getElementById("images-empty-state");
const sortSelectEl = document.getElementById("sort-select");

const tabBtnCleanup = document.getElementById("tab-btn-cleanup");
const panelCleanup = document.getElementById("panel-cleanup");
const dupesSummary = document.getElementById("dupes-summary");
const dupesList = document.getElementById("dupes-list");
const dupesRemoveAllBtn = document.getElementById("dupes-remove-all-btn");
const brokenSummary = document.getElementById("broken-summary");
const brokenList = document.getElementById("broken-list");
const brokenSelectDeadBtn = document.getElementById("broken-select-dead-btn");
const brokenSelectNoneBtn = document.getElementById("broken-select-none-btn");
const brokenRecheckBtn = document.getElementById("broken-recheck-btn");
const brokenRemoveBtn = document.getElementById("broken-remove-btn");
const trashList = document.getElementById("trash-list");
const smartSummary = document.getElementById("smart-summary");
const smartPlan = document.getElementById("smart-plan");
const smartRunBtn = document.getElementById("smart-run-btn");
const smartScopeInputs = [...document.querySelectorAll('input[name="smart-scope"]')];
const repairSection = document.getElementById("repair-section");
const repairSummary = document.getElementById("repair-summary");
const repairBtn = document.getElementById("repair-btn");
const emptyFoldersSummary = document.getElementById("empty-folders-summary");
const emptyFoldersList = document.getElementById("empty-folders-list");
const emptyFoldersRestoreBtn = document.getElementById("empty-folders-restore-btn");
const emptyFoldersDeleteBtn = document.getElementById("empty-folders-delete-btn");
const trashEmptyBtn = document.getElementById("trash-empty-btn");
const toastEl = document.getElementById("toast");
const toastMessage = document.getElementById("toast-message");
const toastUndoBtn = document.getElementById("toast-undo-btn");
const toastCloseBtn = document.getElementById("toast-close-btn");
const jobBar = document.getElementById("job-bar");
const jobLabel = document.getElementById("job-label");
const jobCount = document.getElementById("job-count");
const jobFill = document.getElementById("job-fill");
const jobCancelBtn = document.getElementById("job-cancel-btn");

/* ============================================================
   Bookmark loading
   ============================================================ */

// folderId -> { name, hasSubfolders } for every folder; rebuilt with allBookmarks.
let folderInfo = new Map();
let brokenSeparatorCount = 0; // see isBrokenSeparator; rebuilt with allBookmarks

// Firefox reports separator lines with url "data:" (and type "separator").
// They're not bookmarks: never list them, de-duplicate them, or count them.
const isSeparatorNode = (node) => node.type === "separator";
// Earlier versions treated separators as bookmarks; removing and restoring
// one turned it into a blank bookmark pointing at "data:". Those can be
// turned back into separators (Clean up → Repair).
const isBrokenSeparator = (node) =>
  SUPPORTS_SEPARATORS && node.url === "data:" && !node.title && !isSeparatorNode(node) && !node.children;
// Same test for trash entries saved by those versions.
const isSeparatorItem = (item) => item.kind === "separator" || (!item.kind && item.url === "data:" && !item.title);

function flattenBookmarks(nodes, out = [], path = []) {
  for (const node of nodes) {
    if (isSeparatorNode(node)) continue;
    if (isBrokenSeparator(node)) {
      brokenSeparatorCount += 1;
      continue;
    }
    if (node.url && !node.url.startsWith("place:")) {
      out.push({
        id: node.id,
        parentId: node.parentId,
        title: node.title || node.url,
        url: node.url,
        dateAdded: node.dateAdded || 0,
        folderPath: path.join(" › "),
        // 1 = loose in Bookmarks Menu / Toolbar / Other Bookmarks;
        // 2+ = filed inside one of the user's own folders.
        folderDepth: path.length,
      });
    }
    if (node.children) {
      const before = out.length;
      if (node.children.length > 0) {
        // The invisible root has an empty title; everything below it
        // ("Bookmarks Toolbar", "Other Bookmarks", ...) becomes the path.
        flattenBookmarks(node.children, out, node.title ? [...path, node.title] : path);
      }
      const subfolders = node.children.filter((c) => c.children);
      folderInfo.set(node.id, {
        name: node.title,
        parentId: node.parentId,
        path: [...path, node.title].join(" › "),
        childCount: node.children.length,
        hasSubfolders: subfolders.length > 0,
        bookmarkCount: out.length - before, // anywhere inside, including subfolders
        folderCount: subfolders.reduce((n, c) => n + 1 + folderInfo.get(c.id).folderCount, 0),
      });
    }
  }
  return out;
}

// Firefox: root________ › menu / toolbar / unfiled / mobile.
// Chrome:  0 › 1 Bookmarks bar / 2 Other bookmarks / 3 Mobile bookmarks
// (newer versions also tag them with folderType, and may add account copies).
function detectRootFolders(root) {
  const tops = root.children || [];
  const find = (firefoxId, folderType, chromeId) =>
    (tops.find((c) => c.id === firefoxId) || tops.find((c) => c.folderType === folderType) ||
     tops.find((c) => c.id === chromeId) || {}).id;
  ROOT_FOLDER_ID = root.id;
  OTHER_BOOKMARKS_ID = find("unfiled_____", "other", "2") || OTHER_BOOKMARKS_ID;
  TOOLBAR_ID = find("toolbar_____", "bookmarks-bar", "1") || TOOLBAR_ID;
  BUILT_IN_FOLDERS = new Set([root.id, ...tops.map((c) => c.id)]);
  SMART_LOOSE_PARENTS = new Set(tops.map((c) => c.id).filter((id) => id !== TOOLBAR_ID));
  if (!expandedFolders) expandedFolders = new Set(["menu________", TOOLBAR_ID]);
}

async function loadBookmarks({ keepScroll = false } = {}) {
  const tree = await browser.bookmarks.getTree();
  detectRootFolders(tree[0]);
  folderInfo = new Map();
  brokenSeparatorCount = 0;
  bookmarkTree = tree[0];
  allBookmarks = flattenBookmarks(tree);
  applyFilters({ keepScroll });
  renderCheckStatus();
}

// Bookmarks can change underneath us — from our own removes/restores or
// from Firefox itself — so reload (debounced, since a bulk remove fires
// one event per bookmark) and refresh whichever tab is showing.
let bookmarksReloadId = null;
function scheduleBookmarksReload() {
  // During a bulk job every remove/create fires an event; reloading 30k
  // bookmarks over and over is what used to freeze the page. endJob()
  // calls this once when the job is done instead.
  if (currentJob) return;
  clearTimeout(bookmarksReloadId);
  bookmarksReloadId = setTimeout(async () => {
    await loadBookmarks({ keepScroll: true });
    scheduleInsightsRender();
    scheduleImagesRender();
    if (viewsById.has(activeTab)) scheduleViewRender(viewsById.get(activeTab));
    if (activeTab === "cleanup") renderCleanup(); // already debounced; don't add the throttle delay
  }, 250);
}

/* ============================================================
   Persistent storage (browser.storage.local)
   ============================================================ */

function cacheKey(url) {
  return CACHE_PREFIX + url;
}

// Everything is loaded into memory once at startup, so reads stay
// synchronous; writes go to storage in the background.
async function loadStorage() {
  const stored = await browser.storage.local.get(null);
  const staleKeys = [];
  for (const [key, value] of Object.entries(stored)) {
    if (key.startsWith(CACHE_PREFIX)) {
      // Older versions saved bot-check pages ("Prove your humanity") as real
      // previews — forget those so they get fetched again properly.
      if (value && value.status === "ok" && BOT_CHECK_TITLE.test(value.ogTitle || "")) {
        staleKeys.push(key);
        continue;
      }
      ogCache.set(key.slice(CACHE_PREFIX.length), value);
    }
    else if (key.startsWith(IMAGE_DIM_PREFIX)) imageDims.set(key.slice(IMAGE_DIM_PREFIX.length), value);
  }

  const prefs = stored[PREFS_KEY] || {};
  viewMode = prefs.viewMode || (prefs.groupMode ? "domain" : "list");
  expandedDomains = new Set(prefs.expandedDomains || []);
  if (prefs.expandedFolders) expandedFolders = new Set(prefs.expandedFolders);
  sortMode = prefs.sortMode || "default";
  if (staleKeys.length) browser.storage.local.remove(staleKeys).catch(() => {});
  trash = Array.isArray(stored[TRASH_KEY]) ? stored[TRASH_KEY] : [];
  folderRemap = stored[FOLDER_REMAP_KEY] || {};

  await migrateLocalStorageCache();
}

// Earlier versions cached previews in localStorage (~5 MB quota). Move
// any of those entries over once, then drop them from localStorage.
async function migrateLocalStorageCache() {
  const toStore = {};
  const oldKeys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(CACHE_PREFIX)) continue;
    oldKeys.push(key);
    const url = key.slice(CACHE_PREFIX.length);
    if (ogCache.has(url)) continue;
    try {
      const record = JSON.parse(localStorage.getItem(key));
      ogCache.set(url, record);
      toStore[key] = record;
    } catch (e) {
      // Corrupt entry — just drop it.
    }
  }
  if (oldKeys.length === 0) return;
  await browser.storage.local.set(toStore);
  oldKeys.forEach((key) => localStorage.removeItem(key));
}

function readCache(url) {
  return ogCache.get(url) || null;
}

function writeCache(url, record) {
  ogCache.set(url, record);
  browser.storage.local.set({ [cacheKey(url)]: record }).catch((e) => {
    console.warn("Bookmark Gallery: could not persist cache for", url, e);
  });
}

function clearAllCache() {
  const keys = [...ogCache.keys()].map(cacheKey);
  ogCache.clear();
  browser.storage.local.remove(keys).catch((e) => {
    console.warn("Bookmark Gallery: could not clear cache", e);
  });
}

function savePrefs() {
  browser.storage.local
    .set({ [PREFS_KEY]: { viewMode, expandedDomains: [...expandedDomains], expandedFolders: [...expandedFolders], sortMode } })
    .catch((e) => console.warn("Bookmark Gallery: could not save preferences", e));
}

function saveTrash() {
  return browser.storage.local.set({ [TRASH_KEY]: trash });
}

function saveFolderRemap() {
  return browser.storage.local.set({ [FOLDER_REMAP_KEY]: folderRemap });
}

/* ============================================================
   Category detection
   ============================================================ */

// Every JSON-LD block on the page, parsed once — category detection and
// view plugins' extract() both read it.
function parseJsonLd(doc) {
  const items = [];
  doc.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
    try {
      const data = JSON.parse(script.textContent);
      items.push(...(Array.isArray(data) ? data : [data]));
    } catch (e) {
      // Malformed JSON-LD is common in the wild — ignore and move on.
    }
  });
  return items;
}

function extractJsonLdTypes(items) {
  const types = [];
  items.forEach((item) => collectJsonLdTypes(item, types));
  return types;
}

function collectJsonLdTypes(item, out) {
  if (!item || typeof item !== "object") return;
  if (item["@type"]) {
    const t = item["@type"];
    if (Array.isArray(t)) out.push(...t);
    else out.push(t);
  }
  if (Array.isArray(item["@graph"])) {
    item["@graph"].forEach((sub) => collectJsonLdTypes(sub, out));
  }
}

/**
 * Best-effort category guess. Works with whatever signals are available —
 * pass jsonLdTypes/ogType when we've actually fetched the page, or leave
 * them empty for a lighter domain/title-only guess on unfetched bookmarks.
 */
function detectCategory({ url = "", hostname = "", title = "", description = "", ogType = "", jsonLdTypes = [] }) {
  const lowerHost = hostname.toLowerCase();

  // A URL that IS an image is the strongest possible signal — no page
  // fetch needed to know that.
  if (isDirectImageUrl(url)) return "Images";

  if (jsonLdTypes.some((t) => /recipe/i.test(t))) return "Recipes";
  if (jsonLdTypes.some((t) => /newsarticle|reportagenewsarticle/i.test(t))) return "News & Articles";
  if (jsonLdTypes.some((t) => /product|offer/i.test(t))) return "Shopping";

  if (/^image/i.test(ogType)) return "Images";
  if (/^video/i.test(ogType)) return "Video";
  if (/^music/i.test(ogType)) return "Music";
  if (ogType === "article") return "News & Articles";
  if (ogType === "product") return "Shopping";
  if (ogType === "profile") return "Social Media";

  for (const rule of DOMAIN_CATEGORY_RULES) {
    if (rule.pattern.test(lowerHost)) return rule.category;
  }

  const haystack = `${title} ${description}`;
  for (const rule of KEYWORD_CATEGORY_RULES) {
    if (rule.pattern.test(haystack)) return rule.category;
  }

  return "Other";
}

// Categories are asked for constantly (filters, Insights, Images) across
// every bookmark; remember each answer until its cache record changes.
const categoryMemo = new Map(); // url -> { record, title, category }

function getCategoryForBookmark(bookmark) {
  const record = readCache(bookmark.url);
  const memo = categoryMemo.get(bookmark.url);
  if (memo && memo.record === record && memo.title === bookmark.title) return memo.category;
  const category = computeCategoryForBookmark(bookmark, record);
  categoryMemo.set(bookmark.url, { record, title: bookmark.title, category });
  return category;
}

function computeCategoryForBookmark(bookmark, record) {
  // While a checked bookmark is being re-fetched, keep its old category.
  if (record && record.status === "loading" && record.previous) record = record.previous;
  if (record && record.status === "ok" && record.category) {
    return record.category;
  }
  // Nothing fetched yet (or it failed/was skipped) — fall back to a
  // lighter guess using just the URL, domain, and bookmark title.
  return detectCategory({
    url: bookmark.url,
    hostname: hostnameOf(bookmark.url),
    title: bookmark.title,
  });
}

/* ============================================================
   OpenGraph fetching, with a small concurrency- and host-limited queue
   ============================================================ */

function isFetchableUrl(url) {
  return /^https?:\/\//i.test(url);
}

function isDirectImageUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    return /\.(jpe?g|png|gif|webp|bmp|avif|svgz?)$/i.test(pathname);
  } catch (e) {
    return false;
  }
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return "";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function enqueueFetch(bookmark, force = false, source = "list") {
  // Bookmarklets (javascript:...), internal pages, etc. aren't real web
  // pages — there's nothing to fetch, so don't try.
  if (!isFetchableUrl(bookmark.url)) {
    writeCache(bookmark.url, {
      url: bookmark.url,
      status: "skipped",
      error: "Not a web page (bookmarklet or internal link) — nothing to preview.",
      fetchedAt: Date.now(),
    });
    return;
  }

  if (!force && readCache(bookmark.url)) return;

  const existing = queuedByUrl.get(bookmark.url);
  if (existing) {
    // A bookmark actually visible in the list jumps ahead of a queued
    // background bulk-check item, so scrolling never waits behind it.
    // `returnTo` hands it back if the row scrolls away before it runs.
    if (source === "list" && existing.source !== "list") {
      existing.returnTo = existing.source;
      existing.source = "list";
      listQueueItems.add(existing);
      // It may now be runnable when nothing else is (e.g. the check is
      // paused and idle), so nothing else would kick the queue for it.
      pumpQueue();
    }
    return;
  }

  // The host is parsed once here — pumpQueue scans the whole queue often.
  const item = { bookmark, source, host: hostnameOf(bookmark.url) };
  fetchQueue.push(item);
  queuedByUrl.set(bookmark.url, item);
  if (source === "list") listQueueItems.add(item);
  pumpQueue();
}

// Rows that scroll out of the rendered range give up their fetch — queued
// or already running — so a fast scroll never leaves the rows you stop on
// waiting behind hundreds you scrolled past. Anything borrowed from another
// queue (e.g. the paused background check) is handed back to it; the rest
// is simply re-queued if its row comes back into view.
function releaseOffscreenListItems(keepUrls) {
  let dropped = null;
  for (const item of listQueueItems) {
    if (keepUrls.has(item.bookmark.url)) continue;
    listQueueItems.delete(item);
    if (queuedByUrl.get(item.bookmark.url) !== item) continue; // already started or dropped
    if (item.returnTo) {
      item.source = item.returnTo;
      item.returnTo = undefined;
    } else {
      (dropped ||= new Set()).add(item);
      queuedByUrl.delete(item.bookmark.url);
    }
  }
  if (dropped) fetchQueue = fetchQueue.filter((item) => !dropped.has(item));

  for (const item of inFlightListItems) {
    if (!keepUrls.has(item.bookmark.url)) item.cancel.abort();
  }
}

// A queued item only runs while its owning tab is the one on screen —
// except the bulk check, which keeps going in the background on any tab
// (pumpQueue gives on-screen work priority over it).
function isSourceActive(source) {
  if (source === "list") return activeTab === "list";
  if (source === "bulk") return bulkCheckRunning && !queuePaused;
  if (source === "images") return activeTab === "images";
  if (source === "cleanup") return activeTab === "cleanup";
  if (viewsById.has(source)) return activeTab === source; // a view plugin's own fetches
  return true;
}

function pumpQueue() {
  while (activeFetches < MAX_CONCURRENT_FETCHES) {
    // Never hit one host with several requests at once (avoids HTTP 429).
    const eligible = (item) => isSourceActive(item.source) && !hostsInFlight.has(item.host);
    // On-screen work goes first. The background bulk check gets whatever
    // is left — but away from Insights it always leaves one slot free, so
    // rows scrolled into view never wait behind it.
    let index = fetchQueue.findIndex((item) => item.source !== "bulk" && eligible(item));
    if (index === -1 && (activeTab === "insights" || activeBulkFetches < MAX_CONCURRENT_FETCHES - 1)) {
      index = fetchQueue.findIndex((item) => item.source === "bulk" && eligible(item));
    }
    if (index === -1) return;

    const item = fetchQueue.splice(index, 1)[0];
    queuedByUrl.delete(item.bookmark.url);
    listQueueItems.delete(item);
    startFetch(item);
  }
}

function startFetch(item) {
  const { bookmark, source, host } = item;
  activeFetches += 1;
  if (source === "bulk") activeBulkFetches += 1;
  hostsInFlight.add(host);
  item.cancel = new AbortController();
  if (source === "list") inFlightListItems.add(item);

  writeLoadingMarker(bookmark.url);
  reRenderRowIfVisible(bookmark.url);

  fetchOpenGraphData(bookmark, 1, item.cancel.signal)
    .then((record) => writeCache(bookmark.url, record))
    .catch((err) => {
      if (item.cancel.signal.aborted) {
        // Its row scrolled away: not a failure, just not needed right now.
        const marker = ogCache.get(bookmark.url);
        if (marker && marker.previous) ogCache.set(bookmark.url, marker.previous);
        else ogCache.delete(bookmark.url);
        return;
      }
      writeCache(bookmark.url, {
        url: bookmark.url,
        status: "error",
        error: String(err && err.message ? err.message : err),
        fetchedAt: Date.now(),
      });
    })
    .finally(() => {
      activeFetches -= 1;
      if (source === "bulk") activeBulkFetches -= 1;
      hostsInFlight.delete(host);
      inFlightListItems.delete(item);
      if (item.cancel.signal.aborted && item.returnTo) enqueueFetch(bookmark, false, item.returnTo);
      reRenderRowIfVisible(bookmark.url);
      scheduleCheckStatusRender();
      scheduleInsightsRender();
      onImageBookmarkFetched(bookmark);
      onViewBookmarkFetched(bookmark);
      scheduleCleanupRender({ onlyBroken: true });
      pumpQueue();
    });
}

// A forced re-fetch of a checked bookmark (Refresh, a view plugin needing
// new data) keeps the old record as `previous` so it doesn't change
// category — or drop out of a view — while the fetch runs.
function writeLoadingMarker(url) {
  const old = ogCache.get(url);
  const previous = old && old.status === "ok" ? old : old && old.previous;
  ogCache.set(url, previous ? { url, status: "loading", previous } : { url, status: "loading" });
}

async function fetchOpenGraphData(bookmark, attempt = 1, cancelSignal = null) {
  if (cancelSignal && cancelSignal.aborted) throw new Error("Cancelled");
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const onCancel = () => controller.abort();
  if (cancelSignal) cancelSignal.addEventListener("abort", onCancel);

  try {
    const isRedditPost = REDDIT_POST_URL.test(bookmark.url);
    const fetchUrl = isRedditPost
      ? "https://www.reddit.com/oembed?url=" + encodeURIComponent(bookmark.url)
      : bookmark.url;
    const response = await fetch(fetchUrl, {
      signal: controller.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });

    if (response.status === 429 && attempt <= 2) {
      clearTimeout(timeoutId);
      await sleep(attempt * 2000); // back off 2s, then 4s, before retrying
      return fetchOpenGraphData(bookmark, attempt + 1, cancelSignal);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    if (isRedditPost) return redditRecord(bookmark, await response.json());

    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");

    const meta = (property) => {
      const el =
        doc.querySelector(`meta[property="${property}"]`) ||
        doc.querySelector(`meta[name="${property}"]`);
      return el ? el.getAttribute("content") : null;
    };

    const titleTag = doc.querySelector("title");
    const ogTitle = meta("og:title") || (titleTag ? titleTag.textContent.trim() : "") || bookmark.title;
    if (BOT_CHECK_TITLE.test(ogTitle)) {
      throw new Error(`Blocked by a bot check ("${ogTitle.trim()}")`);
    }
    const ogDescription = meta("og:description") || meta("description") || "";
    const ogType = meta("og:type") || "";
    const jsonLd = parseJsonLd(doc);
    // Older sites use microdata (itemtype="https://schema.org/Recipe") instead — same types.
    const microdataTypes = [...doc.querySelectorAll("[itemtype]")]
      .flatMap((el) => el.getAttribute("itemtype").split(/\s+/).map((t) => t.replace(/^.*\//, "")));
    const jsonLdTypes = [...extractJsonLdTypes(jsonLd), ...microdataTypes];

    const category = detectCategory({
      url: bookmark.url,
      hostname: hostnameOf(bookmark.url),
      title: ogTitle,
      description: ogDescription,
      ogType,
      jsonLdTypes,
    });

    return {
      url: bookmark.url,
      status: "ok",
      ogTitle,
      ogDescription,
      ogImage: resolveUrl(meta("og:image"), bookmark.url),
      ogSiteName: meta("og:site_name") || "",
      category,
      ...runViewExtractors({ doc, url: bookmark.url, jsonLd, meta }),
      fetchedAt: Date.now(),
    };
  } finally {
    clearTimeout(timeoutId);
    if (cancelSignal) cancelSignal.removeEventListener("abort", onCancel);
  }
}

function redditRecord(bookmark, data) {
  if (!data || !data.title) throw new Error("HTTP 404"); // post gone
  const subreddit = (bookmark.url.match(/\/r\/([^/]+)/) || [])[1];
  return {
    url: bookmark.url,
    status: "ok",
    ogTitle: data.title,
    ogDescription: [data.author_name && `Posted by u/${data.author_name}`, subreddit && `in r/${subreddit}`].filter(Boolean).join(" "),
    ogImage: "",
    ogSiteName: "Reddit",
    category: "Forum",
    ...runViewExtractors(null), // no page to read, but don't re-fetch it for one
    fetchedAt: Date.now(),
  };
}

function resolveUrl(maybeRelative, baseUrl) {
  if (!maybeRelative) return "";
  try {
    return new URL(maybeRelative, baseUrl).href;
  } catch (e) {
    return "";
  }
}

/* ============================================================
   Filtering, grouping, and the display list
   ============================================================ */

// Lower sorts first for "Failed first": broken links, then anything not
// yet checked, then bookmarklets, then healthy ones.
function statusRank(bookmark) {
  const record = readCache(bookmark.url);
  if (!record || record.status === "loading") return 1;
  if (record.status === "error") return 0;
  if (record.status === "skipped") return 2;
  return 3;
}

function sortBookmarks(list) {
  if (sortMode === "default") return list;
  const sorted = [...list];
  if (sortMode === "newest") sorted.sort((a, b) => b.dateAdded - a.dateAdded);
  else if (sortMode === "oldest") sorted.sort((a, b) => a.dateAdded - b.dateAdded);
  else if (sortMode === "title") sorted.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
  else if (sortMode === "status") sorted.sort((a, b) => statusRank(a) - statusRank(b));
  return sorted;
}

function applyFilters({ keepScroll = false } = {}) {
  const term = searchInput.value.trim().toLowerCase();

  filteredBookmarks = sortBookmarks(allBookmarks.filter((b) => {
    const matchesText =
      !term || b.title.toLowerCase().includes(term) || b.url.toLowerCase().includes(term);
    const matchesCategory =
      categoryFilterValue === "all" || getCategoryForBookmark(b) === categoryFilterValue;
    return matchesText && matchesCategory;
  }));

  filterActive = Boolean(term) || categoryFilterValue !== "all";
  // Only worth saying when a filter is narrowing things down; the total
  // is already in the header's check status.
  filterCount.hidden = !filterActive;
  filterCount.textContent = `${filteredBookmarks.length.toLocaleString()} of ${allBookmarks.length.toLocaleString()}`;

  rebuildDisplayList({ keepScroll });
}

function groupByDomain(list) {
  const map = new Map();
  for (const b of list) {
    const host = hostnameOf(b.url) || "Other";
    if (!map.has(host)) map.set(host, []);
    map.get(host).push(b);
  }
  return new Map([...map.entries()].sort((a, b) => b[1].length - a[1].length));
}

// Folders view: Firefox's own tree, in its order. While filtering, only
// folders containing matches are shown, and they're opened automatically.
function buildFolderDisplayList() {
  const out = [];
  if (!bookmarkTree) return out;
  const byId = new Map(allBookmarks.map((b) => [b.id, b]));
  const matching = filterActive ? new Set(filteredBookmarks.map((b) => b.id)) : null;
  const shown = (node) => byId.has(node.id) && (!matching || matching.has(node.id));

  const counts = new Map(); // folder id -> bookmarks inside it (recursively)
  const count = (node) => {
    let n = 0;
    for (const child of node.children || []) n += child.children ? count(child) : shown(child) ? 1 : 0;
    counts.set(node.id, n);
    return n;
  };
  count(bookmarkTree);

  const walk = (node, depth) => {
    for (const child of node.children || []) {
      if (child.children) {
        if (matching && counts.get(child.id) === 0) continue;
        const expanded = matching ? true : expandedFolders.has(child.id);
        out.push({ type: "folder", folder: child, depth, count: counts.get(child.id), empty: child.children.length === 0, expanded });
        if (expanded) walk(child, depth + 1);
      } else if (shown(child)) {
        out.push({ type: "bookmark", bookmark: byId.get(child.id), depth });
      }
    }
  };
  walk(bookmarkTree, 0);
  return out;
}

function rebuildDisplayList({ keepScroll = false } = {}) {
  if (viewMode === "folders") {
    displayList = buildFolderDisplayList();
  } else if (viewMode === "list") {
    displayList = filteredBookmarks.map((b) => ({ type: "bookmark", bookmark: b }));
  } else {
    const groups = groupByDomain(filteredBookmarks);
    displayList = [];
    groups.forEach((items, domain) => {
      displayList.push({ type: "header", domain, count: items.length });
      if (expandedDomains.has(domain)) {
        items.forEach((b) => displayList.push({ type: "bookmark", bookmark: b }));
      }
    });
  }
  if (!keepScroll) scrollContainer.scrollTop = 0;
  renderScrollArea();
  renderVisibleRows();
}

/* ============================================================
   Virtualized rendering
   ============================================================ */

const rowHeight = (item) => (item.type === "bookmark" ? ROW_HEIGHT : HEADER_HEIGHT);

function renderScrollArea() {
  rowOffsets = new Array(displayList.length + 1);
  rowOffsets[0] = 0;
  for (let i = 0; i < displayList.length; i++) rowOffsets[i + 1] = rowOffsets[i] + rowHeight(displayList[i]);
  spacer.style.height = rowOffsets[displayList.length] + "px";
  emptyState.hidden = displayList.length > 0;
}

// Index of the row containing pixel offset y (rows have mixed heights).
function rowAt(y) {
  let lo = 0;
  let hi = displayList.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (rowOffsets[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

function getRenderRange() {
  const scrollTop = scrollContainer.scrollTop;
  const viewportHeight = scrollContainer.clientHeight;

  const firstVisible = rowAt(scrollTop);
  const lastVisible = Math.min(displayList.length, rowAt(scrollTop + viewportHeight) + 1);

  const start = Math.max(0, firstVisible - BUFFER_ROWS);
  const end = Math.min(displayList.length, lastVisible + BUFFER_ROWS);

  return { start, end, firstVisible, lastVisible };
}

// Bookmark rows currently in the DOM, by bookmark id. A row stays in place
// until its record changes: rebuilding (or even re-inserting) a row restarts
// its loading pulse, and doing that to every row whenever any fetch finished
// made the whole list flicker.
let renderedRows = new Map(); // bookmark id -> { el, bookmark, record }

// Negative delay that puts a loading pulse in phase with a shared clock, so
// pulses started at different times still beat together. Set on a container
// as --shimmer-delay; the CSS animations read it.
function shimmerDelay() {
  return -(performance.now() % SHIMMER_MS) + "ms";
}

function renderVisibleRows() {
  const { start, end, firstVisible, lastVisible } = getRenderRange();
  const fragment = document.createDocumentFragment();

  // Free the queue of rows that scrolled away, then queue this range:
  // rows actually on screen first, the buffer rows above/below after.
  const inRange = [];
  for (let i = start; i < end; i++) {
    if (displayList[i].type === "bookmark") inRange.push({ i, bookmark: displayList[i].bookmark });
  }
  // (Only while the list is showing — a hidden list measures as zero height.)
  if (activeTab === "list") {
    releaseOffscreenListItems(new Set(inRange.map((r) => r.bookmark.url)));
    const onScreen = (r) => r.i >= firstVisible && r.i < lastVisible;
    [...inRange.filter(onScreen), ...inRange.filter((r) => !onScreen(r))].forEach(({ bookmark }) => {
      if (!readCache(bookmark.url)) enqueueFetch(bookmark); // resolves synchronously for skipped urls
    });
  }

  const nextRows = new Map();
  const kept = new Set();
  for (let i = start; i < end; i++) {
    const item = displayList[i];
    if (item.type === "header") {
      fragment.appendChild(buildHeaderRow(item, i));
    } else if (item.type === "folder") {
      fragment.appendChild(buildFolderRow(item, i));
    } else {
      const { bookmark } = item;
      const record = readCache(bookmark.url);
      let entry = renderedRows.get(bookmark.id);
      if (entry && entry.bookmark === bookmark && entry.record === record) {
        kept.add(entry.el);
      } else {
        entry = { el: buildRowElement(bookmark, i), bookmark, record };
        fragment.appendChild(entry.el);
      }
      entry.el.style.top = rowOffsets[i] + "px";
      entry.el.style.paddingLeft = item.depth !== undefined ? 24 + item.depth * FOLDER_INDENT_PX + "px" : "";
      nextRows.set(bookmark.id, entry);
    }
  }

  // Rows are absolutely positioned, so DOM order doesn't matter: drop what
  // left the range or changed, leave the rest untouched, add the new ones.
  for (const child of [...visibleRowsEl.children]) {
    if (!kept.has(child)) child.remove();
  }
  visibleRowsEl.appendChild(fragment);
  renderedRows = nextRows;
}

function buildHeaderRow(item, index) {
  const row = document.createElement("div");
  row.className = "row row-header";
  row.style.top = rowOffsets[index] + "px";

  const expanded = expandedDomains.has(item.domain);

  const chevron = document.createElement("span");
  chevron.className = "row-header-chevron";
  chevron.textContent = expanded ? "▾" : "▸";

  const label = document.createElement("span");
  label.className = "row-header-label";
  label.textContent = item.domain;

  const count = document.createElement("span");
  count.className = "row-header-count";
  count.textContent = `${item.count} bookmark${item.count === 1 ? "" : "s"}`;

  row.append(chevron, label, count);
  row.addEventListener("click", () => {
    if (expandedDomains.has(item.domain)) expandedDomains.delete(item.domain);
    else expandedDomains.add(item.domain);
    savePrefs();
    rebuildDisplayList({ keepScroll: true });
  });

  return row;
}

function buildFolderRow(item, index) {
  const row = document.createElement("div");
  row.className = "row row-header row-folder" + (item.empty ? " empty" : "");
  row.style.top = rowOffsets[index] + "px";
  row.style.paddingLeft = 24 + item.depth * FOLDER_INDENT_PX + "px";

  const chevron = document.createElement("span");
  chevron.className = "row-header-chevron";
  chevron.textContent = item.empty ? "" : item.expanded ? "▾" : "▸";

  const icon = document.createElement("span");
  icon.className = "row-folder-icon";
  icon.textContent = "📁";

  const label = document.createElement("span");
  label.className = "row-header-label";
  label.textContent = item.folder.title || "(untitled folder)";

  const count = document.createElement("span");
  count.className = "row-header-count";
  count.textContent = item.empty ? "empty" : plural(item.count, "bookmark");

  row.append(chevron, icon, label, count);
  if (filterActive) {
    row.title = "Showing folders with matches — clear the filter to open and close folders";
  } else if (!item.empty) {
    row.addEventListener("click", () => {
      if (expandedFolders.has(item.folder.id)) expandedFolders.delete(item.folder.id);
      else expandedFolders.add(item.folder.id);
      savePrefs();
      rebuildDisplayList({ keepScroll: true });
    });
  }
  return row;
}

function buildRowElement(bookmark, index) {
  const row = document.createElement("div");
  row.className = "row";
  row.style.top = rowOffsets[index] + "px";
  row.style.setProperty("--shimmer-delay", shimmerDelay());
  row.dataset.url = bookmark.url;

  const record = readCache(bookmark.url);
  const status = record ? record.status : "pending";

  const isHttp = isFetchableUrl(bookmark.url);
  let hostname = "";
  if (isHttp) {
    hostname = hostnameOf(bookmark.url).replace(/^www\./, "");
  }
  const initial = (hostname || bookmark.title || "?").charAt(0).toUpperCase();

  // Thumbnail
  const thumb = document.createElement("div");
  thumb.className = "row-thumb";
  if (record && record.status === "ok" && record.ogImage) {
    const img = document.createElement("img");
    img.src = record.ogImage;
    img.alt = "";
    img.loading = "lazy";
    img.onerror = () => { img.remove(); thumb.textContent = initial; };
    thumb.appendChild(img);
  } else {
    thumb.textContent = initial;
    if (status === "loading" || status === "pending") thumb.classList.add("skeleton");
  }

  // Body
  const body = document.createElement("div");
  body.className = "row-body";

  const titleEl = document.createElement("p");
  titleEl.className = "row-title";
  titleEl.textContent =
    record && record.status === "ok" && record.ogTitle ? record.ogTitle : bookmark.title;
  if (status === "loading" || status === "pending") titleEl.classList.add("skeleton");

  const metaEl = document.createElement("p");
  metaEl.className = "row-meta";
  if (record && record.status === "ok" && record.ogSiteName) {
    metaEl.textContent = `${record.ogSiteName} · ${hostname}`;
  } else if (hostname) {
    metaEl.textContent = hostname;
  } else {
    metaEl.textContent = "Bookmarklet / internal link";
  }

  const descEl = document.createElement("p");
  descEl.className = "row-desc";
  if (record && record.status === "ok") {
    descEl.textContent = record.ogDescription || bookmark.url;
  } else if (record && record.status === "skipped") {
    descEl.textContent = record.error;
  } else if (record && record.status === "error") {
    const friendly =
      record.error && record.error.includes("429")
        ? "Site is rate-limiting requests — try the refresh button in a moment."
        : record.error || "couldn't load this page.";
    descEl.textContent = "Preview unavailable — " + friendly;
  } else {
    descEl.textContent = bookmark.url;
    descEl.classList.add("skeleton");
  }

  body.append(titleEl, metaEl, descEl);

  // Status + refresh controls
  const statusWrap = document.createElement("div");
  statusWrap.className = "row-status";

  const pill = document.createElement("span");
  pill.className = "status-pill";
  if (status === "ok") {
    pill.classList.add("ok");
    pill.textContent = "Cached";
  } else if (status === "skipped") {
    pill.textContent = "N/A";
  } else if (status === "error") {
    pill.classList.add("error");
    pill.textContent = "Failed";
  } else if (status === "loading") {
    pill.classList.add("loading");
    pill.textContent = "Loading";
  } else {
    pill.textContent = "Queued";
  }

  const refreshBtn = document.createElement("button");
  refreshBtn.className = "row-refresh";
  refreshBtn.title = "Re-fetch this preview";
  refreshBtn.textContent = "↻";
  refreshBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    enqueueFetch(bookmark, true);
  });

  const removeBtn = document.createElement("button");
  removeBtn.className = "row-refresh row-remove";
  removeBtn.title = "Remove this bookmark (can be undone)";
  removeBtn.textContent = "🗑";
  removeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    removeBookmarks([bookmark], "Removed from list");
  });

  statusWrap.append(pill, refreshBtn, removeBtn);

  row.append(thumb, body, statusWrap);

  row.addEventListener("click", () => {
    browser.tabs.create({ url: bookmark.url });
  });

  return row;
}

function reRenderRowIfVisible(url) {
  const existingRow = visibleRowsEl.querySelector(`.row[data-url="${cssEscape(url)}"]`);
  if (existingRow) {
    renderVisibleRows();
  }
}

function cssEscape(value) {
  return window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/"/g, '\\"');
}

/* ============================================================
   Insights tab
   ============================================================ */

function statusLabelFor(bookmark) {
  if (!isFetchableUrl(bookmark.url)) return "Not checkable";
  const record = readCache(bookmark.url);
  if (!record) return "Unchecked";
  if (record.status === "ok") return "Active";
  if (record.status === "error") return "Broken";
  if (record.status === "skipped") return "Not checkable";
  return "Unchecked"; // loading
}

function computeCounts(list, keyFn) {
  const map = new Map();
  for (const item of list) {
    const key = keyFn(item);
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}

// Whole-collection renders are throttled: while fetches stream in, they
// redraw a few times a second at most rather than after every fetch.
const HEAVY_RENDER_MS = 400;

function scheduleInsightsRender() {
  if (activeTab !== "insights" || insightsRenderScheduled) return;
  insightsRenderScheduled = true;
  setTimeout(() => {
    insightsRenderScheduled = false;
    if (activeTab === "insights") renderInsights();
  }, HEAVY_RENDER_MS);
}

function renderInsights() {
  renderCheckStatus();
  renderPieSection("domain", computeCounts(allBookmarks, (b) => hostnameOf(b.url) || "Other"));
  renderPieSection("status", computeCounts(allBookmarks, statusLabelFor));
  renderPieSection("category", computeCounts(allBookmarks, getCategoryForBookmark));
  renderInsightsExtras();
}

// "Checked" = a page fetch finished (ok or error). One definition, shown in
// the header on every tab and in the Insights banner, so they always agree.
function getCheckCoverage() {
  let checkable = 0;
  let checked = 0;
  for (const b of allBookmarks) {
    if (!isFetchableUrl(b.url)) continue;
    checkable += 1;
    const r = readCache(b.url);
    if (r && (r.status === "ok" || r.status === "error")) checked += 1;
  }
  return { checkable, checked };
}

let checkStatusScheduled = false;
function scheduleCheckStatusRender() {
  if (checkStatusScheduled) return;
  checkStatusScheduled = true;
  setTimeout(() => {
    checkStatusScheduled = false;
    renderCheckStatus();
  }, HEAVY_RENDER_MS);
}

function renderCheckStatus() {
  const { checkable, checked } = getCheckCoverage();
  const remaining = checkable - checked;

  // If a bulk pass was running and everything is now checked, wrap it up.
  if (bulkCheckRunning && remaining === 0) {
    bulkCheckRunning = false;
    queuePaused = false;
  }

  const counts = `${checked.toLocaleString()} of ${checkable.toLocaleString()}`;
  let label;
  let buttonLabel;
  if (checkable > 0 && remaining === 0) {
    label = `All ${checkable.toLocaleString()} bookmarks checked`;
  } else if (!bulkCheckRunning) {
    label = `Checked ${counts}`;
    buttonLabel = "Check remaining";
  } else if (queuePaused) {
    label = `Paused — checked ${counts}`;
    buttonLabel = "Resume";
  } else {
    label = `Checking… ${counts}`;
    buttonLabel = "Pause";
  }

  checkStatusLabel.textContent = label;
  checkFill.style.width = (checkable ? (checked / checkable) * 100 : 0) + "%";
  checkToggleBtn.hidden = !buttonLabel;
  checkToggleBtn.textContent = buttonLabel || "";

  coverageLabel.textContent = remaining === 0
    ? `These charts cover all ${checkable.toLocaleString()} checkable bookmarks.`
    : `These charts cover the ${counts} bookmarks checked so far — "Check remaining" in the header checks the rest.`;
}


function renderPieSection(key, data) {
  const total = data.reduce((sum, d) => sum + d.count, 0);
  const pieEl = document.getElementById(`pie-${key}`);
  const legendEl = document.getElementById(`legend-${key}`);
  const tableBody = document.getElementById(`table-${key}`);

  if (total === 0) {
    pieEl.style.background = "var(--border)";
    legendEl.innerHTML = "";
    tableBody.innerHTML = `<tr><td colspan="4" class="table-empty">No data yet.</td></tr>`;
    return;
  }

  // Cap the pie itself at 9 slices + an "Other" bucket for readability;
  // the table below always lists the real top 10 regardless.
  const MAX_SLICES = 9;
  let sliceData = data;
  if (data.length > MAX_SLICES) {
    const head = data.slice(0, MAX_SLICES);
    const tailCount = data.slice(MAX_SLICES).reduce((sum, d) => sum + d.count, 0);
    sliceData = [...head, { label: "Other", count: tailCount }];
  }

  let cursor = 0;
  const stops = sliceData.map((d, i) => {
    const startPct = (cursor / total) * 100;
    cursor += d.count;
    const endPct = (cursor / total) * 100;
    const color = PIE_COLORS[i % PIE_COLORS.length];
    return `${color} ${startPct}% ${endPct}%`;
  });
  pieEl.style.background = `conic-gradient(${stops.join(", ")})`;

  legendEl.innerHTML = "";
  sliceData.forEach((d, i) => {
    const li = document.createElement("li");
    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.background = PIE_COLORS[i % PIE_COLORS.length];
    const text = document.createElement("span");
    const pct = ((d.count / total) * 100).toFixed(1);
    text.textContent = `${d.label} — ${pct}%`;
    li.append(swatch, text);
    legendEl.appendChild(li);
  });

  tableBody.innerHTML = "";
  data.slice(0, 10).forEach((d, i) => {
    const pct = ((d.count / total) * 100).toFixed(1);
    const tr = document.createElement("tr");

    const rankTd = document.createElement("td");
    rankTd.textContent = String(i + 1);
    const labelTd = document.createElement("td");
    labelTd.textContent = d.label;
    const countTd = document.createElement("td");
    countTd.textContent = String(d.count);
    const pctTd = document.createElement("td");
    pctTd.textContent = pct + "%";

    tr.append(rankTd, labelTd, countTd, pctTd);
    tableBody.appendChild(tr);
  });
}

/* ---------- More insights: headline numbers, timeline, dead links, failures, folders, heatmap ----------
   Plain HTML/CSS charts. Colors come from the validated data-viz palette (its dark
   steps, checked against the card surface #1e2128): one hue per chart, never cycled. */

const CHART_BLUE = "#3987e5";   // counts
const CHART_ORANGE = "#d95926"; // dead-link share
// Sequential ramp for the heatmap, dim -> bright (more = brighter on the dark surface).
const HEAT_RAMP = ["#104281", "#1c5cab", "#2a78d6", "#5598e7", "#86b6ef", "#b7d3f6"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const monthLabelFormatter = new Intl.DateTimeFormat(undefined, { month: "short", year: "2-digit" });
const dayFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function chartEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Marks carry their tooltip text; one shared tooltip shows it on hover/focus.
function setTip(node, value, label) {
  node.dataset.tipValue = value;
  node.dataset.tipLabel = label;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function compactNumber(n) {
  return n >= 1000 ? new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n) : String(n);
}

function renderInsightsExtras() {
  renderKpis();
  renderTimeline();
  renderDeadLinks();
  renderFailureReasons();
  renderBiggestFolders();
  renderHeatmap();
}

function renderKpis() {
  const hosts = new Set();
  let oldest = Infinity;
  let checked = 0;
  let dead = 0;
  const perDay = new Map();
  for (const b of allBookmarks) {
    const host = hostnameOf(b.url);
    if (host) hosts.add(host.replace(/^www\./, ""));
    if (b.dateAdded > 0) {
      oldest = Math.min(oldest, b.dateAdded);
      const d = new Date(b.dateAdded);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const day = perDay.get(key) || { count: 0, ts: b.dateAdded };
      day.count += 1;
      perDay.set(key, day);
    }
    const r = readCache(b.url);
    if (r && (r.status === "ok" || r.status === "error")) {
      checked += 1;
      if (isLikelyDead(r)) dead += 1;
    }
  }
  const folders = [...folderInfo.keys()].filter((id) => !BUILT_IN_FOLDERS.has(id)).length;
  const extraCopies = findDuplicateGroups().reduce((n, g) => n + g.items.length - 1, 0);
  let busiest = null;
  for (const day of perDay.values()) if (!busiest || day.count > busiest.count) busiest = day;

  const tiles = [
    ["Bookmarks", allBookmarks.length.toLocaleString(), `on ${plural(hosts.size, "website")}`],
    ["Folders", folders.toLocaleString(), "of your own"],
    ["Duplicate copies", extraCopies.toLocaleString(), extraCopies ? "extra copies — see Clean up" : "no duplicates"],
    ["Dead links", dead.toLocaleString(),
      checked ? `${((dead / checked) * 100).toFixed(1)}% of ${checked.toLocaleString()} checked` : "nothing checked yet"],
  ];
  if (oldest !== Infinity) {
    const months = Math.max(1, (Date.now() - oldest) / (30.44 * 864e5));
    const years = Math.floor(months / 12);
    tiles.push(["Bookmarking since", String(new Date(oldest).getFullYear()),
      `${years >= 1 ? plural(years, "year") : plural(Math.round(months), "month")} · ~${Math.round(allBookmarks.length / months).toLocaleString()} a month`]);
  }
  if (busiest) {
    tiles.push(["Busiest day", busiest.count.toLocaleString(),
      dayFormatter.format(busiest.ts) + (busiest.count >= 100 ? " — probably an import" : "")]);
  }

  document.getElementById("insights-kpis").replaceChildren(...tiles.map(([label, value, sub]) => {
    const tile = chartEl("div", "kpi");
    tile.append(chartEl("div", "kpi-label", label), chartEl("div", "kpi-value", value), chartEl("div", "kpi-sub", sub));
    return tile;
  }));
}

// Column chart: one series, a nice rounded scale with three hairlines, the
// tallest column labelled, every column hoverable/focusable for its value.
function renderColumnChart(container, rows, { color, format, tipLabel, maxCap = Infinity }) {
  container.replaceChildren();
  if (!rows.length) {
    container.appendChild(chartEl("p", "chart-empty", "No data yet."));
    return;
  }
  const max = rows.reduce((m, r) => Math.max(m, r.value), 0);
  const top = Math.min(maxCap, niceMax(max));
  const plot = chartEl("div", "col-plot");
  for (const f of [1, 0.5, 0]) {
    const line = chartEl("div", "col-grid");
    line.style.bottom = f * 100 + "%";
    line.appendChild(chartEl("span", "col-tick", format(top * f)));
    plot.appendChild(line);
  }
  const bars = chartEl("div", "col-bars");
  const maxIndex = rows.findIndex((r) => r.value === max);
  rows.forEach((r, i) => {
    const slot = chartEl("div", "col-slot");
    slot.tabIndex = 0;
    setTip(slot, format(r.value), tipLabel(r));
    slot.setAttribute("aria-label", `${tipLabel(r)}: ${format(r.value)}`);
    const bar = chartEl("div", "col-bar");
    bar.style.height = (r.value / top) * 100 + "%";
    bar.style.background = color;
    if (i === maxIndex && max > 0) bar.appendChild(chartEl("span", "col-value", format(r.value)));
    slot.appendChild(bar);
    bars.appendChild(slot);
  });
  plot.appendChild(bars);

  const labels = chartEl("div", "col-labels");
  const every = Math.ceil(rows.length / 12);
  rows.forEach((r, i) => labels.appendChild(chartEl("span", null, i % every === 0 ? r.label : "")));
  container.append(plot, labels);
}

function renderBarList(container, rows, { color, format, empty }) {
  container.replaceChildren();
  if (!rows.length) {
    container.appendChild(chartEl("p", "chart-empty", empty));
    return;
  }
  const max = rows.reduce((m, r) => Math.max(m, r.value), 0) || 1;
  for (const r of rows) {
    const row = chartEl("div", "bar-row");
    setTip(row, format(r.value), r.title || r.label);
    const label = chartEl("span", "bar-label", r.label);
    if (r.title) label.title = r.title;
    const track = chartEl("span", "bar-track");
    const fill = chartEl("span", "bar-fill");
    fill.style.width = (r.value / max) * 100 + "%";
    fill.style.background = color;
    track.appendChild(fill);
    row.append(label, track, chartEl("span", "bar-value", format(r.value)));
    container.appendChild(row);
  }
}

function renderTable(container, headers, rows) {
  const table = chartEl("table", "top-table");
  const head = chartEl("tr");
  headers.forEach((h) => head.appendChild(chartEl("th", null, h)));
  table.appendChild(chartEl("thead")).appendChild(head);
  const body = table.appendChild(chartEl("tbody"));
  for (const cells of rows) {
    const tr = chartEl("tr");
    cells.forEach((c) => tr.appendChild(chartEl("td", null, c)));
    body.appendChild(tr);
  }
  container.replaceChildren(table);
}

// Per year — or per month when everything is from the last couple of years.
function renderTimeline() {
  let min = Infinity;
  let max = -Infinity;
  for (const b of allBookmarks) {
    if (b.dateAdded > 0) {
      min = Math.min(min, b.dateAdded);
      max = Math.max(max, b.dateAdded);
    }
  }
  const container = document.getElementById("chart-timeline");
  const title = document.getElementById("timeline-title");
  const sub = document.getElementById("timeline-sub");
  if (min === Infinity) {
    renderColumnChart(container, [], {});
    return;
  }
  const first = new Date(min);
  const last = new Date(max);
  const byYear = last.getFullYear() - first.getFullYear() >= 2;
  const keyOf = (d) => (byYear ? d.getFullYear() : d.getFullYear() * 12 + d.getMonth());
  const counts = new Map();
  for (const b of allBookmarks) {
    if (b.dateAdded > 0) {
      const k = keyOf(new Date(b.dateAdded));
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  const rows = [];
  for (let k = keyOf(first); k <= keyOf(last); k++) {
    const label = byYear ? String(k) : monthLabelFormatter.format(new Date(Math.floor(k / 12), k % 12, 1));
    rows.push({ label, value: counts.get(k) || 0 });
  }
  title.textContent = byYear ? "Bookmarks added per year" : "Bookmarks added per month";
  const peak = rows.reduce((a, b) => (b.value > a.value ? b : a));
  sub.textContent = `Busiest ${byYear ? "year" : "month"}: ${peak.label} (${plural(peak.value, "bookmark")})`;
  renderColumnChart(container, rows, {
    color: CHART_BLUE,
    format: (v) => compactNumber(Math.round(v)),
    tipLabel: (r) => r.label,
  });
  renderTable(document.getElementById("table-timeline"), [byYear ? "Year" : "Month", "Bookmarks"],
    rows.map((r) => [r.label, r.value.toLocaleString()]));
}

// Link rot: of the bookmarks checked so far from each year, how many are gone.
function renderDeadLinks() {
  const years = new Map(); // year -> { checked, dead }
  for (const b of allBookmarks) {
    if (!(b.dateAdded > 0)) continue;
    const r = readCache(b.url);
    if (!r || (r.status !== "ok" && r.status !== "error")) continue;
    const y = new Date(b.dateAdded).getFullYear();
    const e = years.get(y) || { checked: 0, dead: 0 };
    e.checked += 1;
    if (isLikelyDead(r)) e.dead += 1;
    years.set(y, e);
  }
  const MIN_CHECKED = 5; // fewer than this per year is too few to call it a rate
  const rows = [...years].sort((a, b) => a[0] - b[0]).filter(([, e]) => e.checked >= MIN_CHECKED)
    .map(([y, e]) => ({ label: String(y), value: (e.dead / e.checked) * 100, ...e }));
  const pct = (v) => (v >= 10 || v === 0 ? Math.round(v) : v.toFixed(1)) + "%";
  renderColumnChart(document.getElementById("chart-rot"), rows, {
    color: CHART_ORANGE,
    format: pct,
    maxCap: 100,
    tipLabel: (r) => `${r.label} · ${r.dead.toLocaleString()} of ${r.checked.toLocaleString()} checked`,
  });
  if (!rows.length) {
    document.querySelector("#chart-rot .chart-empty").textContent =
      `Shows once ${MIN_CHECKED}+ bookmarks from a year have been checked — use "Check remaining" in the header.`;
  }
  renderTable(document.getElementById("table-rot"), ["Year", "Dead", "Checked", "Share"],
    rows.map((r) => [r.label, r.dead.toLocaleString(), r.checked.toLocaleString(), pct(r.value)]));
}

function failureReason(record) {
  const err = record.error || "";
  if (/HTTP (404|410)\b/.test(err)) return "Not found (404/410)";
  if (NETWORK_ERROR.test(err)) return "Site unreachable";
  if (/abort|timed? ?out/i.test(err)) return "Timed out";
  if (/bot check/i.test(err)) return "Bot check";
  if (/HTTP (401|403)\b/.test(err)) return "Denied (401/403)";
  if (/HTTP 429\b/.test(err)) return "Rate limited (429)";
  if (/HTTP 5\d\d\b/.test(err)) return "Server error (5xx)";
  return "Other";
}

function renderFailureReasons() {
  const failed = allBookmarks.map((b) => readCache(b.url)).filter((r) => r && r.status === "error");
  const rows = computeCounts(failed, failureReason).map((d) => ({ label: d.label, value: d.count }));
  renderBarList(document.getElementById("chart-failures"), rows, {
    color: CHART_BLUE,
    format: (v) => v.toLocaleString(),
    empty: "No failed links among the bookmarks checked so far.",
  });
}

function renderBiggestFolders() {
  const rows = computeCounts(allBookmarks, (b) => b.parentId).slice(0, 10).map((d) => {
    const info = folderInfo.get(d.label);
    return { label: (info && info.name) || "(unnamed)", title: info && info.path, value: d.count };
  });
  renderBarList(document.getElementById("chart-folders"), rows, {
    color: CHART_BLUE,
    format: (v) => v.toLocaleString(),
    empty: "No bookmarks yet.",
  });
}

function hourLabel(h) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(new Date(2000, 0, 1, h));
}

function renderHeatmap() {
  const counts = WEEKDAYS.map(() => new Array(24).fill(0));
  let max = 0;
  for (const b of allBookmarks) {
    if (!(b.dateAdded > 0)) continue;
    const d = new Date(b.dateAdded);
    const row = counts[(d.getDay() + 6) % 7]; // Monday first
    row[d.getHours()] += 1;
    max = Math.max(max, row[d.getHours()]);
  }
  const container = document.getElementById("chart-heatmap");
  container.replaceChildren();
  if (max === 0) {
    container.appendChild(chartEl("p", "chart-empty", "No dates to show."));
    return;
  }
  const grid = chartEl("div", "heat-grid");
  grid.appendChild(chartEl("span"));
  for (let h = 0; h < 24; h++) grid.appendChild(chartEl("span", "heat-hour", h % 3 === 0 ? hourLabel(h) : ""));
  counts.forEach((row, day) => {
    grid.appendChild(chartEl("span", "heat-day", WEEKDAYS[day]));
    row.forEach((n, h) => {
      const cell = chartEl("span", "heat-cell");
      if (n > 0) cell.style.background = HEAT_RAMP[Math.min(HEAT_RAMP.length - 1, Math.floor((n / max) * HEAT_RAMP.length))];
      setTip(cell, plural(n, "bookmark"), `${WEEKDAYS[day]} · ${hourLabel(h)}`);
      grid.appendChild(cell);
    });
  });

  const legend = chartEl("div", "heat-legend");
  legend.appendChild(chartEl("span", null, "Fewer"));
  [null, ...HEAT_RAMP].forEach((c) => {
    const swatch = chartEl("span", "heat-cell heat-swatch");
    if (c) swatch.style.background = c;
    legend.appendChild(swatch);
  });
  legend.appendChild(chartEl("span", null, `More (up to ${max.toLocaleString()})`));
  container.append(grid, legend);

  renderTable(document.getElementById("table-heatmap"), ["Day", ...Array.from({ length: 24 }, (_, h) => hourLabel(h))],
    counts.map((row, day) => [WEEKDAYS[day], ...row.map(String)]));
}

// One tooltip for every chart mark on the Insights tab (hover and keyboard focus).
const chartTooltip = document.getElementById("chart-tooltip");
function showChartTip(e) {
  const mark = e.target.closest && e.target.closest("[data-tip-value]");
  if (!mark) return;
  chartTooltip.replaceChildren(chartEl("strong", null, mark.dataset.tipValue), chartEl("span", null, mark.dataset.tipLabel));
  chartTooltip.hidden = false;
  const r = mark.getBoundingClientRect();
  const w = chartTooltip.offsetWidth;
  chartTooltip.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
  chartTooltip.style.top = Math.max(8, r.top - chartTooltip.offsetHeight - 8) + "px";
}
function hideChartTip(e) {
  const mark = e.target.closest && e.target.closest("[data-tip-value]");
  if (mark && !(e.relatedTarget && mark.contains(e.relatedTarget))) chartTooltip.hidden = true;
}
panelInsights.addEventListener("pointerover", showChartTip);
panelInsights.addEventListener("focusin", showChartTip);
panelInsights.addEventListener("pointerout", hideChartTip);
panelInsights.addEventListener("focusout", hideChartTip);
panelInsights.addEventListener("scroll", () => { chartTooltip.hidden = true; });

/* ============================================================
   Images tab
   ============================================================ */

/*
   A card only appears once its image is known to be real and its size is
   known. Each image is "probed" first: just enough of the file is
   downloaded to read its dimensions from the header (then the download is
   aborted), so the card goes straight in at its final height, pulsing
   until the image itself arrives. Anything that fails — page fetch, probe,
   or the image load itself — is simply never shown.
*/

function getImageBookmarks() {
  return allBookmarks.filter((b) => getCategoryForBookmark(b) === "Images");
}

function scheduleImagesRender() {
  if (activeTab !== "images" || imagesRenderScheduled) return;
  imagesRenderScheduled = true;
  setTimeout(() => {
    imagesRenderScheduled = false;
    if (activeTab === "images") renderImagesTab();
  }, HEAVY_RENDER_MS);
}

function imageSrcFor(bookmark) {
  if (isDirectImageUrl(bookmark.url)) return bookmark.url;
  const record = readCache(bookmark.url);
  return record && record.status === "ok" && record.ogImage ? record.ogImage : "";
}

function knownImageDims(src) {
  const dims = imageDims.get(src);
  if (!dims || dims.v !== IMAGE_DIMS_VERSION) return null; // never probed, or by an older, laxer version
  if (dims.failed && Date.now() - dims.at > IMAGE_RETRY_MS) return null; // give old failures another go
  return dims;
}

function saveImageDims(src, dims) {
  dims = { ...dims, v: IMAGE_DIMS_VERSION };
  imageDims.set(src, dims);
  browser.storage.local.set({ [IMAGE_DIM_PREFIX + src]: dims }).catch((e) => {
    console.warn("Bookmark Gallery: could not persist image size for", src, e);
  });
}

/* ---------- Layout: fixed columns, each card goes in the shortest ---------- */

let imageColumns = [];               // { el, height } — height measured in column widths
let imageColumnWidth = 300;
const placedImageCards = new Map();  // bookmark url -> card element
const pendingImageSrcs = new Map();  // image url -> bookmarks waiting for its probe
let imageBookmarkList = [];          // image bookmarks as of the last full render

function imageColumnCount() {
  const w = window.innerWidth;
  return w > 1100 ? 4 : w > 800 ? 3 : w > 480 ? 2 : 1;
}

function renderImagesTab() {
  const count = imageColumnCount();
  imagesMasonryEl.replaceChildren();
  imageColumns = Array.from({ length: count }, () => {
    const el = document.createElement("div");
    el.className = "images-column";
    imagesMasonryEl.appendChild(el);
    return { el, height: 0 };
  });
  imageColumnWidth = Math.max(1, (imagesMasonryEl.clientWidth - IMAGE_GAP_PX * (count - 1)) / count);
  placedImageCards.clear();
  pendingImageSrcs.clear();

  imageBookmarkList = getImageBookmarks();
  imageBookmarkList.forEach(considerImageBookmark);
  pumpProbes();
  updateImagesLabel();
}

function considerImageBookmark(bookmark) {
  if (placedImageCards.has(bookmark.url)) return;
  const src = imageSrcFor(bookmark);
  if (!src) {
    // A page (e.g. an imgur gallery) needs its og:image found first.
    if (!isDirectImageUrl(bookmark.url) && !readCache(bookmark.url)) enqueueFetch(bookmark, false, "images");
    return;
  }
  const dims = knownImageDims(src);
  if (dims && dims.failed) return;
  if (dims && !titleMatchesDims(bookmark.title, dims)) return;
  if (dims) {
    placeImageCard(bookmark, src, dims);
    return;
  }
  if (!pendingImageSrcs.has(src)) pendingImageSrcs.set(src, []);
  pendingImageSrcs.get(src).push(bookmark);
  enqueueProbe(src);
}

// Firefox titles image bookmarks like "photo.jpg (1181×1692)" — the size
// when it was bookmarked. If the image is now a clearly different shape,
// the host has replaced it with a "this image was deleted" picture.
// (Same shape at a different size is fine — some hosts serve resized copies.)
function titleMatchesDims(title, dims) {
  const m = title.match(/\((\d+)\s*[×x]\s*(\d+)\)\s*$/);
  if (!m || !+m[1] || !+m[2]) return true;
  const drift = Math.abs(Math.log((m[1] / m[2]) / (dims.w / dims.h)));
  const driftRotated = Math.abs(Math.log((m[2] / m[1]) / (dims.w / dims.h)));
  return Math.min(drift, driftRotated) < 0.03;
}

function placeImageCard(bookmark, src, dims) {
  const column = imageColumns.reduce((a, b) => (b.height < a.height ? b : a));
  const card = buildImageCard(bookmark, src, dims);
  column.el.appendChild(card);
  column.height += dims.h / dims.w + (IMAGE_CAPTION_PX + IMAGE_GAP_PX) / imageColumnWidth;
  placedImageCards.set(bookmark.url, card);
}

function buildImageCard(bookmark, src, dims) {
  const card = document.createElement("a");
  card.className = "image-card";
  card.href = bookmark.url;
  card.target = "_blank";
  card.rel = "noopener noreferrer";

  // The frame has the image's exact aspect ratio from the start, so
  // nothing moves when the image arrives; it pulses until then.
  const frame = document.createElement("div");
  frame.className = "image-frame";
  frame.style.setProperty("--shimmer-delay", shimmerDelay());
  frame.style.aspectRatio = `${dims.w} / ${dims.h}`;

  const img = document.createElement("img");
  img.loading = "lazy";
  img.decoding = "async";
  img.alt = "";
  img.addEventListener("load", () => {
    const natural = { w: img.naturalWidth, h: img.naturalHeight };
    if (natural.w && !titleMatchesDims(bookmark.title, natural)) {
      card.remove(); // the host swapped in a placeholder since we probed it
      placedImageCards.delete(bookmark.url);
      updateImagesLabel();
      return;
    }
    frame.classList.add("loaded");
    // If the browser's idea of the size differs (e.g. an odd EXIF
    // rotation), the frame keeps its size now and object-fit covers the
    // gap; remember the real size for next time.
    if (img.naturalWidth && Math.abs(img.naturalWidth / img.naturalHeight - dims.w / dims.h) > 0.02) {
      saveImageDims(src, { w: img.naturalWidth, h: img.naturalHeight, at: Date.now() });
    }
  });
  img.addEventListener("error", () => {
    card.remove();
    placedImageCards.delete(bookmark.url);
    saveImageDims(src, { failed: true, at: Date.now() });
    updateImagesLabel();
  });
  img.src = src;
  frame.appendChild(img);

  const record = readCache(bookmark.url);
  const caption = document.createElement("div");
  caption.className = "image-card-caption";
  caption.textContent = (record && record.status === "ok" && record.ogTitle) || bookmark.title;

  card.append(frame, caption);
  return card;
}

// Called when a page fetch finishes — an image page may now have its og:image.
function onImageBookmarkFetched(bookmark) {
  if (activeTab !== "images" || getCategoryForBookmark(bookmark) !== "Images") return;
  considerImageBookmark(bookmark);
  updateImagesLabel();
}

function onImageProbed(src) {
  const waiting = pendingImageSrcs.get(src);
  pendingImageSrcs.delete(src);
  if (activeTab === "images" && waiting) waiting.forEach(considerImageBookmark);
  updateImagesLabel();
}

function updateImagesLabel() {
  const shown = placedImageCards.size;
  const checking = pendingImageSrcs.size > 0 || fetchQueue.some((item) => item.source === "images") ||
    imageBookmarkList.some((b) => (readCache(b.url) || {}).status === "loading");
  imagesCountLabel.textContent = `${plural(shown, "image")}` + (checking ? " · checking more…" : "");
  imagesEmptyState.hidden = shown > 0 || checking;
}

/* ---------- Probe queue (separate from the page-fetch queue) ---------- */

const probeQueue = [];
const probeQueued = new Set();
const probeHostsInFlight = new Map(); // hostname -> active probes
let activeProbes = 0;

function enqueueProbe(src) {
  if (probeQueued.has(src) || knownImageDims(src)) return;
  probeQueued.add(src);
  probeQueue.push(src);
  pumpProbes();
}

function pumpProbes() {
  while (activeTab === "images" && activeProbes < PROBE_CONCURRENCY) {
    const index = probeQueue.findIndex((src) => (probeHostsInFlight.get(hostnameOf(src)) || 0) < PROBE_PER_HOST);
    if (index === -1) return;
    const src = probeQueue.splice(index, 1)[0];
    const host = hostnameOf(src);
    activeProbes += 1;
    probeHostsInFlight.set(host, (probeHostsInFlight.get(host) || 0) + 1);

    probeImageSize(src)
      .then(({ width, height }) => saveImageDims(src, { w: width, h: height, at: Date.now() }))
      .catch(() => saveImageDims(src, { failed: true, at: Date.now() }))
      .finally(() => {
        activeProbes -= 1;
        probeHostsInFlight.set(host, probeHostsInFlight.get(host) - 1);
        probeQueued.delete(src);
        onImageProbed(src);
        pumpProbes();
      });
  }
}

// The host answered, and the answer is "this image is gone" — don't let
// the browser-decode fallback render whatever picture came with it.
class ImageGoneError extends Error {}

async function probeImageSize(src) {
  try {
    const size = await probeImageHeader(src);
    if (size) return size;
  } catch (e) {
    if (e instanceof ImageGoneError) throw e;
    // Network-level failure: some hosts refuse a plain fetch but serve an
    // <img> fine — fall through.
  }
  // Unparseable format (AVIF, HEIC, ...) or the fetch was refused: let the
  // browser load and decode it.
  return decodeImageSize(src);
}

// Reads the response stream only until the dimensions can be parsed.
async function probeImageHeader(src) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(src, { signal: controller.signal, credentials: "omit", referrerPolicy: "no-referrer" });
    // Some hosts send a 404 *with* a "deleted" image as the body (i.redd.it).
    if (!response.ok) throw new ImageGoneError(`HTTP ${response.status}`);
    if (response.redirected && PLACEHOLDER_URL.test(new URL(response.url).pathname)) {
      throw new ImageGoneError("Redirected to a placeholder: " + response.url);
    }
    const type = response.headers.get("content-type") || "";
    if (/^text\/html/i.test(type)) throw new ImageGoneError("Not an image");

    const reader = response.body.getReader();
    let bytes = new Uint8Array(0);
    while (bytes.length < PROBE_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (value) {
        const joined = new Uint8Array(bytes.length + value.length);
        joined.set(bytes);
        joined.set(value, bytes.length);
        bytes = joined;
      }
      const size = parseImageSize(bytes);
      if (size === UNSUPPORTED_IMAGE) return null;
      if (size) return size;
      if (done) return null;
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
    controller.abort(); // stop downloading the rest of the file
  }
}

function decodeImageSize(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timeoutId = setTimeout(() => reject(new Error("Timed out")), FETCH_TIMEOUT_MS * 2);
    img.onload = () => {
      clearTimeout(timeoutId);
      if (img.naturalWidth && img.naturalHeight) resolve({ width: img.naturalWidth, height: img.naturalHeight });
      else reject(new Error("Empty image"));
    };
    img.onerror = () => {
      clearTimeout(timeoutId);
      reject(new Error("Image failed to load"));
    };
    img.src = src;
  });
}

/* ---------- Image header parsing ---------- */

const UNSUPPORTED_IMAGE = { unsupported: true };

/** Returns { width, height }, null (need more bytes), or UNSUPPORTED_IMAGE. */
function parseImageSize(b) {
  const ascii = (i, n) => String.fromCharCode(...b.subarray(i, i + n));
  const u16le = (i) => b[i] | (b[i + 1] << 8);
  const u24le = (i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const u32be = (i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const i32le = (i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
  const size = (width, height) => (width > 0 && height > 0 ? { width, height } : UNSUPPORTED_IMAGE);

  if (b.length < 4) return null;
  if (b[0] === 0x89 && ascii(1, 3) === "PNG") return b.length < 24 ? null : size(u32be(16), u32be(20));
  if (ascii(0, 4) === "GIF8") return b.length < 10 ? null : size(u16le(6), u16le(8));
  if (b[0] === 0xff && b[1] === 0xd8) return parseJpegSize(b);
  if (ascii(0, 2) === "BM") return b.length < 26 ? null : size(i32le(18), Math.abs(i32le(22)));
  if (ascii(0, 4) === "RIFF") {
    if (b.length < 16) return null;
    if (ascii(8, 4) !== "WEBP") return UNSUPPORTED_IMAGE;
    const chunk = ascii(12, 4);
    if (b.length < (chunk === "VP8L" ? 25 : 30)) return null;
    if (chunk === "VP8 ") return size(u16le(26) & 0x3fff, u16le(28) & 0x3fff);
    if (chunk === "VP8L") {
      return size(
        1 + (((b[22] & 0x3f) << 8) | b[21]),
        1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6))
      );
    }
    if (chunk === "VP8X") return size(1 + u24le(24), 1 + u24le(27));
    return UNSUPPORTED_IMAGE;
  }

  // SVG is text: look for the <svg ...> tag in the first few KB.
  const text = new TextDecoder().decode(b.subarray(0, 8192));
  if (/^\s*</.test(text)) {
    const tag = text.match(/<svg\b[^>]*>/i);
    if (tag) return parseSvgSize(tag[0]);
    if (/<(!doctype\s+html|html|head|body)\b/i.test(text)) return UNSUPPORTED_IMAGE; // a web page
    return b.length < 8192 ? null : UNSUPPORTED_IMAGE;
  }
  return UNSUPPORTED_IMAGE; // AVIF, HEIC, ... — handled by decodeImageSize
}

function parseJpegSize(b) {
  const u16be = (i) => (b[i] << 8) | b[i + 1];
  let i = 2;
  let orientation = 0; // 0 = no EXIF orientation seen yet
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i += 1; continue; }
    const marker = b[i + 1];
    if (marker === 0xff) { i += 1; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; }
    const length = u16be(i + 2);
    if (marker === 0xe1 && !orientation) {
      if (i + 2 + length > b.length) return null; // need the whole EXIF block
      orientation = jpegExifOrientation(b, i + 4, i + 2 + length);
    }
    // SOFn markers carry the size (C4, C8 and CC are other things).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = u16be(i + 5);
      const width = u16be(i + 7);
      if (!width || !height) return UNSUPPORTED_IMAGE;
      // Orientations 5–8 are rotated 90°, and Firefox displays them rotated.
      return orientation >= 5 ? { width: height, height: width } : { width, height };
    }
    i += 2 + length;
  }
  return null;
}

function jpegExifOrientation(b, start, end) {
  if (String.fromCharCode(...b.subarray(start, start + 6)) !== "Exif\0\0") return 0;
  const tiff = start + 6;
  const little = b[tiff] === 0x49; // "II" = little-endian
  const u16 = (i) => (little ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]);
  const u32 = (i) => (little
    ? (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0
    : ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0);
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return 0;
  const entries = u16(ifd);
  for (let k = 0; k < entries; k++) {
    const entry = ifd + 2 + k * 12;
    if (entry + 12 > end) return 0;
    if (u16(entry) === 0x0112) return u16(entry + 8);
  }
  return 0;
}

function parseSvgSize(tag) {
  const attr = (name) => {
    const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']+)["']`, "i"));
    return m ? m[1] : null;
  };
  const px = (value) => (value && /^\s*[\d.]+\s*(px)?\s*$/.test(value) ? parseFloat(value) : 0);
  let width = px(attr("width"));
  let height = px(attr("height"));
  const viewBox = (attr("viewBox") || "").trim().split(/[\s,]+/).map(Number);
  if ((!width || !height) && viewBox.length === 4 && viewBox[2] > 0 && viewBox[3] > 0) {
    if (width) height = (width * viewBox[3]) / viewBox[2];
    else if (height) width = (height * viewBox[2]) / viewBox[3];
    else [width, height] = [viewBox[2], viewBox[3]];
  }
  return width > 0 && height > 0 ? { width, height } : UNSUPPORTED_IMAGE;
}


/* ============================================================
   Removing and restoring bookmarks
   ============================================================ */

function plural(n, one, many = one + "s") {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

// "12 bookmarks", "3 folders", "12 bookmarks and 2 folders" (separators aren't counted).
function itemsLabel(items) {
  const folders = items.filter((i) => i.kind === "folder").length;
  const bookmarks = items.filter((i) => (!i.kind || i.kind === "moved") && !isSeparatorItem(i)).length;
  if (folders && bookmarks) return `${plural(bookmarks, "bookmark")} and ${plural(folders, "folder")}`;
  return folders ? plural(folders, "folder") : plural(bookmarks, "bookmark");
}

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function formatDate(ts) {
  return ts ? dateFormatter.format(ts) : "unknown date";
}

/* ---------- Long-running jobs (bulk remove / restore) ----------
   Only one runs at a time. Work happens in small chunks with a yield to
   the browser in between, so the page keeps scrolling, typing and
   clicking normally; the job bar shows progress and a Cancel button. */

let currentJob = null; // { label, total, done, cancelled }

// A MessageChannel hop lets queued input/rendering run, and unlike
// setTimeout it isn't throttled to 1/s when this tab is in the background.
function yieldToBrowser() {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
  });
}

function startJob(label, total) {
  currentJob = { label, total, done: 0, cancelled: false, samples: [] };
  hideToast();
  jobLabel.textContent = label;
  jobCancelBtn.disabled = false;
  jobCancelBtn.textContent = "Cancel";
  jobBar.hidden = false;
  updateJobBar();
  if (activeTab === "cleanup") renderCleanup(); // disable the action buttons right away
  return currentJob;
}

function formatDuration(seconds) {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

let jobBarFrame = null;
function updateJobBar() {
  if (jobBarFrame || !currentJob) return;
  jobBarFrame = requestAnimationFrame(() => {
    jobBarFrame = null;
    const job = currentJob;
    if (!job) return;
    const { done, total, samples } = job;

    // Rate over the last ~10s, so the estimate follows Firefox's real speed.
    const now = performance.now();
    samples.push([now, done]);
    while (samples.length > 2 && now - samples[0][0] > 10000) samples.shift();
    const [t0, d0] = samples[0];
    const rate = now - t0 > 1000 ? ((done - d0) / (now - t0)) * 1000 : 0;

    let text = `${done.toLocaleString()} of ${total.toLocaleString()}`;
    if (rate > 0) text += ` · ${Math.round(rate).toLocaleString()}/s · ~${formatDuration((total - done) / rate)} left`;
    jobCount.textContent = text;
    jobFill.style.width = (total ? (done / total) * 100 : 0) + "%";
  });
}

function endJob() {
  currentJob = null;
  jobBar.hidden = true;
  scheduleBookmarksReload(); // reloads were held back while the job ran
  scheduleCleanupRender();
}

function jobBusyMessage() {
  showToast("Wait for the current operation to finish (or cancel it) first.");
}

// One getTree call instead of thousands of bookmarks.get calls.
async function getTreeIndex() {
  const [rootNode] = await browser.bookmarks.getTree();
  const nodes = new Map();
  const walk = (node) => {
    nodes.set(node.id, node);
    (node.children || []).forEach(walk);
  };
  walk(rootNode);
  return nodes;
}

const JOB_CHUNK = 25;      // starting batch size for bulk removes
const MIN_JOB_CHUNK = 5;
const MAX_JOB_CHUNK = 250;

// Firefox has no batch remove, and how many removes it can take at once
// depends on the machine, Sync, open bookmark windows... So measure:
// grow the batch while throughput keeps improving, back off when it drops.
// `best` decays slowly so a bigger batch gets re-tried later.
function tuneChunkSize(size, rate, best) {
  if (rate >= best * 0.95) return { size: Math.min(MAX_JOB_CHUNK, Math.ceil(size * 1.25)), best: Math.max(best, rate) };
  return { size: Math.max(MIN_JOB_CHUNK, Math.floor(size / 1.5)), best: best * 0.98 };
}

/**
 * Removes bookmarks from Firefox for real — but first records exactly
 * where each one lived (folder + position, plus the folder chain above it)
 * in the trash, and saves that BEFORE deleting anything. So every removal
 * can be undone, even after this page or the browser has been closed.
 *
 * Speed: Firefox's bookmarks.remove() gets very slow in big folders
 * (measured: ~8/s from a 3,600-bookmark folder vs ~230/s from a 500 one),
 * but moving a bookmark out of a big folder stays fast and removeTree()
 * deletes a whole folder in one call. So bookmarks are moved into a
 * staging folder that is deleted every STAGING_FLUSH moves (~270/s
 * measured in the 3,600 case — about 35× faster).
 */
async function removeBookmarks(bookmarks, reason) {
  if (currentJob) return jobBusyMessage();

  const job = startJob(`Removing ${plural(bookmarks.length, "bookmark")}…`, bookmarks.length);
  let batch = null;
  const removed = [];
  try {
    const nodes = await getTreeIndex();
    const folderPaths = new Map(bookmarks.map((b) => [b.id, b.folderPath]));
    const items = bookmarks
      .map((b) => nodes.get(b.id))
      .filter((node) => node && node.url && !isSeparatorNode(node))
      .map((node) => ({
        id: node.id,
        title: node.title,
        url: node.url,
        parentId: node.parentId,
        index: node.index,
        dateAdded: node.dateAdded || 0,
        folderPath: folderPaths.get(node.id) || "",
      }));
    if (items.length === 0) return;
    job.total = items.length;

    // Every folder above a removed bookmark, so a restore can rebuild any
    // that get deleted in the meantime (same name, same place).
    const folders = {};
    for (const item of items) {
      for (let id = item.parentId; id && !folders[id] && id !== ROOT_FOLDER_ID; ) {
        const folder = nodes.get(id);
        if (!folder) break;
        folders[id] = { title: folder.title, parentId: folder.parentId, index: folder.index };
        id = folder.parentId;
      }
    }

    batch = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, removedAt: Date.now(), reason, items, folders };
    trash.unshift(batch);
    try {
      await saveTrash();
    } catch (e) {
      trash.shift();
      batch = null;
      console.warn("Bookmark Gallery: could not save trash", e);
      showToast("Couldn't save an undo record, so nothing was removed.");
      return;
    }

    let staging = null;  // id of the current staging folder
    let staged = [];      // items moved into it, not yet deleted
    const flushStaging = async () => {
      if (!staging) return;
      await browser.bookmarks.removeTree(staging);
      removed.push(...staged);
      staged = [];
      staging = null;
      await browser.storage.local.remove(PENDING_REMOVAL_KEY);
    };

    let chunkSize = JOB_CHUNK;
    let bestRate = 0;
    try {
      for (let i = 0; i < items.length && !job.cancelled; ) {
        if (!staging) {
          staging = (await browser.bookmarks.create({ parentId: OTHER_BOOKMARKS_ID, title: STAGING_TITLE })).id;
          // Recorded first, so a closed page can finish the job next time.
          await browser.storage.local.set({ [PENDING_REMOVAL_KEY]: { folderId: staging, batchId: batch.id } });
        }
        const chunk = items.slice(i, i + chunkSize);
        const started = performance.now();
        const results = await Promise.allSettled(chunk.map((item) => browser.bookmarks.move(item.id, { parentId: staging })));
        results.forEach((result, k) => {
          if (result.status === "fulfilled") staged.push(chunk[k]);
          else console.warn("Bookmark Gallery: could not remove", chunk[k].url, result.reason);
        });
        ({ size: chunkSize, best: bestRate } = tuneChunkSize(chunkSize, chunk.length / Math.max(1, performance.now() - started), bestRate));
        i += chunk.length;
        if (staged.length >= STAGING_FLUSH) await flushStaging();
        job.done = i;
        updateJobBar();
        await yieldToBrowser();
      }
    } finally {
      // Also on cancel: whatever was already moved is deleted (it's in the trash).
      await flushStaging().catch((e) => console.warn("Bookmark Gallery: could not delete staging folder", e));
    }
  } finally {
    // The trash must list exactly what was actually removed.
    if (batch && removed.length < batch.items.length) {
      batch.items = removed;
      if (removed.length === 0) trash = trash.filter((b) => b !== batch);
      await saveTrash().catch((e) => console.warn("Bookmark Gallery: could not save trash", e));
    }
    removed.forEach((item) => brokenSelection.delete(item.id));
    endJob();
  }

  if (!batch) return;
  if (removed.length === 0) {
    showToast(job.cancelled ? "Cancelled — nothing was removed." : "Couldn't remove those bookmarks.");
    return;
  }
  const message = job.cancelled
    ? `Cancelled — removed ${removed.length.toLocaleString()} of ${job.total.toLocaleString()} bookmarks.`
    : `Removed ${plural(removed.length, "bookmark")}.`;
  showToast(message, () => restoreFromTrash(batch.id));
}

/**
 * Deletes folders that have no bookmarks anywhere inside them. Like
 * bookmark removal, the whole subtree (subfolders and separators, with
 * exact positions) is saved to the trash first, so it can be restored.
 */
async function deleteEmptyFolders(folderIds) {
  if (currentJob) return jobBusyMessage();
  const job = startJob(`Deleting ${plural(folderIds.length, "empty folder")}…`, folderIds.length);
  let batch = null;
  const deletedTops = new Set();
  const topOf = new Map(); // item id -> the deleted folder it lives under
  try {
    const nodes = await getTreeIndex();
    const hasBookmarks = (node) => (node.children || []).some((c) =>
      c.children ? hasBookmarks(c) : Boolean(c.url) && !isSeparatorNode(c) && !isBrokenSeparator(c));
    // Re-check against the live tree: only folders that are still empty.
    const tops = folderIds.filter((id) => {
      const node = nodes.get(id);
      return node && node.children && !BUILT_IN_FOLDERS.has(id) && !hasBookmarks(node);
    });
    if (tops.length === 0) return;
    job.total = tops.length;

    const items = [];
    const folders = {};
    const collect = (node, top) => {
      topOf.set(node.id, top);
      const base = { id: node.id, parentId: node.parentId, index: node.index, folderPath: (folderInfo.get(node.parentId) || {}).path || "" };
      if (node.children) {
        items.push({ ...base, kind: "folder", title: node.title });
        folders[node.id] = { title: node.title, parentId: node.parentId, index: node.index };
        node.children.forEach((child) => collect(child, top));
      } else if (isSeparatorNode(node) || isBrokenSeparator(node)) {
        items.push({ ...base, kind: "separator", title: "" });
      }
    };
    for (const id of tops) {
      collect(nodes.get(id), id);
      // ...and the folders above it, in case those get deleted later too.
      for (let up = nodes.get(id).parentId; up && !folders[up] && up !== ROOT_FOLDER_ID; up = nodes.get(up).parentId) {
        const folder = nodes.get(up);
        folders[up] = { title: folder.title, parentId: folder.parentId, index: folder.index };
      }
    }

    batch = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, removedAt: Date.now(), reason: "Empty folders", items, folders };
    trash.unshift(batch);
    try {
      await saveTrash();
    } catch (e) {
      trash.shift();
      batch = null;
      console.warn("Bookmark Gallery: could not save trash", e);
      showToast("Couldn't save an undo record, so nothing was deleted.");
      return;
    }

    // Deleting a later folder first keeps earlier siblings' positions valid.
    const ordered = tops.slice().sort((a, b) => nodes.get(b).index - nodes.get(a).index);
    for (const id of ordered) {
      if (job.cancelled) break;
      try {
        await browser.bookmarks.removeTree(id);
        deletedTops.add(id);
      } catch (e) {
        console.warn("Bookmark Gallery: could not delete folder", id, e);
      }
      job.done += 1;
      updateJobBar();
      if (job.done % JOB_CHUNK === 0) await yieldToBrowser();
    }
  } finally {
    if (batch && deletedTops.size < job.total) {
      batch.items = batch.items.filter((item) => deletedTops.has(topOf.get(item.id)));
      if (batch.items.length === 0) trash = trash.filter((b) => b !== batch);
      await saveTrash().catch((e) => console.warn("Bookmark Gallery: could not save trash", e));
    }
    endJob();
  }

  if (!batch) return;
  if (deletedTops.size === 0) {
    showToast(job.cancelled ? "Cancelled — nothing was deleted." : "Couldn't delete those folders.");
    return;
  }
  showToast(`Deleted ${plural(deletedTops.size, "empty folder")}.`, () => restoreFromTrash(batch.id));
}

// Turns blank "data:" bookmarks (separators mangled by older versions) back
// into real separators at the same position: insert a separator just before
// each one, then remove it — so every other position stays the same.
async function repairBrokenSeparators() {
  if (currentJob) return jobBusyMessage();
  const nodes = await getTreeIndex();
  const broken = [...nodes.values()].filter(isBrokenSeparator);
  if (broken.length === 0) return;
  const job = startJob(`Repairing ${plural(broken.length, "separator")}…`, broken.length);
  let fixed = 0;
  try {
    for (const node of broken) {
      if (job.cancelled) break;
      try {
        const [current] = await browser.bookmarks.get(node.id);
        await browser.bookmarks.create({ parentId: current.parentId, index: current.index, type: "separator" });
        await browser.bookmarks.remove(current.id);
        fixed += 1;
      } catch (e) {
        console.warn("Bookmark Gallery: could not repair separator", node.id, e);
      }
      job.done += 1;
      updateJobBar();
      if (job.done % JOB_CHUNK === 0) await yieldToBrowser();
    }
  } finally {
    endJob();
  }
  showToast(fixed === 1 ? "Turned 1 blank entry back into a separator line." : `Turned ${fixed.toLocaleString()} blank entries back into separator lines.`);
}

// Restores must keep each folder's items in order, so one folder is done
// sequentially; this many folders run side by side.
const RESTORE_WORKERS = 8;

async function restoreFromTrash(batchId, itemIds = null) {
  if (currentJob) return jobBusyMessage();
  const batch = trash.find((b) => b.id === batchId);
  if (!batch) return;

  const wantedIds = itemIds && new Set(itemIds);
  const wanted = wantedIds ? batch.items.filter((i) => wantedIds.has(i.id)) : batch.items;
  const allMoves = wanted.length > 0 && wanted.every((i) => i.kind === "moved");
  const job = startJob(allMoves ? `Moving ${plural(wanted.length, "bookmark")} back…` : `Restoring ${itemsLabel(wanted)}…`, wanted.length);
  const restored = new Set();
  let movedToOther = 0;
  let foldersRecreated = 0;
  let failed = 0;

  // Drop restored items from the trash and persist; done periodically so
  // closing the page mid-restore can't leave already-restored items in it.
  const persist = () => {
    batch.items = batch.items.filter((i) => !restored.has(i.id));
    if (batch.items.length === 0) trash = trash.filter((b) => b !== batch);
    return Promise.all([saveTrash(), saveFolderRemap()]).catch((e) => console.warn("Bookmark Gallery: could not save trash", e));
  };

  try {
    const nodes = await getTreeIndex();
    const childCounts = new Map(); // folder id -> current number of children
    const childCount = (id) => (childCounts.has(id) ? childCounts.get(id) : (nodes.get(id).children || []).length);
    const recreating = new Map();  // old folder id -> Promise<new id>, shared by all workers

    // The folder an item belongs in: the original if it still exists, one
    // recreated earlier (folderRemap), or rebuilt now from the batch's
    // folder records — recursively, so a whole deleted branch comes back.
    const resolveFolder = (oldId) => {
      if (nodes.has(oldId)) return Promise.resolve(oldId);
      const remapped = folderRemap[oldId];
      if (remapped && nodes.has(remapped)) return Promise.resolve(remapped);
      const info = batch.folders && batch.folders[oldId];
      if (!info) return Promise.resolve(null);
      if (!recreating.has(oldId)) {
        recreating.set(oldId, (async () => {
          const parentId = await resolveFolder(info.parentId);
          if (!parentId) return null;
          const count = childCount(parentId);
          const folder = await browser.bookmarks.create({ parentId, title: info.title, index: Math.min(info.index, count) });
          childCounts.set(parentId, count + 1);
          nodes.set(folder.id, { ...folder, children: [] });
          folderRemap[oldId] = folder.id;
          foldersRecreated += 1;
          return folder.id;
        })().catch((e) => {
          console.warn("Bookmark Gallery: could not recreate folder", info.title, e);
          return null;
        }));
      }
      return recreating.get(oldId);
    };

    // A bookmark whose original id still exists was never actually removed
    // (e.g. the page closed mid-removal) — just clear it from the trash.
    // If it's stranded in a staging folder, move it back where it was.
    const isStaging = (id) => nodes.has(id) && nodes.get(id).title === STAGING_TITLE;
    const toCreate = [];
    for (const item of wanted) {
      const node = nodes.get(item.id);
      if (item.kind === "moved") {
        // Moved by Smart cleanup: move it back — unless it's gone since,
        // or already back where it was.
        if (node && node.parentId !== (folderRemap[item.parentId] || item.parentId)) toCreate.push(item);
        else restored.add(item.id);
        continue;
      }
      if (!node) {
        toCreate.push(item);
        continue;
      }
      if (isStaging(node.parentId)) {
        const parentId = await resolveFolder(item.parentId);
        await browser.bookmarks.move(item.id, parentId ? { parentId, index: Math.min(item.index, childCount(parentId)) } : { parentId: OTHER_BOOKMARKS_ID });
        if (parentId) childCounts.set(parentId, childCount(parentId) + 1);
      }
      restored.add(item.id);
    }
    job.done = restored.size;

    // Restore each folder's items in ascending original position, so the
    // earlier ones are back in place before the later indexes are used.
    const byFolder = new Map();
    for (const item of toCreate) {
      if (!byFolder.has(item.parentId)) byFolder.set(item.parentId, []);
      byFolder.get(item.parentId).push(item);
    }
    let folderQueues = [...byFolder.values()].map((items) => items.sort((a, b) => a.index - b.index));

    // Deleted folders/separators: one ordered pass instead — level by level
    // (parents before children), siblings by position — so parallel workers
    // can't recreate a folder before an earlier sibling and shift it by one.
    // Moving bookmarks back: one sequential stream, folder by folder in
    // position order. Firefox can misplace concurrent moves that come out of
    // the same folder (measured: a 5,000-bookmark undo landed some items two
    // positions early when run in parallel) — creates don't have that problem.
    if (toCreate.some((item) => item.kind === "moved")) {
      folderQueues = [toCreate.slice().sort((a, b) => a.parentId.localeCompare(b.parentId) || a.index - b.index)];
    }

    if (toCreate.some((item) => item.kind === "folder" || item.kind === "separator")) {
      const ids = new Set(toCreate.map((item) => item.id));
      const ordered = [];
      let level = toCreate.filter((item) => !ids.has(item.parentId));
      while (level.length) {
        level.sort((a, b) => a.parentId.localeCompare(b.parentId) || a.index - b.index);
        ordered.push(...level);
        const parents = new Set(level.map((item) => item.id));
        level = toCreate.filter((item) => parents.has(item.parentId));
      }
      folderQueues = [ordered];
    }

    const restoreOne = async (item) => {
      if (item.kind === "moved") {
        const parentId = await resolveFolder(item.parentId);
        if (parentId) {
          const count = childCount(parentId);
          await browser.bookmarks.move(item.id, { parentId, index: Math.min(item.index, count) });
          childCounts.set(parentId, count + 1);
        } else {
          await browser.bookmarks.move(item.id, { parentId: OTHER_BOOKMARKS_ID });
          movedToOther += 1;
        }
        return;
      }
      // A deleted folder comes back through resolveFolder (its record is in
      // batch.folders), so it's created exactly once even if a child item
      // already needed it rebuilt.
      if (item.kind === "folder") {
        if (!(await resolveFolder(item.id))) throw new Error("Could not recreate folder");
        return;
      }
      const separator = isSeparatorItem(item);
      const details = separator ? { type: "separator" } : { title: item.title, url: item.url };
      const parentId = await resolveFolder(item.parentId);
      if (!parentId && separator) return; // nowhere sensible to put it
      if (parentId) {
        const count = childCount(parentId);
        try {
          await browser.bookmarks.create({ parentId, index: Math.min(item.index, count), ...details });
          childCounts.set(parentId, count + 1);
          return;
        } catch (e) {
          // Folder changed underneath us — append instead.
          try {
            await browser.bookmarks.create({ parentId, title: item.title, url: item.url });
            return;
          } catch (e2) {
            // Folder is gone after all — fall through.
          }
        }
      }
      // Couldn't put it back where it was (e.g. an old trash entry without
      // folder records) — keep it safe in "Other Bookmarks".
      await browser.bookmarks.create({ parentId: OTHER_BOOKMARKS_ID, title: item.title, url: item.url });
      movedToOther += 1;
    };

    let lastSave = Date.now();
    const worker = async () => {
      while (folderQueues.length && !job.cancelled) {
        const queue = folderQueues.shift();
        for (const item of queue) {
          if (job.cancelled) break;
          try {
            await restoreOne(item);
            restored.add(item.id);
          } catch (e) {
            failed += 1;
            console.warn("Bookmark Gallery: could not restore", item.url, e);
          }
          job.done += 1;
          updateJobBar();
          if (job.done % JOB_CHUNK === 0) await yieldToBrowser();
          if (Date.now() - lastSave > 2000) {
            lastSave = Date.now();
            persist();
          }
        }
      }
    };
    await Promise.all(Array.from({ length: RESTORE_WORKERS }, worker));
    // A fully undone Smart cleanup also removes the folders it created, if empty.
    if (batch.createdFolders && batch.items.every((i) => restored.has(i.id))) {
      for (const id of [...batch.createdFolders].reverse()) {
        const children = await browser.bookmarks.getChildren(id).catch(() => null);
        if (children && children.length === 0) await browser.bookmarks.remove(id).catch(() => {});
      }
    }
  } finally {
    await persist();
    endJob();
  }

  const restoredItems = wanted.filter((i) => restored.has(i.id));
  const deletedFoldersBack = restoredItems.filter((i) => i.kind === "folder").length;
  let message = job.cancelled
    ? `Cancelled — restored ${restored.size.toLocaleString()} of ${wanted.length.toLocaleString()}; the rest are still in Recently removed.`
    : allMoves ? `Moved ${plural(restoredItems.length, "bookmark")} back to where they were.`
    : `Restored ${itemsLabel(restoredItems)}.`;
  const rebuiltForBookmarks = foldersRecreated - deletedFoldersBack;
  if (rebuiltForBookmarks > 0) message += ` Recreated ${plural(rebuiltForBookmarks, "deleted folder")} to put them back in.`;
  if (movedToOther) message += ` ${movedToOther.toLocaleString()} went to "Other Bookmarks" because their folder couldn't be rebuilt.`;
  if (failed) message += ` ${failed.toLocaleString()} couldn't be restored.`;
  showToast(message);
}

// Bulk actions take two clicks: the first arms the button, the second
// (within 4s) runs it. No modal dialogs, and a stray click does nothing.
function confirmClick(button, armedLabel, action) {
  if (button.dataset.armed === "1") {
    disarmButton(button);
    action();
    return;
  }
  button.dataset.armed = "1";
  button.dataset.label = button.textContent;
  button.textContent = armedLabel;
  button.classList.add("armed");
  button.disarmTimer = setTimeout(() => disarmButton(button), 4000);
}

function disarmButton(button) {
  clearTimeout(button.disarmTimer);
  if (button.dataset.armed !== "1") return;
  button.dataset.armed = "";
  button.textContent = button.dataset.label;
  button.classList.remove("armed");
}

// Re-renders shouldn't clobber the "click again" text of an armed button.
function setButtonLabel(button, label) {
  if (button.dataset.armed === "1") button.dataset.label = label;
  else button.textContent = label;
}

/* ============================================================
   Toast (with Undo)
   ============================================================ */

function showToast(message, undoAction = null) {
  toastMessage.textContent = message;
  toastUndoAction = undoAction;
  toastUndoBtn.hidden = !undoAction;
  toastEl.hidden = false;
  clearTimeout(toastTimerId);
  toastTimerId = setTimeout(hideToast, TOAST_MS);
}

function hideToast() {
  clearTimeout(toastTimerId);
  toastEl.hidden = true;
  toastUndoAction = null;
}

/* ============================================================
   Clean up tab: duplicates, broken links, trash
   ============================================================ */

// Two bookmarks are duplicates when they point at the same page, ignoring
// http vs https, "www.", a trailing slash, tracking params, and #anchors.
function normalizeUrlForDupes(url) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return url;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return url;

  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname.replace(/\/+$/, "");
  const params = [...u.searchParams].filter(([key]) => !TRACKING_PARAM.test(key));
  const query = params.length ? "?" + new URLSearchParams(params).toString() : "";
  // "#/page" and "#!/page" are real routes in single-page apps; plain #anchors aren't.
  const hash = /^#!?\//.test(u.hash) ? u.hash : "";
  return `${host}${u.port ? ":" + u.port : ""}${path}${query}${hash}`;
}

let dupeGroupsCache = { source: null, groups: [] }; // recomputed only when allBookmarks is reloaded

function findDuplicateGroups() {
  if (dupeGroupsCache.source === allBookmarks) return dupeGroupsCache.groups;
  const map = new Map();
  for (const b of allBookmarks) {
    const key = normalizeUrlForDupes(b.url);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(b);
  }
  const groups = [...map.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([key, items]) => ({ key, items }))
    .sort((a, b) => b.items.length - a.items.length || a.key.localeCompare(b.key));
  dupeGroupsCache = { source: allBookmarks, groups };
  return groups;
}

// The copy to keep: whichever the user picked; otherwise one filed in a
// folder of their own (a loose copy in Bookmarks Menu/Toolbar/Other is
// usually the unsorted quick-save, the filed one is the organised one —
// keeping the loose one is what emptied folders); then the oldest.
function keeperIdFor(group) {
  const chosen = dupeKeepChoice.get(group.key);
  if (chosen && group.items.some((b) => b.id === chosen)) return chosen;
  const filed = (b) => (b.folderDepth >= 2 ? 0 : 1);
  return group.items.reduce((best, b) =>
    filed(b) < filed(best) || (filed(b) === filed(best) && b.dateAdded < best.dateAdded) ? b : best
  ).id;
}

// Folders that removing `extras` would leave with nothing in them.
function foldersEmptiedBy(extras) {
  const remaining = new Map();
  for (const b of allBookmarks) remaining.set(b.parentId, (remaining.get(b.parentId) || 0) + 1);
  for (const b of extras) remaining.set(b.parentId, remaining.get(b.parentId) - 1);
  return [...new Set(extras.map((b) => b.parentId))]
    .filter((id) => remaining.get(id) === 0 && folderInfo.has(id) && !folderInfo.get(id).hasSubfolders && !BUILT_IN_FOLDERS.has(id))
    .map((id) => folderInfo.get(id).name);
}

function extrasFor(group) {
  const keepId = keeperIdFor(group);
  return group.items.filter((b) => b.id !== keepId);
}

const recheckingUrls = new Set(); // broken links being re-checked, kept in the list meanwhile

function getBrokenBookmarks() {
  return allBookmarks.filter((b) => {
    const record = readCache(b.url);
    if (!record) return false;
    if (record.status === "error") return true;
    return record.status === "loading" && recheckingUrls.has(b.url);
  });
}

// 404/410 and "can't connect at all" (dead domain, refused connection)
// are very likely gone for good. 403/429/5xx/timeouts often just mean the
// site blocks automated requests — the page may still work in a browser.
// "Site unreachable" — Firefox says "NetworkError when attempting to fetch
// resource.", Chrome says "Failed to fetch".
const NETWORK_ERROR = /NetworkError|Failed to fetch/i;

function isLikelyDead(record) {
  return record.status === "error" && (/HTTP (404|410)\b/.test(record.error || "") || NETWORK_ERROR.test(record.error || ""));
}

function describeFailure(record) {
  if (record.status === "loading") return "Checking…";
  const err = record.error || "";
  if (/HTTP (404|410)\b/.test(err)) return `Page not found (${err.match(/\d{3}/)[0]})`;
  if (NETWORK_ERROR.test(err)) return "Site unreachable — domain gone or connection refused";
  if (/abort/i.test(err)) return "Timed out — the site may just be slow";
  if (/bot check/i.test(err)) return "Site shows a bot check to automated requests — the page itself may be fine";
  if (/HTTP (401|403|429)\b/.test(err)) return `Blocked or rate-limited (${err.match(/\d{3}/)[0]}) — may still work in a browser`;
  if (/HTTP 5\d\d\b/.test(err)) return `Server error (${err.match(/\d{3}/)[0]}) — may be temporary`;
  return err || "Failed to load";
}

let cleanupNeedsFullRender = false;

// `onlyBroken`: a finished fetch can only change the broken-links list,
// so skip rebuilding duplicates and trash for it.
function scheduleCleanupRender({ onlyBroken = false } = {}) {
  if (activeTab !== "cleanup") return;
  if (!onlyBroken) cleanupNeedsFullRender = true;
  if (cleanupRenderScheduled) return;
  cleanupRenderScheduled = true;
  setTimeout(() => {
    cleanupRenderScheduled = false;
    const full = cleanupNeedsFullRender;
    cleanupNeedsFullRender = false;
    if (activeTab !== "cleanup") return;
    if (full) renderCleanup();
    else renderBroken();
  }, HEAVY_RENDER_MS);
}

function renderRepair() {
  repairSection.hidden = brokenSeparatorCount === 0;
  repairSummary.textContent =
    `${plural(brokenSeparatorCount, "separator line")} in your bookmarks ${brokenSeparatorCount === 1 ? "was" : "were"} turned into ` +
    `blank "data:" bookmarks by an earlier version of this extension (removing and restoring them). ` +
    `This puts real separators back in the same spots.`;
  repairBtn.disabled = Boolean(currentJob);
}

// ---------- Smart cleanup ----------

function isWithinFolder(folderId, ancestorId) {
  for (let id = folderId; id; id = (folderInfo.get(id) || {}).parentId) if (id === ancestorId) return true;
  return false;
}

function smartRootId() {
  for (const [id, info] of folderInfo) if (info.parentId === OTHER_BOOKMARKS_ID && info.name === SMART_ROOT_TITLE) return id;
  return null;
}

// What Smart cleanup would move. Never toolbar items (those are the user's
// toolbar buttons) and never anything already filed under Smart Cleanup.
function smartCleanupCandidates(scope) {
  const rootId = smartRootId();
  return allBookmarks.filter((b) => {
    if (b.parentId === TOOLBAR_ID) return false;
    if (rootId && isWithinFolder(b.parentId, rootId)) return false;
    return scope === "everything" || SMART_LOOSE_PARENTS.has(b.parentId);
  });
}

const smartFolderFor = (bookmark) => {
  const category = getCategoryForBookmark(bookmark);
  return category === "Other" ? UNCATEGORIZED_TITLE : category;
};

function renderSmartCleanup() {
  const candidates = smartCleanupCandidates(smartScope);
  const counts = new Map();
  let guessed = 0;
  for (const b of candidates) {
    const name = smartFolderFor(b);
    counts.set(name, (counts.get(name) || 0) + 1);
    const record = readCache(b.url);
    if (!record || record.status !== "ok") guessed += 1;
  }

  let summary = candidates.length
    ? `${plural(candidates.length, "bookmark")} would move into Other Bookmarks › ${SMART_ROOT_TITLE}, one folder per category; ` +
      `anything without a clear category goes to "${UNCATEGORIZED_TITLE}". Every move is recorded, so it can be undone exactly.`
    : smartScope === "loose" ? "No loose bookmarks to reorganize." : "Nothing to reorganize.";
  if (guessed) {
    summary += ` ${plural(guessed, "of them hasn't", "of them haven't")} been checked yet, so ${guessed === 1 ? "its category is a guess" : "their categories are guesses"} from the address and title — "Check remaining" in the header makes this more accurate.`;
  }
  if (smartScope === "everything" && candidates.length) {
    const emptied = foldersEmptiedBy(candidates);
    if (emptied.length) summary += ` This would leave ${plural(emptied.length, "of your folders", "of your folders")} empty.`;
  }
  smartSummary.textContent = summary;
  smartSummary.classList.toggle("warn", smartScope === "everything" && candidates.length > 0);

  smartPlan.replaceChildren(...SMART_CATEGORY_ORDER.filter((name) => counts.has(name)).map((name) => {
    const chip = document.createElement("span");
    chip.className = "smart-chip" + (name === UNCATEGORIZED_TITLE ? " uncategorized" : "");
    const count = document.createElement("b");
    count.textContent = counts.get(name).toLocaleString();
    chip.append(name + " ", count);
    return chip;
  }));

  setButtonLabel(smartRunBtn, `Reorganize ${plural(candidates.length, "bookmark")}`);
  smartRunBtn.disabled = candidates.length === 0 || Boolean(currentJob);
}

/**
 * Moves bookmarks into Smart Cleanup › <category> folders. Like removals,
 * every bookmark's original folder and position is saved to the trash
 * first, so "Move back" (or Undo) puts each one back exactly.
 */
async function runSmartCleanup(scope) {
  if (currentJob) return jobBusyMessage();
  const candidates = smartCleanupCandidates(scope);
  if (candidates.length === 0) return;
  const job = startJob(`Reorganizing ${plural(candidates.length, "bookmark")}…`, candidates.length);
  let batch = null;
  const moved = new Set();
  try {
    const nodes = await getTreeIndex();
    const createdFolders = [];
    const ensureFolder = async (parentId, title) => {
      const existing = (nodes.get(parentId).children || []).find((c) => c.children && c.title === title);
      if (existing) return existing.id;
      const folder = await browser.bookmarks.create({ parentId, title });
      const node = { ...folder, children: [] };
      nodes.get(parentId).children.push(node);
      nodes.set(folder.id, node);
      createdFolders.push(folder.id);
      return folder.id;
    };

    const plan = new Map(); // category folder name -> items, in Firefox's order
    for (const b of candidates) {
      const node = nodes.get(b.id);
      if (!node) continue;
      const name = smartFolderFor(b);
      if (!plan.has(name)) plan.set(name, []);
      plan.get(name).push({
        kind: "moved", id: node.id, title: node.title, url: node.url,
        parentId: node.parentId, index: node.index, dateAdded: node.dateAdded || 0, folderPath: b.folderPath,
      });
    }
    const items = [...plan.values()].flat();
    if (items.length === 0) return;
    job.total = items.length;

    // The folders above each bookmark, so moving back can rebuild any that
    // get deleted in the meantime.
    const folders = {};
    for (const item of items) {
      for (let id = item.parentId; id && !folders[id] && id !== ROOT_FOLDER_ID; ) {
        const folder = nodes.get(id);
        if (!folder) break;
        folders[id] = { title: folder.title, parentId: folder.parentId, index: folder.index };
        id = folder.parentId;
      }
    }

    const rootId = await ensureFolder(OTHER_BOOKMARKS_ID, SMART_ROOT_TITLE);
    const destIds = new Map();
    for (const name of SMART_CATEGORY_ORDER) if (plan.has(name)) destIds.set(name, await ensureFolder(rootId, name));

    batch = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, removedAt: Date.now(), reason: "Smart cleanup", kind: "moves", items, folders, createdFolders };
    trash.unshift(batch);
    try {
      await saveTrash();
    } catch (e) {
      trash.shift();
      batch = null;
      console.warn("Bookmark Gallery: could not save trash", e);
      showToast("Couldn't save an undo record, so nothing was moved.");
      return;
    }

    // Each category folder is filled in order (appending keeps Firefox's
    // original order). One move at a time: concurrent moves out of the same
    // folder can be misplaced by Firefox (see restoreFromTrash).
    const queues = [...plan.entries()].map(([name, list]) => ({ dest: destIds.get(name), list }));
    const worker = async () => {
      while (queues.length && !job.cancelled) {
        const { dest, list } = queues.shift();
        for (const item of list) {
          if (job.cancelled) break;
          try {
            await browser.bookmarks.move(item.id, { parentId: dest });
            moved.add(item.id);
          } catch (e) {
            console.warn("Bookmark Gallery: could not move", item.url, e);
          }
          job.done += 1;
          updateJobBar();
          if (job.done % JOB_CHUNK === 0) await yieldToBrowser();
        }
      }
    };
    await worker();
  } finally {
    // The trash must list exactly what was actually moved.
    if (batch && moved.size < batch.items.length) {
      batch.items = batch.items.filter((item) => moved.has(item.id));
      if (batch.items.length === 0) trash = trash.filter((b) => b !== batch);
      await saveTrash().catch((e) => console.warn("Bookmark Gallery: could not save trash", e));
    }
    endJob();
  }

  if (!batch) return;
  if (moved.size === 0) {
    showToast(job.cancelled ? "Cancelled — nothing was moved." : "Couldn't move those bookmarks.");
    return;
  }
  const message = job.cancelled
    ? `Cancelled — moved ${moved.size.toLocaleString()} of ${job.total.toLocaleString()} bookmarks into ${SMART_ROOT_TITLE}.`
    : `Moved ${plural(moved.size, "bookmark")} into Other Bookmarks › ${SMART_ROOT_TITLE}.`;
  showToast(message, () => restoreFromTrash(batch.id));
}

function renderCleanup() {
  renderRepair();
  renderSmartCleanup();
  renderDuplicates();
  renderBroken();
  renderEmptyFolders();
  renderTrash();
}


// Every empty folder in Firefox, with whatever of its bookmarks is sitting
// in the trash (across all batches) — so it's clear why it's empty and one
// click puts its bookmarks back.
function getEmptyFolders() {
  const reverseRemap = new Map(Object.entries(folderRemap).map(([oldId, newId]) => [newId, oldId]));
  const trashed = new Map(); // folder id -> [{ batch, item }]
  for (const batch of trash) {
    for (const item of batch.items) {
      if (item.kind === "folder" || isSeparatorItem(item)) continue; // only bookmarks explain why a folder is empty
      const folderId = folderRemap[item.parentId] || item.parentId;
      if (!trashed.has(folderId)) trashed.set(folderId, []);
      trashed.get(folderId).push({ batch, item });
    }
  }
  // "Empty" = no bookmarks anywhere inside. Only the outermost such folder
  // is listed; its empty subfolders go with it.
  const isEmpty = (id) => {
    const info = folderInfo.get(id);
    return info && info.bookmarkCount === 0 && !BUILT_IN_FOLDERS.has(id) && info.name !== STAGING_TITLE;
  };
  return [...folderInfo.entries()]
    .filter(([id, info]) => isEmpty(id) && !isEmpty(info.parentId))
    .map(([id, info]) => ({ id, ...info, trashed: trashed.get(id) || trashed.get(reverseRemap.get(id)) || [] }))
    .sort((a, b) => b.trashed.length - a.trashed.length || a.path.localeCompare(b.path));
}

// Restores entries that may span several trash batches, one batch at a time.
async function restoreEntries(entries) {
  if (currentJob) return jobBusyMessage();
  const byBatch = new Map();
  for (const { batch, item } of entries) {
    if (!byBatch.has(batch.id)) byBatch.set(batch.id, []);
    byBatch.get(batch.id).push(item.id);
  }
  for (const [batchId, itemIds] of byBatch) await restoreFromTrash(batchId, itemIds);
}

let emptyFoldersShown = CLEANUP_PAGE_SIZE;

function renderEmptyFolders() {
  const folders = getEmptyFolders();
  const restorable = folders.filter((f) => f.trashed.length);
  const restorableCount = restorable.reduce((n, f) => n + f.trashed.length, 0);

  emptyFoldersSummary.textContent = folders.length === 0
    ? "No empty folders."
    : `${plural(folders.length, "folder")} in Firefox ${folders.length === 1 ? "is" : "are"} empty. ` +
      (restorable.length
        ? `${restorable.length === folders.length ? "All" : restorable.length.toLocaleString()} of them have bookmarks in Recently removed (${plural(restorableCount, "bookmark")}) that can go straight back.`
        : "None of their bookmarks are in Recently removed — they were empty already or emptied outside this tab.");
  setButtonLabel(emptyFoldersRestoreBtn, `Restore into all empty folders (${restorableCount.toLocaleString()})`);
  emptyFoldersRestoreBtn.disabled = restorableCount === 0 || Boolean(currentJob);
  setButtonLabel(emptyFoldersDeleteBtn, `Delete all empty folders (${folders.length.toLocaleString()})`);
  emptyFoldersDeleteBtn.disabled = folders.length === 0 || Boolean(currentJob);

  emptyFoldersList.innerHTML = "";
  folders.slice(0, emptyFoldersShown).forEach((folder) => {
    const row = document.createElement("div");
    row.className = "cleanup-item";

    const body = document.createElement("div");
    body.className = "cleanup-item-body";
    const title = document.createElement("p");
    title.className = "cleanup-title";
    title.textContent = "📁 " + folder.name;
    const meta = document.createElement("p");
    meta.className = "cleanup-meta";
    if (folder.trashed.length) {
      const reasons = [...new Set(folder.trashed.map(({ batch }) => `${batch.reason}, ${formatDate(batch.removedAt)}`))];
      meta.textContent = `${folder.path} · ${plural(folder.trashed.length, "bookmark")} in Recently removed (${reasons.slice(0, 2).join("; ")}${reasons.length > 2 ? "; …" : ""})`;
    } else {
      meta.textContent = `${folder.path} · nothing from this folder is in Recently removed`;
    }
    body.append(title, meta);
    row.appendChild(body);

    if (folder.folderCount) meta.textContent += ` · contains ${plural(folder.folderCount, "empty subfolder")}`;
    const del = document.createElement("button");
    del.className = "btn btn-ghost btn-small";
    del.textContent = "Delete";
    del.title = "Delete this empty folder (can be undone)";
    del.disabled = Boolean(currentJob);
    del.addEventListener("click", () => deleteEmptyFolders([folder.id]));
    row.appendChild(del);

    if (folder.trashed.length) {
      const restore = document.createElement("button");
      restore.className = "btn btn-secondary btn-small";
      restore.textContent = `Restore ${folder.trashed.length.toLocaleString()}`;
      restore.disabled = Boolean(currentJob);
      restore.addEventListener("click", () => restoreEntries(folder.trashed));
      row.appendChild(restore);
    }
    emptyFoldersList.appendChild(row);
  });
  appendShowMore(emptyFoldersList, emptyFoldersShown, folders.length, () => {
    emptyFoldersShown += CLEANUP_PAGE_SIZE;
    renderEmptyFolders();
  });
}

function buildCleanupItem(bookmark, detail) {
  const body = document.createElement("div");
  body.className = "cleanup-item-body";

  const title = document.createElement("p");
  title.className = "cleanup-title";
  title.textContent = bookmark.title;

  const meta = document.createElement("p");
  meta.className = "cleanup-meta";
  meta.textContent = [bookmark.folderPath, detail].filter(Boolean).join(" · ");

  if (bookmark.kind === "folder") title.textContent = "📁 " + bookmark.title;
  if (bookmark.kind === "separator") title.textContent = "— separator —";
  body.append(title, meta);

  if (bookmark.url) {
    const link = document.createElement("a");
    link.className = "cleanup-url";
    link.href = bookmark.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = bookmark.url;
    body.appendChild(link);
  }
  return body;
}

// Large collections can have thousands of entries; render a page at a
// time so re-renders (one per finished fetch) stay cheap.
function appendShowMore(listEl, shown, total, onMore) {
  if (shown >= total) return;
  const btn = document.createElement("button");
  btn.className = "btn btn-ghost cleanup-more";
  btn.textContent = `Show ${Math.min(CLEANUP_PAGE_SIZE, total - shown)} more (${total - shown} not shown)`;
  btn.addEventListener("click", onMore);
  listEl.appendChild(btn);
}

function renderDuplicates() {
  const groups = findDuplicateGroups();
  const extraCount = groups.reduce((n, g) => n + g.items.length - 1, 0);

  let summary = groups.length
    ? `${plural(groups.length, "page")} bookmarked more than once — ${plural(extraCount, "extra copy", "extra copies")}. ` +
      `Copies filed in your own folders are kept over loose ones (then the oldest), unless you pick another.`
    : "No duplicates found.";
  const emptied = groups.length ? foldersEmptiedBy(groups.flatMap(extrasFor)) : [];
  if (emptied.length) {
    const names = emptied.slice(0, 6).map((n) => `"${n}"`).join(", ");
    summary += ` Heads up: removing them all would leave ${plural(emptied.length, "folder")} empty (${names}${emptied.length > 6 ? ", …" : ""}).`;
  }
  dupesSummary.textContent = summary;
  dupesSummary.classList.toggle("warn", emptied.length > 0);
  setButtonLabel(dupesRemoveAllBtn, `Remove all extra copies (${extraCount})`);
  dupesRemoveAllBtn.disabled = extraCount === 0 || Boolean(currentJob);

  dupesList.innerHTML = "";
  groups.slice(0, dupesShown).forEach((group) => {
    const keepId = keeperIdFor(group);
    const card = document.createElement("div");
    card.className = "cleanup-card";

    const head = document.createElement("div");
    head.className = "cleanup-card-head";
    const key = document.createElement("span");
    key.className = "cleanup-card-title";
    key.textContent = group.key;
    const removeBtn = document.createElement("button");
    removeBtn.className = "btn btn-ghost btn-small";
    removeBtn.textContent = `Remove ${plural(group.items.length - 1, "extra copy", "extra copies")}`;
    removeBtn.disabled = Boolean(currentJob);
    removeBtn.addEventListener("click", () => removeBookmarks(extrasFor(group), "Duplicate"));
    head.append(key, removeBtn);
    card.appendChild(head);

    group.items.forEach((bookmark) => {
      const row = document.createElement("label");
      row.className = "cleanup-item" + (bookmark.id === keepId ? " keep" : "");

      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "keep-" + group.key;
      radio.checked = bookmark.id === keepId;
      radio.title = "Keep this copy";
      radio.addEventListener("change", () => {
        dupeKeepChoice.set(group.key, bookmark.id);
        renderDuplicates();
      });

      const badge = document.createElement("span");
      badge.className = "keep-badge";
      badge.textContent = bookmark.id === keepId ? "Keep" : "Remove";

      row.append(radio, badge, buildCleanupItem(bookmark, `Added ${formatDate(bookmark.dateAdded)}`));
      card.appendChild(row);
    });

    dupesList.appendChild(card);
  });
  appendShowMore(dupesList, dupesShown, groups.length, () => {
    dupesShown += CLEANUP_PAGE_SIZE;
    renderDuplicates();
  });
}

function renderBroken() {
  const broken = getBrokenBookmarks().sort(
    (a, b) => Number(isLikelyDead(readCache(b.url))) - Number(isLikelyDead(readCache(a.url)))
  );
  const ids = new Set(broken.map((b) => b.id));
  brokenSelection.forEach((id) => { if (!ids.has(id)) brokenSelection.delete(id); });
  recheckingUrls.forEach((url) => {
    const record = readCache(url);
    if (!record || record.status !== "loading") recheckingUrls.delete(url);
  });

  const deadCount = broken.filter((b) => isLikelyDead(readCache(b.url))).length;
  brokenSummary.textContent = broken.length
    ? `${plural(broken.length, "bookmark")} failed to load, ${deadCount} of them look permanently dead. ` +
      `Only bookmarks checked so far are listed — "Check remaining" in the header finds the rest.`
    : `No broken links among the bookmarks checked so far. "Check remaining" in the header checks the rest.`;

  setButtonLabel(brokenRemoveBtn, `Remove selected (${brokenSelection.size})`);
  brokenRemoveBtn.disabled = brokenSelection.size === 0 || Boolean(currentJob);
  setButtonLabel(brokenSelectDeadBtn, `Select likely dead (${deadCount})`);
  brokenSelectDeadBtn.disabled = deadCount === 0;
  brokenSelectNoneBtn.disabled = brokenSelection.size === 0;
  brokenRecheckBtn.disabled = broken.length === 0;

  brokenList.innerHTML = "";
  broken.slice(0, brokenShown).forEach((bookmark) => {
    const record = readCache(bookmark.url);
    const row = document.createElement("label");
    row.className = "cleanup-item" + (isLikelyDead(record) ? " dead" : "");

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = brokenSelection.has(bookmark.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) brokenSelection.add(bookmark.id);
      else brokenSelection.delete(bookmark.id);
      renderBroken();
    });

    const recheck = document.createElement("button");
    recheck.className = "row-refresh";
    recheck.title = "Check this link again";
    recheck.textContent = "↻";
    recheck.disabled = record.status === "loading";
    recheck.addEventListener("click", (e) => {
      e.preventDefault();
      recheckingUrls.add(bookmark.url);
      enqueueFetch(bookmark, true, "cleanup");
    });

    row.append(checkbox, buildCleanupItem(bookmark, describeFailure(record)), recheck);
    brokenList.appendChild(row);
  });
  appendShowMore(brokenList, brokenShown, broken.length, () => {
    brokenShown += CLEANUP_PAGE_SIZE;
    renderBroken();
  });
}

const openTrashBatches = new Set(); // keeps <details> open across re-renders

function renderTrash() {
  trashEmptyBtn.disabled = trash.length === 0 || Boolean(currentJob);
  trashList.innerHTML = "";

  if (trash.length === 0) {
    const empty = document.createElement("p");
    empty.className = "cleanup-sub";
    empty.textContent = "Nothing removed yet.";
    trashList.appendChild(empty);
    return;
  }

  trash.forEach((batch) => {
    const card = document.createElement("div");
    card.className = "cleanup-card";

    const head = document.createElement("div");
    head.className = "cleanup-card-head";
    const label = document.createElement("span");
    label.className = "cleanup-card-title";
    const moves = batch.kind === "moves";
    label.textContent = `${itemsLabel(batch.items)}${moves ? " moved" : ""} · ${batch.reason} · ${formatDate(batch.removedAt)}`;
    const restoreAll = document.createElement("button");
    restoreAll.className = "btn btn-secondary btn-small";
    restoreAll.textContent = moves ? (batch.items.length === 1 ? "Move back" : "Move all back") : batch.items.length === 1 ? "Restore" : "Restore all";
    restoreAll.disabled = Boolean(currentJob);
    restoreAll.addEventListener("click", () => restoreFromTrash(batch.id));
    head.append(label, restoreAll);
    card.appendChild(head);

    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Show bookmarks";
    details.appendChild(summary);
    // Rows are only built while expanded — a batch can hold thousands.
    details.addEventListener("toggle", () => {
      if (details.open) {
        openTrashBatches.add(batch.id);
        fillTrashDetails(details, batch, CLEANUP_PAGE_SIZE);
      } else {
        openTrashBatches.delete(batch.id);
        details.replaceChildren(summary);
      }
    });
    details.open = openTrashBatches.has(batch.id);

    card.appendChild(details);
    trashList.appendChild(card);
  });
}

function fillTrashDetails(details, batch, shown) {
  details.replaceChildren(details.querySelector("summary"));
  batch.items.slice(0, shown).forEach((item) => {
    const row = document.createElement("div");
    row.className = "cleanup-item";
    const restoreOne = document.createElement("button");
    restoreOne.className = "btn btn-ghost btn-small";
    restoreOne.textContent = item.kind === "moved" ? "Move back" : "Restore";
    restoreOne.disabled = Boolean(currentJob);
    restoreOne.addEventListener("click", () => restoreFromTrash(batch.id, [item.id]));
    row.append(buildCleanupItem(item, item.kind ? "" : `Added ${formatDate(item.dateAdded)}`), restoreOne);
    details.appendChild(row);
  });
  appendShowMore(details, shown, batch.items.length, () => fillTrashDetails(details, batch, shown + CLEANUP_PAGE_SIZE));
}

/* ============================================================
   View plugins
   ============================================================
   A view plugin adds its own tab showing the bookmarks it matches — by
   category, domain, folder, title, or anything in the fetched page. Plugins
   live in pages/views/ and register themselves with
   BookmarkGallery.registerView({...}); see pages/views/README.md.
*/

const views = [];             // registered plugins, in tab order
const viewsById = new Map();  // view id -> view; the id doubles as its fetch-queue source and tab id
const RESERVED_VIEW_IDS = new Set(["list", "insights", "images", "cleanup", "bulk"]);

function registerView(def) {
  if (!def || typeof def !== "object") throw new TypeError("registerView: expected a view definition object");
  const { id, label, match, render } = def;
  if (!/^[a-z][a-z0-9-]*$/.test(id || "")) throw new Error(`registerView: invalid id "${id}" (lowercase letters, digits, dashes)`);
  if (RESERVED_VIEW_IDS.has(id) || viewsById.has(id)) throw new Error(`registerView: id "${id}" is already taken`);
  if (!label || typeof match !== "function" || typeof render !== "function") {
    throw new Error(`registerView("${id}"): label, match() and render() are required`);
  }
  const view = {
    id,
    def,
    dataVersion: def.dataVersion || 1,
    button: null,
    panel: null,
    ctx: null,
    renderScheduled: false,
    matchedUrls: new Set(), // as of the last render — a fetch for one of these re-renders the view
  };
  view.ctx = makeViewContext(view);
  views.push(view);
  viewsById.set(id, view);
}

window.BookmarkGallery = Object.freeze({ registerView });

// What a plugin gets to work with. Records are the same objects the rest of
// the page uses, so plugins must treat them as read-only.
function makeViewContext(view) {
  const record = (bookmark) => {
    const r = readCache(bookmark.url);
    return r && r.status === "loading" ? r.previous || null : r;
  };
  return Object.freeze({
    id: view.id,
    /** The fetched Open Graph record (status "ok" / "error" / "skipped"), or null if never checked. */
    record,
    /** What this view's extract() returned for the bookmark's page, or null. */
    data: (bookmark) => {
      const r = record(bookmark);
      return (r && r.views && r.views[view.id]) || null;
    },
    /** True while the page is being fetched or waiting in the queue. */
    isPending: (bookmark) => queuedByUrl.has(bookmark.url) || (readCache(bookmark.url) || {}).status === "loading",
    /** Fetch the page if it's unchecked, or re-fetch it if it was checked before this view's extract() existed. */
    ensureData: (bookmark) => ensureViewData(view, bookmark),
    category: getCategoryForBookmark,
    hostname: hostnameOf,
    plural,
    formatDate,
    isActive: () => activeTab === view.id,
    scheduleRender: () => scheduleViewRender(view),
  });
}

// Runs every plugin's extract() on a freshly fetched page. `extracted`
// records which versions ran (even when they found nothing), so a page is
// only re-fetched for a view whose extractor is newer than the record.
function runViewExtractors(page) {
  const extracted = {};
  let data = null;
  for (const view of views) {
    if (!view.def.extract) continue;
    extracted[view.id] = view.dataVersion;
    if (!page) continue;
    try {
      const result = view.def.extract(page);
      if (result != null) (data ||= {})[view.id] = result;
    } catch (e) {
      console.warn(`Bookmark Gallery: view "${view.id}" could not read`, page.url, e);
    }
  }
  return data ? { extracted, views: data } : { extracted };
}

function ensureViewData(view, bookmark) {
  if (!isFetchableUrl(bookmark.url)) return;
  const r = readCache(bookmark.url);
  if (!r) enqueueFetch(bookmark, false, view.id);
  else if (r.status === "ok" && view.def.extract && (!r.extracted || r.extracted[view.id] !== view.dataVersion)) {
    enqueueFetch(bookmark, true, view.id);
  }
}

function getViewBookmarks(view) {
  return allBookmarks.filter((b) => view.def.match(b, view.ctx));
}

function renderView(view) {
  try {
    const list = getViewBookmarks(view);
    view.matchedUrls = new Set(list.map((b) => b.url));
    view.def.render(list, view.ctx);
  } catch (e) {
    console.error(`Bookmark Gallery: view "${view.id}" failed to render`, e);
  }
}

function scheduleViewRender(view) {
  if (activeTab !== view.id || view.renderScheduled) return;
  view.renderScheduled = true;
  setTimeout(() => {
    view.renderScheduled = false;
    if (activeTab === view.id) renderView(view);
  }, HEAVY_RENDER_MS);
}

// A fetch finished: the showing view re-renders if the bookmark was in it
// or may now belong in it.
function onViewBookmarkFetched(bookmark) {
  const view = viewsById.get(activeTab);
  if (!view) return;
  let matches = view.matchedUrls.has(bookmark.url);
  if (!matches) {
    try { matches = view.def.match(bookmark, view.ctx); } catch (e) { /* render() will log it */ }
  }
  if (matches) scheduleViewRender(view);
}

// Each view gets a tab button and an empty panel (placed before Clean up),
// its optional stylesheet, and one mount() call to build its controls.
function mountViews() {
  for (const view of views) {
    // Views live in the header's "Views" menu, after Images.
    const button = document.createElement("button");
    button.id = `tab-btn-view-${view.id}`;
    button.className = "views-item";
    button.setAttribute("role", "menuitemradio");
    button.setAttribute("aria-checked", "false");
    button.textContent = view.def.label;
    if (view.def.title) button.dataset.hint = view.def.title;
    button.addEventListener("click", () => switchTab(view.id));
    viewsListEl.appendChild(button);

    const panel = document.createElement("section");
    panel.id = `panel-view-${view.id}`;
    panel.className = "tab-panel view-panel";
    panel.hidden = true;
    panelCleanup.before(panel);

    if (view.def.stylesheet) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = view.def.stylesheet;
      document.head.appendChild(link);
    }

    view.button = button;
    view.panel = panel;
    tabs.splice(tabs.length - 1, 0, { id: view.id, button, panel });
    try {
      if (view.def.mount) view.def.mount(panel, view.ctx);
    } catch (e) {
      console.error(`Bookmark Gallery: view "${view.id}" failed to mount`, e);
    }
  }
}

/* ============================================================
   Tab switching
   ============================================================ */

// Built-in tabs; view plugins append theirs in mountViews().
const tabs = [
  { id: "list", button: tabBtnList, panel: panelList },
  { id: "insights", button: tabBtnInsights, panel: panelInsights },
  { id: "images", button: tabBtnImages, panel: panelImages },
  { id: "cleanup", button: tabBtnCleanup, panel: panelCleanup },
];

function switchTab(tab) {
  activeTab = tab;
  let activeView = null;
  for (const t of tabs) {
    const active = t.id === tab;
    t.panel.hidden = !active;
    t.button.classList.toggle("active", active);
    if (t.button.classList.contains("views-item")) {
      t.button.setAttribute("aria-checked", String(active));
      if (active) activeView = t.button;
    } else {
      t.button.setAttribute("aria-selected", String(active));
    }
  }
  // The Views button stands in for whichever view is showing.
  viewsBtn.classList.toggle("active", Boolean(activeView));
  viewsBtnLabel.textContent = activeView ? activeView.textContent : "Views";
  closeViewsMenu();

  if (tab === "list") {
    // Re-measure now that the scroll container is visible again, and
    // resume any list-driven fetches that were paused while away.
    renderVisibleRows();
  } else if (tab === "insights") {
    renderInsights();
  } else if (tab === "images") {
    renderImagesTab();
  } else if (tab === "cleanup") {
    renderCleanup();
  } else if (viewsById.has(tab)) {
    renderView(viewsById.get(tab));
  }
  pumpQueue();
}

/* ============================================================
   Wiring
   ============================================================ */

let scrollTicking = false;
scrollContainer.addEventListener("scroll", () => {
  if (!scrollTicking) {
    window.requestAnimationFrame(() => {
      renderVisibleRows();
      scrollTicking = false;
    });
    scrollTicking = true;
  }
});

window.addEventListener("resize", () => {
  if (activeTab === "list") renderVisibleRows();
  if (activeTab === "images" && imageColumnCount() !== imageColumns.length) scheduleImagesRender();
});

let searchDebounceId = null;
searchInput.addEventListener("input", () => {
  clearTimeout(searchDebounceId);
  searchDebounceId = setTimeout(applyFilters, 150);
});

categoryFilterEl.addEventListener("change", () => {
  categoryFilterValue = categoryFilterEl.value;
  applyFilters();
});

sortSelectEl.addEventListener("change", () => {
  sortMode = sortSelectEl.value;
  savePrefs();
  applyFilters();
});

function applyViewModeUi() {
  viewButtons.forEach((btn) => {
    const active = btn.dataset.view === viewMode;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  });
  const grouped = viewMode !== "list";
  expandAllBtn.hidden = !grouped;
  collapseAllBtn.hidden = !grouped;
  // The Folders view always mirrors Firefox's own order.
  sortSelectEl.disabled = viewMode === "folders";
  sortSelectEl.title = viewMode === "folders" ? "The Folders view always uses Firefox's order" : "Sort order";
}

viewButtons.forEach((btn) => btn.addEventListener("click", () => {
  if (viewMode === btn.dataset.view) return;
  viewMode = btn.dataset.view;
  savePrefs();
  applyViewModeUi();
  rebuildDisplayList();
}));

expandAllBtn.addEventListener("click", () => {
  if (viewMode === "folders") folderInfo.forEach((_, id) => expandedFolders.add(id));
  else groupByDomain(filteredBookmarks).forEach((_, domain) => expandedDomains.add(domain));
  savePrefs();
  rebuildDisplayList({ keepScroll: true });
});

collapseAllBtn.addEventListener("click", () => {
  if (viewMode === "folders") expandedFolders.clear();
  else expandedDomains.clear();
  savePrefs();
  rebuildDisplayList();
});

refreshAllBtn.addEventListener("click", () => {
  clearAllCache();
  bulkCheckRunning = false;
  queuePaused = false;
  // Drop the stopped bulk pass's leftovers so they don't sit in the queue.
  fetchQueue = fetchQueue.filter((item) => item.source !== "bulk");
  queuedByUrl = new Map(fetchQueue.map((item) => [item.bookmark.url, item]));
  renderVisibleRows();
  renderCheckStatus();
});

function toggleBulkCheck() {
  if (!bulkCheckRunning) {
    // Start a fresh bulk pass over everything not yet checked.
    bulkCheckRunning = true;
    queuePaused = false;
    allBookmarks
      .filter((b) => isFetchableUrl(b.url))
      .filter((b) => {
        const r = readCache(b.url);
        return !r || (r.status !== "ok" && r.status !== "error");
      })
      .forEach((b) => enqueueFetch(b, false, "bulk"));
  } else if (queuePaused) {
    queuePaused = false;
    pumpQueue();
  } else {
    queuePaused = true;
  }
  renderCheckStatus();
}

checkToggleBtn.addEventListener("click", toggleBulkCheck);

tabBtnList.addEventListener("click", () => switchTab("list"));
tabBtnInsights.addEventListener("click", () => switchTab("insights"));
tabBtnImages.addEventListener("click", () => switchTab("images"));

/* ---------- Views menu (Images + view plugins) ---------- */

const viewsMenuItems = () => [...viewsListEl.querySelectorAll(".views-item")];

function openViewsMenu(focusItem = "checked") {
  viewsListEl.hidden = false;
  viewsBtn.setAttribute("aria-expanded", "true");
  const items = viewsMenuItems();
  const target = focusItem === "last" ? items[items.length - 1]
    : items.find((i) => i.getAttribute("aria-checked") === "true") || items[0];
  if (target) target.focus();
}

function closeViewsMenu({ refocus = false } = {}) {
  if (viewsListEl.hidden) return;
  viewsListEl.hidden = true;
  viewsBtn.setAttribute("aria-expanded", "false");
  if (refocus) viewsBtn.focus();
}

viewsBtn.addEventListener("click", () => (viewsListEl.hidden ? openViewsMenu() : closeViewsMenu()));
viewsBtn.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    openViewsMenu(e.key === "ArrowUp" ? "last" : "checked");
  }
});
viewsListEl.addEventListener("keydown", (e) => {
  const items = viewsMenuItems();
  const i = items.indexOf(document.activeElement);
  const go = (n) => { e.preventDefault(); items[(n + items.length) % items.length].focus(); };
  if (e.key === "ArrowDown") go(i + 1);
  else if (e.key === "ArrowUp") go(i - 1);
  else if (e.key === "Home") go(0);
  else if (e.key === "End") go(items.length - 1);
  else if (e.key === "Escape" || e.key === "Tab") closeViewsMenu({ refocus: e.key === "Escape" });
});
document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest(".views-menu")) closeViewsMenu();
});
tabBtnCleanup.addEventListener("click", () => switchTab("cleanup"));

dupesRemoveAllBtn.addEventListener("click", () => {
  const extras = findDuplicateGroups().flatMap(extrasFor);
  if (extras.length === 0) return;
  confirmClick(dupesRemoveAllBtn, `Click again to remove ${plural(extras.length, "bookmark")}`, () =>
    removeBookmarks(extras, "Duplicates")
  );
});

brokenSelectDeadBtn.addEventListener("click", () => {
  getBrokenBookmarks()
    .filter((b) => isLikelyDead(readCache(b.url)))
    .forEach((b) => brokenSelection.add(b.id));
  renderBroken();
});

brokenSelectNoneBtn.addEventListener("click", () => {
  brokenSelection.clear();
  renderBroken();
});

brokenRecheckBtn.addEventListener("click", () => {
  getBrokenBookmarks().forEach((b) => {
    recheckingUrls.add(b.url);
    enqueueFetch(b, true, "cleanup");
  });
});

brokenRemoveBtn.addEventListener("click", () => {
  const selected = allBookmarks.filter((b) => brokenSelection.has(b.id));
  if (selected.length === 0) return;
  confirmClick(brokenRemoveBtn, `Click again to remove ${plural(selected.length, "bookmark")}`, () =>
    removeBookmarks(selected, "Broken link")
  );
});

trashEmptyBtn.addEventListener("click", () => {
  if (currentJob) return jobBusyMessage();
  confirmClick(trashEmptyBtn, "Click again — this can't be undone", async () => {
    if (currentJob) return jobBusyMessage();
    trash = [];
    hideToast(); // its Undo would point at a batch that no longer exists
    await saveTrash().catch((e) => console.warn("Bookmark Gallery: could not save trash", e));
    renderTrash();
  });
});

repairBtn.addEventListener("click", repairBrokenSeparators);

smartScopeInputs.forEach((input) => input.addEventListener("change", () => {
  smartScope = input.value;
  renderSmartCleanup();
}));

smartRunBtn.addEventListener("click", () => {
  const count = smartCleanupCandidates(smartScope).length;
  if (count === 0) return;
  const scope = smartScope;
  confirmClick(smartRunBtn, `Click again to move ${plural(count, "bookmark")}`, () => runSmartCleanup(scope));
});

emptyFoldersDeleteBtn.addEventListener("click", () => {
  const ids = getEmptyFolders().map((f) => f.id);
  if (ids.length === 0) return;
  confirmClick(emptyFoldersDeleteBtn, `Click again to delete ${plural(ids.length, "folder")}`, () => deleteEmptyFolders(ids));
});

emptyFoldersRestoreBtn.addEventListener("click", () => {
  const entries = getEmptyFolders().flatMap((f) => f.trashed);
  if (entries.length) restoreEntries(entries);
});

toastUndoBtn.addEventListener("click", () => {
  const action = toastUndoAction;
  hideToast();
  if (action) action();
});
toastCloseBtn.addEventListener("click", hideToast);

jobCancelBtn.addEventListener("click", () => {
  if (!currentJob) return;
  currentJob.cancelled = true;
  jobCancelBtn.disabled = true;
  jobCancelBtn.textContent = "Cancelling…";
});

// Ctrl/Cmd+Z undoes the removal the toast is offering (outside text fields).
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== "z") return;
  if (!toastUndoAction || e.target.closest("input, textarea, select")) return;
  e.preventDefault();
  toastUndoBtn.click();
});

for (const event of [
  browser.bookmarks.onCreated,
  browser.bookmarks.onRemoved,
  browser.bookmarks.onChanged,
  browser.bookmarks.onMoved,
]) {
  event.addListener(scheduleBookmarksReload);
}

// If the page was closed in the middle of a bulk removal, a staging folder
// may be left over. Its bookmarks are already in the trash, so finish
// deleting it, and drop anything that was never moved from that batch.
async function finishInterruptedRemoval() {
  const { [PENDING_REMOVAL_KEY]: pending } = await browser.storage.local.get(PENDING_REMOVAL_KEY);
  if (!pending) return;
  await browser.bookmarks.removeTree(pending.folderId).catch(() => {}); // may already be gone
  const nodes = await getTreeIndex();
  const batch = trash.find((b) => b.id === pending.batchId);
  if (batch) {
    batch.items = batch.items.filter((item) => !nodes.has(item.id));
    if (batch.items.length === 0) trash = trash.filter((b) => b !== batch);
    await saveTrash();
  }
  await browser.storage.local.remove(PENDING_REMOVAL_KEY);
}

async function init() {
  try {
    await loadStorage();
    await finishInterruptedRemoval();
  } catch (e) {
    console.warn("Bookmark Gallery: could not load saved data", e);
  }
  sortSelectEl.value = sortMode;
  applyViewModeUi();
  mountViews();
  await loadBookmarks();
}

document.addEventListener("DOMContentLoaded", init);
