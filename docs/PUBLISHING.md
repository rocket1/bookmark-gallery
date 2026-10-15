# Publishing Bookmark Gallery

Everything needed to put a release on addons.mozilla.org (AMO) and the Chrome Web
Store (also used by Brave and Opera; Edge Add-ons takes the same Chrome zip).

## Making a release

1. Bump `version` in **both** `manifest.json` and `manifest.chrome.json` (the
   package step refuses to run if they differ).
2. `npm run package` — builds `dist/firefox` and `dist/chrome` (only
   `background.js`, `pages/`, `icons/` and that browser's manifest), lints the
   Firefox build with web-ext, and writes:
   - `artifacts/bookmark-gallery-firefox-<version>.zip`
   - `artifacts/bookmark-gallery-chrome-<version>.zip`
3. Commit, tag (`git tag v<version> && git push --tags`), and upload each zip to its
   store. Optionally attach both to a GitHub Release.

Expected lint result: 0 errors, 1 warning about Firefox for **Android** — the
extension doesn't support Android (Firefox for Android has no bookmarks API), so
leave Android unticked on AMO.

The add-on ID `bookmark-gallery@rocket1.github.io` (in `manifest.json`) is permanent
once uploaded to AMO — never change it after the first submission.

## Store listing text

**Name:** Bookmark Gallery

**Summary** (Chrome ≤ 132 characters, AMO ≤ 250):

> See every bookmark as a visual gallery with previews, recipe cards and insights — and clean out duplicates and dead links.

**Description:**

> Bookmark Gallery turns your bookmarks into something you can actually browse.
>
> **Bookmarks** — every bookmark in one fast list with the page's title, description
> and preview image. Search, filter by category, sort by date or title, or group
> by website or by your own folders. Handles collections of 30,000+ bookmarks.
>
> **Views** — focused galleries for particular kinds of bookmark:
> • Images — a masonry wall of every image you've saved.
> • Recipes — your saved recipes as recipe cards with photo, time, rating and
>   servings; open one for the ingredients and step-by-step method.
>
> **Insights** — how many bookmarks you have and since when, what you saved each
> year, which links have died (and how link rot grows with age), why links fail,
> your biggest folders, and when you tend to bookmark.
>
> **Clean up** — find duplicates (ignoring http/https, www, tracking parameters),
> broken links and empty folders, or let Smart cleanup file loose bookmarks into
> folders by category. Everything removed goes to a trash and can be restored to
> its original folder and position; every Smart cleanup move can be undone.
>
> **Private by design** — no account, no server, no analytics. Previews are read
> straight from the sites you bookmarked (without your cookies) and stored only
> on your device.
>
> Open source: https://github.com/rocket1/bookmark-gallery

**Category:** AMO — *Bookmarks*. Chrome — *Productivity › Tools* (or *Workflow & Planning*).

**Tags / keywords:** bookmarks, bookmark manager, gallery, recipes, duplicates,
broken links, organizer

**Homepage:** https://github.com/rocket1/bookmark-gallery

**Support:** https://github.com/rocket1/bookmark-gallery/issues

**Privacy policy URL:** https://github.com/rocket1/bookmark-gallery/blob/main/docs/PRIVACY.md

## Images you still need to make

- **Screenshots** — Chrome: 1–5 at **1280×800** (or 640×400). AMO: any size, a few
  of the same. Use your real collection for these: the Bookmarks list, Insights,
  the Recipes view with a recipe open, and Clean up.
- **Chrome small promo tile** — **440×280**.
- Icons are already in the package (`icons/png/logo-128.png` is the store icon).

## Chrome Web Store — privacy practices tab

**Single purpose:**

> Lets the user browse, analyse and tidy up their own bookmarks in a visual gallery.

**Permission justifications:**

- **bookmarks** — The extension's whole purpose is showing the user's bookmarks. It
  reads them to display, search and analyse them, and changes them only when the
  user runs a clean-up action (remove duplicates/broken links, delete empty folders,
  reorganise, restore from trash).
- **storage** — Caches each bookmark's preview (title, description, image address)
  and the user's view settings and trash on the device, so pages aren't re-fetched
  on every visit.
- **unlimitedStorage** — The preview cache for a large collection (tens of thousands
  of bookmarks) exceeds the default 10 MB quota.
- **Host permission `<all_urls>`** — Bookmarks can point to any website. The extension
  requests each bookmarked page (without cookies) to read its Open Graph preview and
  recipe data and to detect broken links. No content is injected into any site.

**Remote code:** No — all code ships in the package; nothing is loaded from elsewhere.

**Data usage** — a judgment call worth reading Chrome's current wording for. Nothing
leaves the device, but the extension *handles* browsing data, so the conservative
answer is to tick **Web history** (bookmarked addresses) and **Website content**
(page previews), then certify all three statements: not sold to third parties,
not used for purposes unrelated to the single purpose, not used for
creditworthiness or lending.

## AMO — submission notes

**Data collection** (`data_collection_permissions: none` in the manifest): the
extension transmits nothing to the developer or third parties. Its only requests go
to the sites the user bookmarked.

**Notes to reviewer:**

> No build step and no minified or bundled code — the uploaded files are the source
> (repository: https://github.com/rocket1/bookmark-gallery). `<all_urls>` is used by
> fetch() from the extension page to read each bookmarked page's Open Graph tags
> (credentials: "omit", referrerPolicy: "no-referrer") and to read image headers for
> the Images view. Page HTML is parsed with DOMParser and only extracted text is
> inserted, via textContent. No content scripts.

**Support for Firefox for Android:** none (no bookmarks API there) — leave it unticked.

## Distributing outside the stores

- **Firefox:** submit as *self-distributed* ("On your own") on AMO to get a signed
  `.xpi`, then attach it to a GitHub Release. Unsigned add-ons can't be installed
  permanently in release Firefox.
- **Chrome:** users can load `dist/chrome` with "Load unpacked" (Developer mode),
  but Chrome shows a warning at every start; the Web Store is the real route.

## Third-party views

Store rules (Manifest V3, and AMO's policies) forbid loading code that isn't in
the package, so view plugins can't be installed separately. New views are
contributed as pull requests to `pages/views/` (see `pages/views/README.md`) and
ship in the next release.
