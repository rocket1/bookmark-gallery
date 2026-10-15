"use strict";

/* ============================================================
   Recipes view plugin
   ============================================================
   Shows every recipe bookmark as a card. extract() reads the schema.org
   Recipe data most recipe sites publish (JSON-LD, or microdata on older
   sites) when a page is fetched; clicking a card opens a full recipe sheet
   with ingredients and method. Bookmarks guessed to be recipes but without
   that data still get a simpler card that opens the original page.

   Everything read from a page is reduced to plain text and only ever put
   into the DOM with textContent; image URLs must be http(s).
*/

(() => {
  const DATA_VERSION = 1;    // bump when extract() changes — matching recipes are re-fetched once
  const PAGE_SIZE = 48;      // cards rendered per "page" of the infinite scroll
  const MAX_LIST = 120;      // ingredients / steps kept per recipe
  const MAX_TEXT = 1200;     // characters per step or description
  const MAX_SHORT = 300;     // characters per ingredient, name, tag, …
  const FOOD_EMOJI = ["🍲", "🥘", "🍝", "🥗", "🍛", "🥧", "🍜", "🍰", "🥞", "🌮", "🍳", "🥐"];

  /* ---------- Extraction (runs on every fetched page) ---------- */

  const htmlParser = new DOMParser(); // documents it makes are inert: no scripts, no image loads

  function clip(s, max) {
    return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
  }

  // JSON-LD strings often carry HTML tags and entities ("Salt &amp; pepper").
  function plainText(value, max = MAX_SHORT) {
    if (value == null) return "";
    if (typeof value === "object") value = value.text || value.name || "";
    let s = String(value);
    if (/[<&]/.test(s)) s = htmlParser.parseFromString(s, "text/html").body.textContent || "";
    return clip(s.replace(/\s+/g, " ").trim(), max);
  }

  function list(value) {
    if (value == null || value === "") return [];
    return Array.isArray(value) ? value : [value];
  }

  function hasType(node, name) {
    return list(node["@type"]).some((t) => typeof t === "string" && t.replace(/^.*[/:]/, "").toLowerCase() === name);
  }

  function findRecipeNode(items) {
    const queue = [...items];
    for (let seen = 0; queue.length && seen < 500; seen++) {
      const node = queue.shift();
      if (!node || typeof node !== "object") continue;
      if (Array.isArray(node)) { queue.push(...node); continue; }
      if (hasType(node, "recipe")) return node;
      if (node["@graph"]) queue.push(node["@graph"]);
      if (node.mainEntity) queue.push(node.mainEntity);
      if (node.mainEntityOfPage && typeof node.mainEntityOfPage === "object") queue.push(node.mainEntityOfPage);
    }
    return null;
  }

  function httpUrl(value, base) {
    for (const item of list(value)) {
      const raw = typeof item === "string" ? item : item && (item.url || item.contentUrl || item["@id"]);
      if (typeof raw !== "string") continue;
      try {
        const url = new URL(raw, base);
        if (url.protocol === "http:" || url.protocol === "https:") return url.href;
      } catch (e) { /* not a URL */ }
    }
    return "";
  }

  // ISO 8601 durations ("PT1H30M", "P0DT0H45M") -> minutes.
  function minutes(value) {
    const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i
      .exec(String(value || "").trim());
    if (!m) return null;
    const total = Math.round((+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0) + (+m[4] || 0) / 60);
    return total > 0 ? total : null;
  }

  function servings(value) {
    const items = list(value).map((v) => plainText(v, 60)).filter(Boolean);
    // Sites often give ["4", "4 servings"] — prefer the one with words.
    const best = items.find((v) => /[a-z]/i.test(v)) || items[0] || "";
    return /^\d+(\.\d+)?$/.test(best) ? `${best} servings` : best;
  }

  function titleCase(s) {
    return s.replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function tags(value) {
    const seen = new Set();
    const out = [];
    for (const v of list(value)) {
      for (const part of plainText(v).split(/\s*,\s*/)) {
        const tag = titleCase(part.trim());
        if (tag && tag.length <= 40 && !seen.has(tag.toLowerCase())) {
          seen.add(tag.toLowerCase());
          out.push(tag);
        }
      }
    }
    return out.slice(0, 4);
  }

  function personName(value) {
    for (const v of list(value)) {
      const name = plainText(typeof v === "string" ? v : v && v.name, 80);
      if (name) return name;
    }
    return "";
  }

  // A single instructions string may hold a whole HTML list, or one step per line.
  function splitSteps(s) {
    if (/</.test(s)) {
      const doc = htmlParser.parseFromString(s, "text/html");
      const blocks = [...doc.querySelectorAll("li, p")].map((el) => plainText(el.textContent, MAX_TEXT)).filter(Boolean);
      if (blocks.length) return blocks;
      s = doc.body.textContent || "";
    }
    return s.split(/\r?\n+/).map((line) => plainText(line, MAX_TEXT)).filter(Boolean);
  }

  // -> [{ title, steps: [string] }]: HowToSections become titled groups.
  function instructions(value) {
    const sections = [{ title: "", steps: [] }];
    let count = 0;
    const addStep = (text) => {
      if (text && count < MAX_LIST) {
        sections[sections.length - 1].steps.push(text);
        count += 1;
      }
    };
    const walk = (item, depth) => {
      if (depth > 4 || item == null) return;
      if (typeof item === "string") return splitSteps(item).forEach(addStep);
      if (Array.isArray(item)) return item.forEach((sub) => walk(sub, depth + 1));
      if (typeof item !== "object") return;
      if (hasType(item, "howtosection") || (item.itemListElement && !item.text)) {
        sections.push({ title: plainText(item.name, 80), steps: [] });
        walk(item.itemListElement, depth + 1);
        sections.push({ title: "", steps: [] });
        return;
      }
      addStep(plainText(item.text || item.name || item.description, MAX_TEXT));
    };
    walk(value, 0);
    return sections.filter((s) => s.steps.length);
  }

  function rating(value) {
    if (!value || typeof value !== "object") return null;
    const raw = parseFloat(value.ratingValue);
    const best = parseFloat(value.bestRating) || 5;
    if (!(raw > 0)) return null;
    const count = parseInt(value.ratingCount || value.reviewCount, 10) || 0;
    return { value: Math.round(Math.min(5, (raw / best) * 5) * 10) / 10, count };
  }

  function fromJsonLd(node, base) {
    const prep = minutes(node.prepTime);
    const cook = minutes(node.cookTime);
    return {
      name: plainText(node.name || node.headline),
      description: plainText(node.description, 500),
      image: httpUrl(node.image || node.thumbnailUrl, base),
      author: personName(node.author),
      prepMin: prep,
      cookMin: cook,
      totalMin: minutes(node.totalTime) || (prep || cook ? (prep || 0) + (cook || 0) : null),
      servings: servings(node.recipeYield || node.yield),
      ingredients: list(node.recipeIngredient || node.ingredients)
        .map((v) => plainText(v)).filter(Boolean).slice(0, MAX_LIST),
      instructions: instructions(node.recipeInstructions),
      course: tags(node.recipeCategory),
      cuisine: tags(node.recipeCuisine),
      rating: rating(node.aggregateRating),
      calories: plainText(node.nutrition && node.nutrition.calories, 40),
    };
  }

  // Older recipe sites mark recipes up with itemprop attributes instead.
  function fromMicrodata(root, base) {
    const props = (name) => [...root.querySelectorAll(`[itemprop~="${name}"]`)];
    const value = (el) => el && (el.getAttribute("content") || el.getAttribute("datetime") ||
      el.getAttribute("src") || el.getAttribute("href") || el.textContent) || "";
    const first = (name) => value(props(name)[0]);
    const ratingEl = props("aggregateRating")[0];
    const prep = minutes(first("prepTime"));
    const cook = minutes(first("cookTime"));
    const steps = props("recipeInstructions").flatMap((el) => {
      const items = [...el.querySelectorAll("li")];
      return items.length ? items.map((li) => li.textContent) : splitSteps(el.textContent);
    });
    return {
      name: plainText(first("name")),
      description: plainText(first("description"), 500),
      image: httpUrl(first("image"), base),
      author: plainText(first("author"), 80),
      prepMin: prep,
      cookMin: cook,
      totalMin: minutes(first("totalTime")) || (prep || cook ? (prep || 0) + (cook || 0) : null),
      servings: servings(first("recipeYield")),
      ingredients: [...props("recipeIngredient"), ...props("ingredients")]
        .map((el) => plainText(el.textContent)).filter(Boolean).slice(0, MAX_LIST),
      instructions: instructions(steps),
      course: tags(props("recipeCategory").map(value)),
      cuisine: tags(props("recipeCuisine").map(value)),
      rating: ratingEl ? rating({
        ratingValue: value(ratingEl.querySelector('[itemprop="ratingValue"]')),
        bestRating: value(ratingEl.querySelector('[itemprop="bestRating"]')),
        ratingCount: value(ratingEl.querySelector('[itemprop="ratingCount"], [itemprop="reviewCount"]')),
      }) : null,
      calories: plainText(first("calories"), 40),
    };
  }

  function extract({ doc, url, jsonLd }) {
    const node = findRecipeNode(jsonLd);
    let recipe = null;
    if (node) recipe = fromJsonLd(node, url);
    else {
      const root = doc.querySelector('[itemtype*="schema.org/Recipe" i]');
      if (root) recipe = fromMicrodata(root, url);
    }
    // A "recipe" with neither ingredients nor steps is just a page about food.
    if (!recipe || (!recipe.ingredients.length && !recipe.instructions.length)) return null;
    return recipe;
  }

  /* ---------- Formatting helpers ---------- */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function formatMinutes(min) {
    if (!min) return "";
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (h >= 24) return `${Math.round(h / 24)} d`;
    return m ? `${h} h ${m} min` : `${h} h`;
  }

  function hashOf(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  function stars(r) {
    const wrap = el("span", "recipe-rating");
    const bar = el("span", "recipe-stars");
    bar.style.setProperty("--rating", r.value);
    bar.setAttribute("aria-label", `Rated ${r.value} out of 5`);
    wrap.append(bar, el("span", "recipe-rating-text",
      r.value.toFixed(1) + (r.count ? ` (${r.count.toLocaleString()})` : "")));
    return wrap;
  }

  // The card/sheet image, or a warm gradient with a food emoji when there
  // is none (or it fails to load).
  // Card images are fetched by this observer well before they scroll into
  // view (native loading="lazy" waits until the very edge in Firefox, so
  // images visibly popped in), and only shown once decoded, so a large photo
  // never decodes mid-scroll.
  let imageObserver = null;
  const deferredImages = new WeakMap(); // media box -> { img, src } not started yet

  function startImage(box) {
    const pending = deferredImages.get(box);
    if (!pending) return;
    deferredImages.delete(box);
    if (imageObserver) imageObserver.unobserve(box);
    pending.img.src = pending.src;
  }

  function media(className, entry, { eager = false } = {}) {
    const box = el("div", className);
    const seed = hashOf(entry.bookmark.url);
    box.style.setProperty("--hue", String(seed % 360));
    const fallback = el("span", "recipe-emoji", FOOD_EMOJI[seed % FOOD_EMOJI.length]);
    fallback.setAttribute("aria-hidden", "true");
    box.appendChild(fallback);
    if (entry.image) {
      // Only this image area pulses until the image arrives (or fails, leaving the emoji).
      box.classList.add("is-loading");
      const img = document.createElement("img");
      img.alt = "";
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      const fail = () => {
        img.remove();
        box.classList.remove("is-loading");
      };
      img.addEventListener("load", () => {
        const show = () => box.classList.replace("is-loading", "has-image");
        img.decode().then(show, () => (img.naturalWidth ? show() : fail()));
      });
      img.addEventListener("error", fail);
      box.appendChild(img);
      deferredImages.set(box, { img, src: entry.image });
      if (eager || !imageObserver) startImage(box);
      else imageObserver.observe(box);
    }
    return box;
  }

  /* ---------- View ---------- */

  const state = {
    ctx: null,
    entries: [],           // every recipe bookmark, as of the last render
    visible: [],           // after search / type filter / sort
    shown: PAGE_SIZE,
    query: "",
    type: "all",           // "all" | "course:<x>" | "cuisine:<x>" | "time:<max minutes>"
    sort: "default",
    entryCache: new Map(), // url -> entry, reused while its record is unchanged (keeps cards and loaded images)
    lastFocus: null,
  };
  const ui = {};

  function entryFor(bookmark, ctx) {
    const record = ctx.record(bookmark);
    const pending = ctx.isPending(bookmark);
    const cached = state.entryCache.get(bookmark.url);
    if (cached && cached.record === record && cached.pending === pending && cached.bookmark.title === bookmark.title) {
      cached.bookmark = bookmark;
      return cached;
    }
    const recipe = ctx.data(bookmark);
    const ok = record && record.status === "ok" ? record : null;
    const entry = {
      bookmark,
      record,
      pending,
      recipe,
      title: (recipe && recipe.name) || (ok && ok.ogTitle) || bookmark.title,
      image: (recipe && recipe.image) || (ok && ok.ogImage) || "",
      site: (ok && ok.ogSiteName) || ctx.hostname(bookmark.url).replace(/^www\./, ""),
      description: (recipe && recipe.description) || (ok && ok.ogDescription) || "",
      card: null,
      // A card is rebuilt when its fetch finishes; keep the already-loaded image
      // so it doesn't fade in all over again.
      media: cached && cached.image === ((recipe && recipe.image) || (ok && ok.ogImage) || "") ? cached.media : null,
    };
    entry.haystack = [
      entry.title, entry.site, entry.description,
      ...(recipe ? [...recipe.ingredients, ...recipe.course, ...recipe.cuisine, recipe.author] : []),
    ].join("\n").toLowerCase();
    state.entryCache.set(bookmark.url, entry);
    return entry;
  }

  function mount(panel, ctx) {
    state.ctx = ctx;

    const toolbar = el("div", "recipes-toolbar");
    ui.search = el("input", "recipes-search");
    ui.search.type = "search";
    ui.search.placeholder = "Search recipes or ingredients…";
    ui.search.autocomplete = "off";
    ui.search.spellcheck = false;

    ui.type = el("select", "recipes-select");
    ui.type.title = "Filter by course, cuisine or time";

    ui.sort = el("select", "recipes-select");
    ui.sort.title = "Sort order";
    for (const [value, label] of [
      ["default", "Bookmark order"], ["newest", "Newest first"], ["quickest", "Quickest first"],
      ["rating", "Top rated"], ["title", "Title A–Z"],
    ]) ui.sort.appendChild(new Option(label, value));

    ui.count = el("p", "count-label recipes-count");
    toolbar.append(ui.search, ui.type, ui.sort, ui.count);

    ui.scroll = el("div", "recipes-scroll");
    ui.grid = el("div", "recipes-grid");
    ui.sentinel = el("div", "recipes-sentinel");
    ui.empty = el("p", "empty-state",
      "No recipe bookmarks found yet. Recipes are recognised from a page's recipe data, or a recipe-sounding " +
      "title or site — use \"Check remaining\" in the header to check more bookmarks.");
    ui.empty.hidden = true;
    ui.scroll.append(ui.grid, ui.sentinel, ui.empty);

    ui.overlay = buildOverlay();
    panel.append(toolbar, ui.scroll, ui.overlay);

    let searchTimer = null;
    ui.search.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.query = ui.search.value.trim().toLowerCase();
        applyFilters(true);
      }, 150);
    });
    ui.type.addEventListener("change", () => { state.type = ui.type.value; applyFilters(true); });
    ui.sort.addEventListener("change", () => { state.sort = ui.sort.value; applyFilters(true); });

    imageObserver = new IntersectionObserver((records) => {
      for (const r of records) if (r.isIntersecting) startImage(r.target);
    }, { root: ui.scroll, rootMargin: "1200px 0px" });

    // Infinite scroll: another page of cards when the bottom comes near. The
    // observer only fires when that changes, so after adding a page that
    // still leaves the bottom in range (a tall window), keep going.
    new IntersectionObserver((records) => {
      if (records.some((r) => r.isIntersecting)) showMoreIfNearEnd();
    }, { root: ui.scroll, rootMargin: "800px 0px" }).observe(ui.sentinel);

    ui.grid.addEventListener("click", (e) => {
      if (e.target.closest("a")) return; // the card's own "open page" link
      const card = e.target.closest(".recipe-card");
      if (card) openEntry(card);
    });
    ui.grid.addEventListener("keydown", (e) => {
      const card = e.target.closest(".recipe-card");
      if (card && e.target === card && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        openEntry(card);
      }
    });
  }

  function render(bookmarks, ctx) {
    state.ctx = ctx;
    state.entries = bookmarks.map((b) => entryFor(b, ctx));
    const urls = new Set(bookmarks.map((b) => b.url));
    for (const url of state.entryCache.keys()) if (!urls.has(url)) state.entryCache.delete(url);
    // Fetch unchecked recipes, and re-read ones checked before this view existed.
    bookmarks.forEach(ctx.ensureData);
    renderTypeOptions();
    applyFilters(false);
  }

  function renderTypeOptions() {
    const course = new Map();
    const cuisine = new Map();
    for (const { recipe } of state.entries) {
      if (!recipe) continue;
      recipe.course.forEach((t) => course.set(t, (course.get(t) || 0) + 1));
      recipe.cuisine.forEach((t) => cuisine.set(t, (cuisine.get(t) || 0) + 1));
    }
    const top = (map) => [...map].sort((a, b) => b[1] - a[1]).slice(0, 25);
    const topCourse = top(course);
    const topCuisine = top(cuisine);
    // Only rebuild when the choices changed, so an open dropdown isn't reset mid-fetch.
    const signature = JSON.stringify([topCourse, topCuisine]);
    if (signature === ui.typeSignature) return;
    ui.typeSignature = signature;

    const options = [new Option("All recipes", "all")];
    const group = (label, items) => {
      if (!items.length) return;
      const g = document.createElement("optgroup");
      g.label = label;
      items.forEach(([value, text]) => g.appendChild(new Option(text, value)));
      options.push(g);
    };
    group("Time", [["time:30", "Ready in 30 min"], ["time:60", "Ready in 1 hour"]]);
    group("Course", topCourse.map(([t, n]) => [`course:${t}`, `${t} (${n})`]));
    group("Cuisine", topCuisine.map(([t, n]) => [`cuisine:${t}`, `${t} (${n})`]));

    ui.type.replaceChildren(...options);
    const stillThere = [...ui.type.querySelectorAll("option")].some((o) => o.value === state.type);
    if (!stillThere) state.type = "all";
    ui.type.value = state.type;
  }

  function matchesType(entry) {
    if (state.type === "all") return true;
    const split = state.type.indexOf(":");
    const kind = state.type.slice(0, split);
    const value = state.type.slice(split + 1);
    const r = entry.recipe;
    if (!r) return false;
    if (kind === "time") return r.totalMin != null && r.totalMin <= +value;
    return (kind === "course" ? r.course : r.cuisine).includes(value);
  }

  function applyFilters(resetScroll) {
    let visible = state.entries.filter((e) => matchesType(e) && (!state.query || e.haystack.includes(state.query)));
    const last = (v) => (v == null ? Infinity : v);
    if (state.sort === "newest") visible.sort((a, b) => b.bookmark.dateAdded - a.bookmark.dateAdded);
    else if (state.sort === "title") visible.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
    else if (state.sort === "quickest") visible.sort((a, b) => last(a.recipe && a.recipe.totalMin) - last(b.recipe && b.recipe.totalMin));
    else if (state.sort === "rating") {
      const score = (e) => (e.recipe && e.recipe.rating ? e.recipe.rating.value * 1e7 + e.recipe.rating.count : -1);
      visible.sort((a, b) => score(b) - score(a));
    }
    state.visible = visible;
    if (resetScroll) {
      state.shown = PAGE_SIZE;
      ui.scroll.scrollTop = 0;
    }
    drawGrid();
  }

  function showMoreIfNearEnd() {
    if (state.shown >= state.visible.length || ui.scroll.clientHeight === 0) return;
    const gap = ui.sentinel.getBoundingClientRect().top - ui.scroll.getBoundingClientRect().bottom;
    if (gap > 800) return;
    state.shown += PAGE_SIZE;
    drawGrid();
    requestAnimationFrame(showMoreIfNearEnd);
  }

  // Puts the cards in order while leaving every card that's already in the
  // right place untouched: re-inserting a card restarts its animations and
  // costs layout, and doing that to hundreds of cards on each page or
  // re-render is what made scrolling stutter. A new page is just appended.
  function syncChildren(parent, wanted) {
    let current = parent.firstChild;
    for (const node of wanted) {
      if (node === current) current = current.nextSibling;
      else parent.insertBefore(node, current);
    }
    while (current) {
      const next = current.nextSibling;
      current.remove();
      current = next;
    }
  }

  function drawGrid() {
    const shown = state.visible.slice(0, state.shown);
    syncChildren(ui.grid, shown.map((entry) => entry.card || (entry.card = buildCard(entry))));

    const total = state.entries.length;
    const full = state.entries.filter((e) => e.recipe).length;
    const pending = state.entries.filter((e) => e.pending).length;
    const ctx = state.ctx;
    let label = ctx.plural(total, "recipe");
    if (state.visible.length !== total) label = `${state.visible.length.toLocaleString()} of ${label}`;
    if (total) label += ` · ${full.toLocaleString()} with full recipe cards`;
    if (pending) label += ` · reading ${pending.toLocaleString()}…`;
    ui.count.textContent = label;
    ui.empty.hidden = total > 0 || pending > 0;
    if (total > 0 && state.visible.length === 0) {
      ui.empty.hidden = false;
      ui.empty.textContent = "No recipes match your search.";
    } else {
      ui.empty.textContent = "No recipe bookmarks found yet. Recipes are recognised from a page's recipe data, or a " +
        "recipe-sounding title or site — use \"Check remaining\" in the header to check more bookmarks.";
    }
  }

  function buildCard(entry) {
    const { bookmark, recipe } = entry;
    const card = el("article", "recipe-card");
    card.tabIndex = 0;
    // Same shared-clock phase as the app's other loading pulses (1.3s shimmer).
    card.style.setProperty("--shimmer-delay", -(performance.now() % 1300) + "ms");
    card.dataset.url = bookmark.url;
    if (!recipe) card.classList.add("is-basic");

    const top = entry.media || (entry.media = media("recipe-card-media", entry));
    top.querySelectorAll(".recipe-time-badge, .recipe-card-open").forEach((n) => n.remove()); // from a previous card
    if (recipe && recipe.totalMin) top.appendChild(el("span", "recipe-time-badge", `⏱ ${formatMinutes(recipe.totalMin)}`));
    const open = el("a", "recipe-card-open", "↗");
    open.href = bookmark.url;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    open.title = "Open the original page";
    top.appendChild(open);

    const body = el("div", "recipe-card-body");
    body.appendChild(el("div", "recipe-card-site", entry.site));
    body.appendChild(el("h3", "recipe-card-title", entry.title));
    if (recipe && recipe.rating) body.appendChild(stars(recipe.rating));
    if (entry.description) body.appendChild(el("p", "recipe-card-desc", entry.description));

    const meta = el("div", "recipe-card-meta");
    if (recipe) {
      if (recipe.servings) meta.appendChild(el("span", "recipe-chip", `🍽 ${recipe.servings}`));
      if (recipe.ingredients.length) meta.appendChild(el("span", "recipe-chip", `🧺 ${recipe.ingredients.length} ingredients`));
      if (recipe.calories) meta.appendChild(el("span", "recipe-chip", `🔥 ${recipe.calories}`));
      [...recipe.cuisine, ...recipe.course].slice(0, 3).forEach((t) => meta.appendChild(el("span", "recipe-chip recipe-tag", t)));
    } else if (entry.pending) {
      meta.appendChild(el("span", "recipe-chip recipe-chip-muted recipe-chip-pending", "Reading recipe…"));
    } else {
      meta.appendChild(el("span", "recipe-card-note", "No recipe details · opens the original ↗"));
    }
    if (meta.childElementCount) body.appendChild(meta);

    card.append(top, body);
    return card;
  }

  function openEntry(card) {
    const entry = state.entryCache.get(card.dataset.url);
    if (!entry) return;
    if (!entry.recipe) {
      window.open(entry.bookmark.url, "_blank", "noopener");
      return;
    }
    state.lastFocus = card;
    fillSheet(entry);
    ui.overlay.hidden = false;
    ui.sheet.scrollTop = 0;
    ui.close.focus();
  }

  /* ---------- Recipe sheet (detail overlay) ---------- */

  function buildOverlay() {
    const overlay = el("div", "recipe-overlay");
    overlay.hidden = true;
    const sheet = ui.sheet = el("article", "recipe-sheet");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-labelledby", "recipe-sheet-title");
    ui.close = el("button", "recipe-sheet-close", "×");
    ui.close.title = "Close (Esc)";
    ui.sheetBody = el("div", "recipe-sheet-body");
    sheet.append(ui.close, ui.sheetBody);
    overlay.appendChild(sheet);

    ui.close.addEventListener("click", closeSheet);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeSheet(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !overlay.hidden) {
        e.preventDefault();
        closeSheet();
      }
    });
    return overlay;
  }

  function closeSheet() {
    ui.overlay.hidden = true;
    if (state.lastFocus && state.lastFocus.isConnected) state.lastFocus.focus();
  }

  function fillSheet(entry) {
    const { bookmark, recipe } = entry;

    const hero = media("recipe-sheet-hero", entry, { eager: true });
    const heading = el("div", "recipe-sheet-heading");
    heading.appendChild(el("div", "recipe-card-site", entry.site + (recipe.author ? ` · by ${recipe.author}` : "")));
    const title = el("h2", "recipe-sheet-title", entry.title);
    title.id = "recipe-sheet-title";
    heading.appendChild(title);
    if (recipe.rating) heading.appendChild(stars(recipe.rating));
    hero.appendChild(heading);

    const stats = el("div", "recipe-stats");
    const stat = (label, value) => {
      if (!value) return;
      const s = el("div", "recipe-stat");
      s.append(el("span", "recipe-stat-value", value), el("span", "recipe-stat-label", label));
      stats.appendChild(s);
    };
    stat("Prep", formatMinutes(recipe.prepMin));
    stat("Cook", formatMinutes(recipe.cookMin));
    stat("Total", formatMinutes(recipe.totalMin));
    stat("Yield", recipe.servings);
    stat("Calories", recipe.calories);

    const columns = el("div", "recipe-columns");

    const ingredients = el("section", "recipe-ingredients");
    const ingHead = el("div", "recipe-section-head");
    ingHead.appendChild(el("h3", null, "Ingredients"));
    if (recipe.ingredients.length) {
      const copy = el("button", "btn btn-ghost btn-small", "Copy");
      copy.title = "Copy the ingredient list";
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(recipe.ingredients.map((i) => `• ${i}`).join("\n"));
          copy.textContent = "Copied ✓";
        } catch (e) {
          copy.textContent = "Couldn't copy";
        }
        setTimeout(() => { copy.textContent = "Copy"; }, 2000);
      });
      ingHead.appendChild(copy);
    }
    ingredients.appendChild(ingHead);
    const ingList = el("ul", "recipe-ingredient-list");
    for (const text of recipe.ingredients) {
      const li = el("li");
      const label = el("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      label.append(box, el("span", null, text));
      li.appendChild(label);
      ingList.appendChild(li);
    }
    if (!recipe.ingredients.length) ingList.appendChild(el("li", "recipe-none", "Not listed — see the original page."));
    ingredients.appendChild(ingList);

    const method = el("section", "recipe-method");
    method.appendChild(el("div", "recipe-section-head")).appendChild(el("h3", null, "Method"));
    for (const section of recipe.instructions) {
      if (section.title) method.appendChild(el("h4", "recipe-method-section", section.title));
      const ol = el("ol", "recipe-steps");
      for (const step of section.steps) {
        const li = el("li", null, step);
        li.title = "Click to mark as done";
        li.addEventListener("click", () => li.classList.toggle("done"));
        ol.appendChild(li);
      }
      method.appendChild(ol);
    }
    if (!recipe.instructions.length) method.appendChild(el("p", "recipe-none", "No steps listed — see the original page."));

    columns.append(ingredients, method);

    const footer = el("div", "recipe-sheet-footer");
    const open = el("a", "btn btn-secondary", "Open original recipe ↗");
    open.href = bookmark.url;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    footer.appendChild(open);
    if (bookmark.folderPath) footer.appendChild(el("span", "recipe-folder", `📁 ${bookmark.folderPath}`));

    const parts = [hero, stats];
    if (recipe.description) parts.push(el("p", "recipe-sheet-desc", recipe.description));
    parts.push(columns, footer);
    ui.sheetBody.replaceChildren(...parts);
    if (!stats.childElementCount) stats.remove();
  }

  BookmarkGallery.registerView({
    id: "recipes",
    label: "Recipes",
    title: "Your recipe bookmarks as recipe cards",
    stylesheet: "views/recipes.css",
    dataVersion: DATA_VERSION,
    // Anything whose page carries recipe data, plus anything that looks like a recipe.
    match: (bookmark, ctx) => ctx.data(bookmark) != null || ctx.category(bookmark) === "Recipes",
    extract,
    mount,
    render,
  });
})();
