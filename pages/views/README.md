# View plugins

A view plugin adds its own tab to Bookmark Gallery, showing the bookmarks it
picks out in whatever layout it likes. `recipes.js` is the reference example.

## Adding one

1. Create `pages/views/<name>.js` (and optionally `<name>.css`).
2. Add `<script src="views/<name>.js"></script>` to `pages/bookmarks.html`, after
   `bookmarks.js`. Views appear in the header's **Views ▾** menu, after Images, in script order.
3. Reload the add-on.

```js
"use strict";
(() => {
  BookmarkGallery.registerView({
    id: "videos",                       // lowercase; also the tab's fetch-queue source
    label: "Videos",                    // name in the Views menu
    title: "Every video bookmark",      // optional one-line description under the name
    stylesheet: "views/videos.css",     // optional, relative to pages/

    // Required: which bookmarks belong here. Any attribute works —
    // bookmark.{title,url,folderPath,folderDepth,dateAdded,parentId},
    // ctx.category(b), ctx.hostname(b.url), ctx.record(b), ctx.data(b).
    match: (bookmark, ctx) => ctx.category(bookmark) === "Video",

    // Optional: called once with the tab's empty <section>. Build controls here.
    mount(panel, ctx) { /* … */ },

    // Required: draw the view. Called when the tab is shown, and (throttled)
    // whenever a fetch finishes for a matching bookmark or bookmarks change.
    render(bookmarks, ctx) { /* … */ },

    // Optional: pull extra data out of every fetched page. Return a small
    // JSON-serialisable object, or null. Stored per bookmark; read it back
    // with ctx.data(bookmark).
    extract({ doc, url, jsonLd, meta }) { return null; },
    dataVersion: 1,                     // bump after changing extract()
  });
})();
```

## The `ctx` object

| | |
|---|---|
| `ctx.record(b)` | The fetched Open Graph record (`status`, `ogTitle`, `ogDescription`, `ogImage`, `ogSiteName`, `category`, …) or `null`. Read-only. |
| `ctx.data(b)` | What this view's `extract()` returned for the page, or `null`. |
| `ctx.ensureData(b)` | Queue a fetch if the bookmark is unchecked, or a re-fetch if it was checked before this `extract()` version. Call it for the bookmarks you show. |
| `ctx.isPending(b)` | True while its page is queued or loading. |
| `ctx.category(b)`, `ctx.hostname(url)` | Same category guess and hostname the rest of the app uses. |
| `ctx.plural(n, "thing")`, `ctx.formatDate(ts)` | Formatting helpers. |
| `ctx.isActive()`, `ctx.scheduleRender()` | Whether the tab is showing; ask for a throttled re-render. |

## Rules

- **Page data is untrusted.** Put it in the DOM with `textContent` only, never
  `innerHTML`; accept only `http:`/`https:` URLs for images and links.
- `extract()` runs on *every* fetched page, so keep it fast and return `null` for
  pages that aren't yours. Keep results small — they're stored with each bookmark.
- Fetches you trigger only run while your tab is on screen, max one per host.
- With 30k+ bookmarks, `match()` runs over all of them on each render: keep it
  cheap, and render large results a page at a time.
