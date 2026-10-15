# Bookmark Gallery — Firefox extension

Reads every bookmark in your Firefox bookmarks (all folders) and shows them
as a virtual scrolling list enriched with Open Graph data (title,
description, image) pulled from each page. Results are cached in
`browser.storage.local` so re-opening the page is instant instead of
re-fetching everything. It can also find duplicate and broken bookmarks and
remove them from Firefox, with undo.

## Load it in Firefox (temporary install, for testing)

1. Unzip this folder somewhere on your computer.
2. Open Firefox and go to `about:debugging#/runtime/this-firefox`.
3. Click **"Load Temporary Add-on…"**.
4. Select the `manifest.json` file inside the unzipped folder.
5. Click the extension's toolbar icon (pin it via the puzzle-piece
   "Extensions" menu if you don't see it) to open the Bookmark Gallery tab.

Already loaded it before? Find it in the `about:debugging` list and click
**Reload** instead of removing and re-adding it.

Note: temporary add-ons are removed when Firefox restarts. To keep it
installed permanently you'd need to sign it through Mozilla's Add-on
Developer Hub.

## Load it in Chrome (or Brave, Edge, …)

The same code runs in Chrome; only the manifest differs (Chrome needs Manifest V3
and PNG icons), so Chrome loads an assembled copy from `dist/chrome`.

1. In this folder run `npm run chrome` (needs Node). It builds `dist/chrome` and
   keeps rebuilding it whenever you edit a file; `npm run build:chrome` builds once.
2. Open `chrome://extensions`, turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `dist/chrome` folder.
4. Pin it from the puzzle-piece menu and click it to open the gallery.

After changes: let the build run (or run `npm run build:chrome`), click the
**↻ reload** icon on the extension's card, then refresh the gallery tab. Unlike
Firefox, an unpacked extension stays installed across Chrome restarts.

Each browser keeps its own cache, preferences and trash. Chrome has no bookmark
separators, so the separator repair never appears there.

## Working on it with Claude Code

The folder includes a `CLAUDE.md` describing the architecture, so you can just:

```
cd bookmark-gallery
claude
```

and ask for changes. To live-reload in Firefox while you edit (needs Node):

```
npm start
```

That runs Firefox with your real profile (`default-release`) so your actual
bookmarks show up; quit your normal Firefox first. `npx web-ext run` uses a
throwaway empty profile instead.

## What's in it

### Tab 1 — Bookmarks

- A **virtualized list**: only the rows currently on screen are built as
  DOM elements, so it stays fast even with thousands of bookmarks.
- **Search** by title or URL, and a **category filter** (Recipes, News &
  Articles, Video, Shopping, etc.) that can be combined with the search box.
- **Sort** by bookmark order, newest/oldest first, title, or failed links first.
- **Three views** (List · By domain · Folders):
  - **List** — every bookmark, sortable.
  - **By domain** — one row per website (e.g. `youtube.com — 42 bookmarks`);
    click to expand.
  - **Folders** — exactly as in Firefox: loose bookmarks and nested folders in
    Firefox's own order, indented, with empty folders marked. Searching shows
    matches inside their folders.
  "Expand all" / "Collapse all" work in the grouped views. The view, open
  groups/folders, and sort order are remembered between sessions.
- Each row shows a thumbnail, title, site name, and description pulled
  from the page's Open Graph tags, with a status pill (Cached / Loading /
  Failed / N/A), a ↻ button to re-fetch just that one row, and a 🗑 button
  to remove the bookmark (undoable — see Tab 4).
- **"Refresh all previews"** clears the whole cache and re-fetches
  everything as rows scroll into view.

### Tab 2 — Insights

Headline numbers along the top — bookmarks and websites, your own folders,
duplicate copies, dead links (of those checked), when you started bookmarking
(and how many a month), and your busiest day — then:

- **Bookmarks added per year** (per month if everything is recent).
- **Dead links by year bookmarked** — link rot: of the bookmarks checked from
  each year, how many are gone (404/410, or the site no longer exists).
- **Why links fail** — every failed check grouped by reason.
- **Biggest folders** — the ten folders holding the most bookmarks.
- **When you bookmark** — a day-of-week × hour-of-day heatmap.

Hover (or tab to) any bar or cell for its exact value; every chart also has a
"Show as table" view. Plus three pie charts, each with a legend and a table of
the top 10 entries with counts and percentages:

1. **By domain** — always complete, since domain comes straight from the
   URL and doesn't need a page fetch.
2. **Active vs. broken links** — based on what's actually been checked so
   far (Active / Broken / Not checkable / Unchecked).
3. **By category** — a best-effort guess per bookmark (see below).

Because checking every bookmark could mean hundreds of network requests,
Insights only reflects bookmarks that have been fetched already (from
scrolling through Tab 1, or previous sessions). The header shows progress on
every tab ("Checked 5,832 of 30,300") with a single button: **"Check
remaining"** fetches the rest, then becomes **"Pause"** / **"Resume"**, and
the check keeps running while you use the other tabs. It uses the same host-throttled,
rate-limit aware queue as the list view, so it's safe to run on a large
collection, just possibly slow.

### Views menu — Images, Recipes, …

Images and every view plugin sit behind the **Views ▾** button in the header
(it shows the name of the view you're on). Arrow keys move through the menu,
Esc closes it.

#### Images

A masonry (multi-column, variable height) grid of every bookmark detected as
an image: direct image links (`.jpg`, `.png`, `.gif`, `.webp`, …), known image
hosts (Imgur, Flickr, Unsplash, Pexels, Giphy, Tenor, 500px, Pixabay, …), and
pages whose `og:type` is an image (using their `og:image`). "Images" is also
available in the category filter on the Bookmarks tab.

Before a card appears, only the first few KB of each image are downloaded to read
its exact dimensions, so every card goes straight in at its final size, pulses
while the image loads, and never shifts the layout. Images that are missing,
aren't really images, or fail to load are simply left out — no broken icons or
error placeholders. Sizes are cached, so reopening the tab lays out instantly.

#### Recipes (a view plugin)

Every recipe bookmark as a recipe card: photo, total time, rating, servings,
ingredient count, calories, cuisine and course. Click a card for the full recipe
sheet (prep/cook/total time, a tickable ingredient list with a Copy button, and
numbered steps you can click off as you cook). Search covers titles and
ingredients; filter by course, cuisine, or "ready in 30 min / 1 hour"; sort by
quickest, top rated, newest or A–Z.

The details come from the schema.org Recipe data most recipe sites publish
(JSON-LD, or microdata on older sites). Bookmarks that look like recipes but have
no such data get a simpler card that opens the original page. Recipes checked
before this tab existed are re-fetched once, the first time you open it.

This tab is a **view plugin** — see [pages/views/README.md](pages/views/README.md)
to add your own (by category, domain, folder, or anything on the page).

### Clean up

- **Smart cleanup**: files bookmarks into Other Bookmarks › Smart Cleanup ›
  *category* (Recipes, Video, Code & Dev, …), with anything unclear going to
  *Uncategorized*. By default only **loose** bookmarks move (the unfiled ones in
  Bookmarks Menu, Other Bookmarks and Mobile) — your own folders and the toolbar
  stay as they are; an "Everything" option also empties your folders (with a
  warning). A preview shows how many go where, and how many categories are
  guesses because the page hasn't been checked yet. Every move is recorded in
  Recently removed; **Move all back** (or Undo) returns each bookmark to its
  exact folder and position.

- **Duplicates**: bookmarks pointing at the same page, ignoring `http` vs
  `https`, `www.`, trailing slashes, tracking parameters (`utm_*`, `fbclid`, …)
  and `#anchors`. Each group shows every copy with its folder and date added.
  By default the copy filed in one of your own folders is kept over a loose one
  (then the oldest); pick another with the radio button. If removing everything
  would leave any folder empty, the summary names those folders first. Remove
  one group's extras, or all of them at once.
- **Broken links**: bookmarks that failed to load, with a plain-English reason.
  404/410 and unreachable domains are marked as likely dead; "Select likely
  dead" ticks only those, since 403/429/timeouts often mean the site just
  blocks automated requests. ↻ re-checks a link before you decide.
- **Empty folders**: every folder with no bookmarks in it (including ones that
  only hold other empty folders or separator lines), with how many of its
  bookmarks are in Recently removed (from any batch) and a button to put them
  back. **Delete** removes one; **Delete all empty folders** (two clicks)
  removes them all — both go to Recently removed and can be restored to the
  exact same place. Built-in folders (Menu, Toolbar, Other, Mobile) are never touched.
- **Recently removed**: every removal is saved here *before* the bookmark is
  deleted from Firefox, so it can be restored into its original folder and
  position — even after closing the browser. A toast offers **Undo**
  (or Ctrl/Cmd+Z) right after each removal. If a folder was deleted in the
  meantime, it's recreated with the same name in the same place (whole branches
  too). Restored bookmarks get a new "date added", and Firefox tags/keywords
  aren't kept — extensions can't set or read those.
- **Big clean-ups** show progress, speed and time left, and can be cancelled.
  Firefox has no "remove many" call, so each bookmark is a separate database
  write; the batch size tunes itself to what your Firefox handles fastest.
  Pausing Firefox Sync during a very large clean-up can speed it up.

Bulk removals and "Empty trash" need a second click within 4 seconds to confirm.
Folders are never removed — only individual bookmarks.

Extra safety net: Firefox keeps its own daily bookmark backups
(Bookmarks → Manage Bookmarks → Import and Backup → Restore).

### Tab isolation

Fetches are tagged by the tab that requested them and only run while that tab is
on screen; switching back resumes where that tab left off. The one exception is
the "Check remaining" pass, which runs in the background on any tab —
but rows you're looking at always go first, with one request slot kept free for them.

## How category detection works

There's no reliable universal "category" field on the web, so this is a
best-effort guess, checked in order of how trustworthy the signal is:

1. **Structured data (JSON-LD)** on the page — e.g. `schema.org/Recipe`,
   `NewsArticle`, or `Product` markup, when a site includes it.
2. **Open Graph type** (`og:type`) — e.g. `video`, `article`, `product`,
   `profile`.
3. **Known domains** — YouTube/Vimeo → Video, Reddit/Stack Overflow →
   Forum, Amazon/Etsy → Shopping, GitHub → Code & Dev, Wikipedia →
   Reference & Docs, major news outlets → News & Articles, and so on.
4. **Keyword hints** in the title/description — e.g. "recipe",
   "ingredients", "prep time" → Recipes, catching recipe blogs that don't
   use structured data.
5. Anything that matches nothing falls into **Other**.

Bookmarks that haven't been fetched yet still get a lighter guess from
just their domain and title (rules 3–4 above), so the category filter and
chart are useful immediately — accuracy just improves once a bookmark has
actually been checked.

## Why some previews fail

Some sites show automated requests a bot check ("Prove your humanity", Cloudflare's
"Just a moment…") instead of the page. Those are reported as blocked rather than
shown as the bookmark's title. Reddit posts are handled specially: their title and
author come from Reddit's official embed (oEmbed) service, which isn't blocked.


A row shows "Preview unavailable" if the site takes too long to respond
(8s timeout), returns a non-200 status, or blocks automated requests.
`HTTP 429` means the site rate-limited the request — the extension
automatically retries twice with a short backoff before giving up, and
never runs more than one request to the same domain at a time to avoid
triggering this in the first place.

## Ideas for next steps

- Re-sort "Failed first" live as checks finish.
- Export / import the preview cache and trash.

## Contributing a view

Views (Images, Recipes, …) are plugins in `pages/views/`. To add one — videos,
articles, anything you can pick out by category, site, folder or page data —
follow [pages/views/README.md](pages/views/README.md) and open a pull request.
Browser stores don't allow extensions to load code from outside the package, so
new views ship with the next release rather than as separate downloads.

## Building and publishing

- `npm run build` — assembles `dist/firefox` and `dist/chrome`.
- `npm run package` — the same, plus a web-ext lint of the Firefox build and
  store-ready zips in `artifacts/`.

Release steps, store listing text, permission justifications and the review
notes for both stores are in [docs/PUBLISHING.md](docs/PUBLISHING.md).

## Privacy

No account, no server, no analytics: bookmarks and previews stay on your device,
and the only network requests go to the sites you bookmarked. Full policy:
[docs/PRIVACY.md](docs/PRIVACY.md).

## License

[MIT](LICENSE)
