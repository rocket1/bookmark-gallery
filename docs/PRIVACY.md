# Bookmark Gallery — Privacy Policy

_Last updated: October 15, 2026_

Bookmark Gallery is a browser extension for Firefox and Chrome that shows your
bookmarks as a visual gallery, with insights and clean-up tools. It is built so
that **your data never leaves your browser**. There is no account, no server, no
analytics and no tracking.

## What the extension reads

- **Your bookmarks** (titles, addresses, folders, dates added), through the
  browser's bookmarks API, to display, search, group and analyse them.
- **The web pages you have bookmarked.** To show a preview (title, description,
  image) and to tell whether a link still works, the extension requests each
  bookmarked page directly from that website — the same page you saved. These
  requests are sent **without your cookies and without a referrer**, so the site
  sees an anonymous visit, not a logged-in one. For Reddit post links it uses
  Reddit's official embed endpoint (`reddit.com/oembed`) instead of the page.
- **Preview images** (and, for image bookmarks, the first few kilobytes of the
  image to read its size) are loaded from the sites that host them, the same way
  any web page loads an image.

Pages are only requested when you scroll to a bookmark, open a view that needs it,
or start "Check remaining" yourself.

## What the extension stores

Everything is kept in the browser's own extension storage on your device:

- previews read from your bookmarked pages (title, description, image address,
  category, and recipe details for recipe pages);
- image sizes, so the Images view can lay out quickly;
- your view preferences;
- a trash of bookmarks you removed through the extension, so they can be restored.

This data is not synced or uploaded anywhere. Uninstalling the extension deletes it.
"Refresh all previews" and "Empty trash" clear parts of it at any time.

## What the extension changes

It only changes your bookmarks when you ask it to: removing duplicates or broken
links, deleting empty folders, reorganising with Smart cleanup, or restoring from
its trash. Every change is recorded so it can be undone.

## What is shared

Nothing. The developer receives no data of any kind. No data is sold, shared with
third parties, or used for advertising, profiling or any purpose other than the
features described above. The only network requests are the ones described in
"What the extension reads", and they go to the websites you bookmarked.

## Permissions

| Permission | Why |
|---|---|
| Bookmarks | Read your bookmarks to show them; change them only when you use a clean-up action. |
| Storage / unlimited storage | Keep the preview cache on your device. Large collections need more than the default 10 MB (Chrome). |
| Access to all websites | Bookmarks can point at any site, so the extension needs to be allowed to request any of them to read its preview and check whether it still works. |

## Changes and contact

If this policy changes, the new version will be published at this address with a
new date. Questions or concerns: open an issue at
<https://github.com/rocket1/bookmark-gallery/issues>.
