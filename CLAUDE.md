# Bookmark Gallery — project notes for Claude Code

A Firefox (MV2) and Chrome (MV3) WebExtension that reads all bookmarks and shows them in a
full-tab page with tabs: Bookmarks (virtual list, grouping, sorting, search,
category filter), Insights (pie charts + top-10 tables), Images (masonry of image
bookmarks), view-plugin tabs (currently Recipes), and Clean up (duplicates, broken
links, restorable trash).

## Layout

- `manifest.json` — Firefox, MV2; permissions: `bookmarks`, `storage`, `<all_urls>`.
- `manifest.chrome.json` — Chrome, MV3 (`host_permissions`, service-worker background,
  `unlimitedStorage` — Chrome caps storage.local at 10 MB otherwise, PNG icons).
- `scripts/build.mjs` — copies `background.js`, `pages/`, `icons/` + a browser's manifest into
  `dist/<firefox|chrome>` (`npm run build`, `build:chrome`; `npm run chrome` watches).
  `npm run package` (`--zip`) also lints Firefox with web-ext (pinned) and zips both into
  `artifacts/`; it refuses if the two manifest versions differ. Never edit `dist/`.
  Anything a store must not receive (docs, scripts, CLAUDE.md) simply isn't in `SOURCES`.
- `docs/PRIVACY.md` (store privacy policy — keep it true when adding network requests or
  storage), `docs/PUBLISHING.md` (release steps, listing text, permission justifications).
- Firefox add-on ID `bookmark-gallery@rocket1.github.io` is permanent once on AMO; min
  Firefox 140 (needed for `data_collection_permissions`, which AMO requires).
- `icons/logo.svg` — app logo (header, favicon, toolbar button, add-on icon);
  `icons/png/logo-{16,32,48,128}.png` are renders of it for Chrome (re-render if the SVG changes).
- `background.js` — toolbar button opens (or focuses) `pages/bookmarks.html`. Runs as an MV2
  script in Firefox and an MV3 service worker in Chrome; finds an open gallery tab with
  `runtime.getContexts` where available (Chrome ignores `tabs.query({url})` without "tabs").
- `pages/bookmarks.html` / `.css` / `.js` — the whole UI. No build step, no dependencies.
- `pages/views/` — view plugins (`recipes.js` + `recipes.css`), loaded by `<script>` tags
  after `bookmarks.js`; `views/README.md` documents the plugin API.
- `package.json` — `npm start` (web-ext against the real `default-release` profile), plus
  `build`, `build:chrome`, `chrome` (watch), `package`.

## Running it

Firefox → `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on…" → pick
`manifest.json`. After edits, click "Reload" on the add-on. Or: `npm start` from this
folder (needs Node; quit normal Firefox first since it uses the real profile), or
`npx web-ext run` for a throwaway empty profile. Chrome: `npm run chrome`, then
`chrome://extensions` → Developer mode → "Load unpacked" → `dist/chrome`; reload its card after edits.

## Architecture notes (read before changing `bookmarks.js`)

- **Cross-browser**: one codebase for Firefox and Chrome. `browser` falls back to `chrome`
  (MV3 APIs are promise-based). Built-in folder ids differ (Firefox `unfiled_____`, Chrome
  `0`/`1`/`2`), so `ROOT_FOLDER_ID` / `OTHER_BOOKMARKS_ID` / `TOOLBAR_ID` / `BUILT_IN_FOLDERS` /
  `SMART_LOOSE_PARENTS` are filled from the tree by `detectRootFolders()` on every load — never
  hardcode a root id. `SUPPORTS_SEPARATORS` (Firefox only) gates separator repair; Chrome's
  `bookmarks.create` rejects `type`. Test changes in both.
- **Storage**: everything lives in `browser.storage.local`, loaded fully into memory by
  `loadStorage()` at startup so reads stay synchronous; writes are fire-and-forget.
  - `bmgallery::og::<url>` — Open Graph records, mirrored in the `ogCache` Map. `status`
    is one of `ok | error | skipped | loading` (`loading` is in-memory only).
  - `bmgallery::prefs` — `{ groupMode, expandedDomains, sortMode }`.
  - `bmgallery::trash` — removed-bookmark batches (see below).
  - Old `localStorage` cache entries are migrated once by `migrateLocalStorageCache()`.
- **Fetch queue** (`enqueueFetch` / `pumpQueue`): max 4 concurrent, max 1 per hostname
  (avoids HTTP 429), 429s retry twice with 2s/4s backoff, 8s timeout.
  Non-http(s) URLs (bookmarklets, `about:`) are marked `skipped` and never fetched.
- **Queue sources**: each item is tagged `list`, `bulk`, `images`, or `cleanup` (and
  carries its `host`, parsed once). `isSourceActive()` only lets `list`/`images`/`cleanup`
  items run while their tab is on screen; `switchTab()` calls `pumpQueue()` to resume them.
  `bulk` ("Check remaining") runs on every tab while not paused, but `pumpQueue` serves
  on-screen items first and, off the Insights tab, caps bulk at `MAX_CONCURRENT_FETCHES - 1`.
- **List lazy-loading**: only rows in the rendered range own queue entries. Each
  `renderVisibleRows()` calls `releaseOffscreenListItems()`, which drops queued `list` items
  that scrolled away, hands borrowed ones back to their old source (`returnTo`, e.g. bulk),
  and aborts in-flight list fetches (`item.cancel`; an aborted fetch clears its loading
  marker instead of recording an error). On-screen rows are queued before buffer rows.
  Without this, a fast scroll leaves the rows you stop on behind hundreds you passed.
- **Check status**: `getCheckCoverage()` (checked = status `ok` or `error`) is the one
  definition of progress; `renderCheckStatus()` shows it in the header on every tab and in
  the Insights banner. Don't add separate per-session fetch counters — they drift.
- **Site quirks** (in `fetchOpenGraphData`): Reddit serves anonymous requests a "Prove your
  humanity" page, so `/r/<sub>/comments/<id>` URLs (`REDDIT_POST_URL`) use Reddit's official
  oEmbed endpoint instead (title + author; 404 = post gone). Any page whose title matches
  `BOT_CHECK_TITLE` (Cloudflare "Just a moment…", "Access denied", …) is recorded as an
  error, never as the bookmark's preview; `loadStorage()` purges such titles cached by older
  versions. Don't spoof user agents or solve challenges — use a site's official endpoint.
- **Virtual list**: mixed row heights — bookmarks `ROW_HEIGHT = 104`, domain/folder headers
  `HEADER_HEIGHT = 52` (must match `--row-height` / `--header-height` in the CSS).
  `renderScrollArea()` builds `rowOffsets` (prefix sums); `getRenderRange()` binary-searches it.
  `renderVisibleRows()` keeps bookmark rows in place (`renderedRows`, by id) and only rebuilds
  one whose record object changed — never clear and re-append all rows: removing/re-inserting
  restarts every loading pulse and the list flickers. Pulses take `--shimmer-delay`
  (`shimmerDelay()`, phase-locked to `SHIMMER_MS`) so ones started at different times stay in sync.
- **View modes** (`viewMode`: `list | domain | folders`, persisted with `expandedDomains` /
  `expandedFolders`): `folders` walks `bookmarkTree` (the raw `getTree()` root) in Firefox's
  order — loose bookmarks and nested folders, indented by depth (`FOLDER_INDENT_PX`), sort
  menu disabled. While a filter is active only folders with matches are shown, force-opened.
- **Categories** (`detectCategory`): direct image URL → JSON-LD types → `og:type` →
  domain rules → keyword rules → "Other". Unfetched bookmarks get a URL/domain/title-only guess.
- **Images tab**: bookmarks whose category is "Images"; the image is the URL itself
  (direct links) or the page's `og:image` (needs a page fetch first). A card is only
  placed once the image's size is known: `probeImageSize` streams the file just far
  enough for `parseImageSize` (PNG/JPEG+EXIF rotation/GIF/BMP/WebP/SVG) and aborts;
  other formats or refused fetches fall back to `decodeImageSize` (an off-DOM `Image`).
  Sizes/failures are cached under `bmgallery::img::<image url>` (failures retried after
  a day). Probes have their own queue (`PROBE_CONCURRENCY`, `PROBE_PER_HOST`) that only
  runs on the Images tab. Layout is JS masonry: fixed `.images-column`s, each card goes
  into the shortest one and never moves; `IMAGE_GAP_PX` / `IMAGE_CAPTION_PX` must match
  the CSS. Frames pulse until the `<img>` loads; any failure removes the card — never
  show a broken image or an error placeholder.
- **"Deleted image" placeholders** are real images hosts serve in place of removed ones.
  Hidden via: any HTTP error (`ImageGoneError` — i.redd.it sends a 404 *with* an image
  body, so never fall back to browser decode after an HTTP error); a redirect to a
  `PLACEHOLDER_URL` path (imgur → `/removed.png`); or `titleMatchesDims` — Firefox titles
  image bookmarks "name.jpg (W×H)", and a clearly different shape now means it was
  swapped. Bump `IMAGE_DIMS_VERSION` to force a re-probe after changing these rules.
- **Removing bookmarks** (`removeBookmarks`): snapshots each bookmark's
  `parentId`/`index`/title/url, saves the batch to the trash **before** touching
  anything, then shows an Undo toast (also Ctrl/Cmd+Z). It does NOT call
  `bookmarks.remove()` per bookmark — measured in real Firefox, that drops to ~8/s in a
  3,600-bookmark folder. Instead it `move()`s them into a staging folder
  (`STAGING_TITLE`, in Other Bookmarks) and `removeTree()`s it every `STAGING_FLUSH`
  (~270/s, same folder). `bmgallery::pendingRemoval` marks a live staging folder;
  `finishInterruptedRemoval()` completes it on next load, and restore moves any item
  still sitting in a staging folder back (keeping its id). Only leaf
  bookmarks are ever removed, never folders. `restoreFromTrash` re-creates them in
  ascending index order per folder (so positions line up) and clamps the index. Each
  batch also stores `folders` (every ancestor folder's title/parent/index); if a folder
  was deleted since, `resolveFolder` rebuilds the missing branch in place and records
  old→new ids in `bmgallery::folderRemap` so later restores reuse it. Only entries with
  no folder records fall back to "Other Bookmarks" (`unfiled_____`). Restored bookmarks
  get new ids and a new `dateAdded` — `bookmarks.create` can't set it, and tags/keywords
  aren't exposed to extensions at all; that's the ceiling on rollback fidelity.
- **Jobs** (`startJob` / `endJob`, one at a time via `currentJob`): remove and restore run
  as cancelable jobs with a progress bar. They snapshot the tree with one `getTree` call
  (`getTreeIndex`), work in chunks (removes start at `JOB_CHUNK` and `tuneChunkSize()`
  grows/shrinks the batch by measured throughput), show rate + time left, and `yieldToBrowser()` (MessageChannel,
  not throttled in background tabs) between chunks. Bookmark-event reloads are held off
  while a job runs and done once in `endJob`. Restore runs `RESTORE_WORKERS` folders in
  parallel (each folder in index order), saves trash progress every ~2s, and skips items
  whose original id still exists.
- **Responsiveness rules** (30k+ bookmarks is a real use case): never `Promise.all` one API
  call per bookmark; whole-collection renders go through the throttled `schedule*Render`
  (`HEAVY_RENDER_MS`); a fetch completion only re-renders what it can change (one image
  card, the broken list); Clean up lists and trash batches render `CLEANUP_PAGE_SIZE` rows
  at a time; dupe groups and categories are memoized (`dupeGroupsCache`, `categoryMemo`);
  the fetch queue has a `queuedByUrl` index.
- **Bulk actions** use `confirmClick()` (click twice within 4s) instead of modal dialogs.
- **Duplicates** (`normalizeUrlForDupes`): ignores http/https, `www.`, trailing slash,
  tracking params (`TRACKING_PARAM`), and `#anchors` — but keeps `#/` and `#!/` routes.
  Default keeper (`keeperIdFor`): a copy filed in one of the user's folders
  (`folderDepth >= 2`) beats a loose one in Menu/Toolbar/Other, then the oldest — "oldest
  wins" alone kept unsorted quick-saves and emptied organised folders. `foldersEmptiedBy()`
  powers the "would leave N folders empty" warning in the Duplicates summary.
- **Separators**: Firefox reports them as `type: "separator"`, `url: "data:"`. They are never
  bookmarks (`isSeparatorNode`) — not listed, de-duplicated or counted. Older versions did
  treat them as bookmarks, so: trash entries with `url: "data:"` and no title restore as
  separators (`isSeparatorItem`), and blank `data:` bookmarks they created
  (`isBrokenSeparator`) are offered for repair in Clean up (`repairBrokenSeparators`).
- **Trash items** have an optional `kind`: absent = bookmark, `"folder"`, `"separator"`,
  `"moved"` (Smart cleanup — the bookmark still exists; restoring moves it back).
- **Smart cleanup** (`runSmartCleanup`): moves bookmarks into Other Bookmarks › `Smart Cleanup` ›
  `<category>` (`SMART_CATEGORY_ORDER`, "Other" → `Uncategorized`), recording each one's
  original `parentId`/`index` as a `kind: "moves"` batch (`createdFolders` are removed again
  after a full undo if empty). Scope `loose` = direct children of Menu/Other/Mobile; `everything`
  = all; toolbar items and anything already under Smart Cleanup are never moved.
  **Moves run one at a time** (reorganize and undo): measured in real Firefox, concurrent
  moves out of the same folder misplaced items by a couple of positions; sequential was exact
  (5,000 bookmarks: 18s to reorganize, 16s to undo, 11/11 folders identical).
- **Empty folders** (`getEmptyFolders`): outermost folders with no bookmarks anywhere inside
  (`folderInfo.bookmarkCount`), joined with trashed bookmarks whose `parentId` (or
  `folderRemap`ped id) is that folder, across all batches. `restoreEntries()` restores a
  cross-batch selection; `deleteEmptyFolders()` saves each subtree (folders + separators) to
  the trash, then `removeTree`s it. Restoring folder batches runs one ordered pass
  (parents first, siblings by index); folders are recreated via `resolveFolder`.
- **Broken links**: `isLikelyDead()` = HTTP 404/410 or `NetworkError`; others (403/429/5xx,
  timeouts) are listed but never auto-selected.
- **Views menu**: Images and every view plugin are `.views-item` (`role="menuitemradio"`) entries
  in `#views-list` behind the header's `#views-btn`, not tab buttons. `switchTab()` sets
  `aria-checked` on them and relabels/activates `#views-btn` with the showing view's name.
- **Insights extras** (`renderInsightsExtras`, called from `renderInsights`): KPI tiles,
  timeline (per year, or per month if < 2 years span), dead links by year (`isLikelyDead`
  share, years with ≥ 5 checked), failure reasons (`failureReason`), biggest folders (direct
  children by `parentId`), day × hour heatmap. Plain HTML/CSS; colors are the data-viz palette's
  dark steps validated against the card surface (`CHART_BLUE`, `CHART_ORANGE`, `HEAT_RAMP`) —
  one hue per chart, never cycled. Marks carry `data-tip-value`/`data-tip-label` for the one
  shared `#chart-tooltip` (hover + focus); each chart has a "Show as table" twin.
- **Network errors differ by browser**: Firefox "NetworkError…", Chrome "Failed to fetch" —
  always test with `NETWORK_ERROR`, never one wording.
- **View plugins** (`registerView`, exposed as `window.BookmarkGallery`): each adds an entry to
  the Views menu plus `panel-view-<id>` (inserted before Clean up, via `mountViews()` in `init`)
  and is appended to `tabs`, which `switchTab()` loops over. The view id doubles as its fetch-queue
  source (`isSourceActive`: runs only while that tab shows). `match(bookmark, ctx)` picks its
  bookmarks; `render(list, ctx)` runs on tab show and throttled (`scheduleViewRender`) after a
  fetch for a matching bookmark or a bookmarks reload. Optional `extract(page)` runs inside
  `fetchOpenGraphData` for **every** page (`runViewExtractors`) — results go in
  `record.views[id]`, and `record.extracted[id] = dataVersion` marks it ran even when it found
  nothing. `ctx.ensureData()` force-re-fetches an `ok` record whose `extracted[id]` is older,
  so bump `dataVersion` after changing an extractor. A forced re-fetch's loading marker keeps
  the old record as `previous` (category and `ctx.record` use it), so items don't drop out of a
  view mid-fetch; an aborted fetch restores it. Plugins never touch `innerHTML` with page data.
- **Recipes view** (`views/recipes.js`): `extract` finds a schema.org Recipe in JSON-LD
  (`@graph`, `mainEntity`, array `@type`) or microdata, reduces everything to plain text
  (`plainText` via an inert `DOMParser`), keeps only http(s) image URLs, and returns null without
  ingredients or steps. Matches `ctx.data(b)` or category "Recipes". Cards are cached per
  record (`entryCache`) so throttled re-renders reuse elements; `syncChildren()` only moves cards
  whose position changed (never `replaceChildren` the grid — re-inserting hundreds of cards
  stuttered the scroll); infinite scroll in `PAGE_SIZE` pages (`showMoreIfNearEnd` keeps filling
  tall windows). Card images start via `imageObserver` ~1200px ahead (not `loading="lazy"`,
  which pops in late in Firefox) and appear after `img.decode()`. The detail sheet is an
  in-panel overlay (Esc / backdrop closes).
- **Live sync**: `browser.bookmarks.on*` events trigger a debounced reload that keeps the
  list's scroll position.

## Known limitations / ideas

- `fetch()` needs `<all_urls>`; sites that block non-browser requests show "Failed".
- Tags and keywords on a bookmark aren't exposed to WebExtensions, so a restore loses them.
- "Failed first" sorting is computed when filters apply, not live as fetches finish.
- Insights only reflects bookmarks checked so far (by design — see "Check remaining" in the header).
