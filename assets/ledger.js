/* The Absence Audit — the ledger engine (shared by /ledger/ and /dossier/).
 *
 * ONE renderer, two mounts, three access states. The ledger table is the
 * centre of the site; signing in does not move you to another room — it
 * unlocks rows in the room you are already in.
 *
 * Mounts (static markup supplied by the page):
 *   /ledger/   AA_LEDGER_PAGE = { mine: false }   public explore surface
 *   /dossier/  AA_LEDGER_PAGE = { mine: true }    "My ledger" — same surface,
 *                                                 personalized in place
 *
 * Access model, evaluated per row:
 *   "sub"  aa_sub=1 cookie (invited subscriber)      -> open + price chip
 *   "all"  signed in, plan=all (Full Ledger Access)  -> open + price chip
 *   "own"  signed in, owns this dossier              -> open + price chip
 *   "in"   signed in, does not own this dossier      -> buy CTA
 *   "none" anonymous                                 -> buy / free / autopsy
 * Every row shows its EUR price for every visitor class (owner 2026-09-07:
 * concepts must be priced in the ledger, full stop). Stripe charges EUR —
 * the engine mirrors the charge currency, never the old USD display.
 *
 * The engine subscribes to window.AA (the auth module) and re-renders the
 * moment the signed-in state changes, so sign-in and sign-out are felt on
 * this page immediately, without a reload.
 */
(function () {
  "use strict";
  var CFG = window.AA_LEDGER_PAGE || {};
  var MINE = !!CFG.mine;
  var DATA = window.AA_LEDGER_CFG || {};
  var META = window.AA_LEDGER || null;
  var FAIL_LABEL = DATA.fail_labels || {};
  var VOID_LABEL = DATA.void_labels || {};
  var SINGLES = DATA.singles || {};
  var FULL_ACCESS = DATA.full_access || {};
  var BATCH = DATA.batch || 50;
  var D = "/c/"; // the public concept page is the dossier door (vault pages are
  // local-only by SECURITY doctrine — option D delivers the report server-side)
  var FREE = "liquid-metal-nanoparticle-conductive-ink-via-ultrasonic-probe-cavitati";

  var all = [], view = [], shown = 0;
  var verdict = "all", viewmode = "grid", capexBand = "", bankBand = "";
  var timer = null;

  // ------------------------------------------------------------- favorites
  // Member-only (owner 2026-09-08): a star on every row and a Favorites
  // segment, so a member who finds a concept worth returning to never has
  // to search for it again. Signed-in members sync the list to Firestore
  // (users/<uid>, the one doc the security rules let an account write);
  // cookie subscribers (no Firebase account) keep a per-browser list in
  // localStorage. Anonymous visitors never see the surface — the public
  // ledger stays unchanged, and the member ledger diverges only at runtime
  // for entitled readers (the 2026-09-05 same-surface doctrine).
  var FAV_LS = "aa_favs_v1";
  var favs = {};         // slug -> 1 (the saved set)
  var favOnly = false;   // the Favorites segment is active
  var favMode = "none";  // "none" | "local" (cookie subscriber) | "cloud" (signed in)
  var favUid = null;     // the Firestore identity the cloud list belongs to
  var favLoaded = false; // a store has been read for the current identity

  function favList() { return Object.keys(favs); }
  function favLoadLocal() {
    favs = {};
    try {
      var a = JSON.parse(localStorage.getItem(FAV_LS) || "[]");
      if (!Array.isArray(a)) a = [];
      a.forEach(function (s) { favs[s] = 1; });
    } catch (e) {}
    favLoaded = true;
  }
  function favStore() {
    try { localStorage.setItem(FAV_LS, JSON.stringify(favList())); } catch (e) {}
  }
  function favDoc() {
    return firebase.firestore().collection("users").doc(favUid);
  }
  function favWrite(slug, add) {
    var op = add ? firebase.firestore.FieldValue.arrayUnion(slug)
                 : firebase.firestore.FieldValue.arrayRemove(slug);
    favDoc().set({
      favorites: op,
      updated_at: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true })
      .catch(function (e) { if (window.console) console.warn("favorites write failed", e); });
  }
  function favLoadCloud() {
    favDoc().get()
      .then(function (snap) {
        var arr = snap.exists ? ((snap.data() || {}).favorites || []) : [];
        if (!Array.isArray(arr)) arr = [];
        var cloud = {};
        arr.forEach(function (s) { cloud[s] = 1; });
        // Migration nicety: a list saved before signing in follows the
        // account instead of being orphaned in this browser.
        try {
          var a = JSON.parse(localStorage.getItem(FAV_LS) || "[]");
          if (Array.isArray(a)) a.forEach(function (s) { cloud[s] = 1; });
        } catch (e) {}
        var merged = Object.keys(cloud);
        favs = cloud;
        favLoaded = true;
        if (merged.length !== arr.length) {
          // browser had slugs the cloud list lacks — push the union once
          favDoc().set({
            favorites: merged,
            updated_at: firebase.firestore.FieldValue.serverTimestamp()
          }, { merge: true }).catch(function () {});
        }
        apply();
      })
      .catch(function () {
        // Rules or network denied the read: keep whatever we have; the star
        // surface stays live, the list just degrades to this session.
        favLoaded = true;
        apply();
      });
  }
  function favoritesSync() {
    var st = authState();
    var signedIn = !!(st && st.signedIn);
    var sub = subMode();
    var uid = (st && st.uid) || null;
    var fs = $("favseg");
    if (!signedIn && !sub) {
      favMode = "none"; favUid = null; favLoaded = false;
      favs = {}; favOnly = false;
      if (fs) fs.hidden = true;
      apply();
      return;
    }
    if (fs) fs.hidden = false;
    if (!signedIn) {
      // Cookie subscriber: local list, no account to sync to.
      if (favMode !== "local" || !favLoaded) {
        favMode = "local"; favUid = null; favLoaded = false;
        favLoadLocal();
      }
      apply();
      return;
    }
    // Signed in: the list lives under the account uid. The uid can lag the
    // ready state on the fast cache path — resolve via the shared boot when
    // it is not on the state yet.
    if (!uid) {
      if (window.AA && window.AA.boot) {
        window.AA.boot(function () {
          var u = firebase.auth().currentUser;
          var id = (u && u.uid) || null;
          if (id) {
            favMode = "cloud"; favUid = id; favLoaded = false;
            favLoadCloud();
          } else {
            apply();
          }
        });
      }
      return;
    }
    if (favMode !== "cloud" || favUid !== uid || !favLoaded) {
      favMode = "cloud"; favUid = uid; favLoaded = false;
      favLoadCloud();
      return;
    }
    apply();
  }
  function toggleFav(slug) {
    if (!slug || favMode === "none") return;
    var add = !favs[slug];
    if (add) favs[slug] = 1; else delete favs[slug];
    if (favMode === "cloud") favWrite(slug, add);
    else favStore();
    apply();
  }
  function favBtn(r) {
    if (favMode === "none") return "";
    var on = !!favs[r.s];
    return '<button type="button" class="favbtn' + (on ? " on" : "") + '" data-slug="' + esc(r.s) +
      '" aria-pressed="' + (on ? "true" : "false") + '" aria-label="' +
      (on ? "Remove " : "Save ") + esc(r.n) + (on ? " from" : " to") + ' favorites" title="' +
      (on ? "Remove from favorites" : "Save to favorites") + '">' +
      (on ? "&#9733;" : "&#9734;") + "</button>";
  }
  function favLabel() {
    var b = document.querySelector("#favseg button");
    if (!b) return;
    var n = favList().length;
    b.innerHTML = n ? "&#9733; Favorites (" + n + ")" : "&#9733; Favorites";
  }

  var $ = function (id) { return document.getElementById(id); };
  var results = $("results"), count = $("count"), more = $("more"), empty = $("empty");
  var q = $("q"), disc = $("disc"), fail = $("fail"), pay = $("pay"), sort = $("sort");
  if (!results || !q) return; // not a ledger page (safety)

  // ---------------------------------------------------------------- helpers
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtx(x) { return (x >= 2 ? "\u2265" : "") + (Math.round(x * 10) / 10) + "\u00d7"; }
  function subMode() { return document.cookie.indexOf("aa_sub=1") >= 0; }
  function authState() { return (window.AA && window.AA.getState) ? window.AA.getState() : null; }
  function tokens(s) {
    return s.toLowerCase().split(/\s+/).filter(function (t) { return t.length > 0; });
  }
  // The search haystack: name, discipline, incumbent, and the failure/void
  // labels spelled out (so "negative control" finds rows by reason, not code).
  function hay(r) {
    if (!r._h) {
      var parts = [r.n, r.d, r.i, r.m];
      (r.f || []).forEach(function (f) { parts.push(FAIL_LABEL[f] || f); });
      (r.o || "").split(",").forEach(function (c) {
        c = c.trim();
        if (c) parts.push(VOID_LABEL[c] || "");
      });
      r._h = parts.join(" ").toLowerCase();
    }
    return r._h;
  }
  // Levenshtein distance (capped): the typo budget for token matching.
  function editDist(a, b) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > 2) return 99;
    var m = a.length, n = b.length, d = [], i, j;
    for (i = 0; i <= m; i++) { d[i] = [i]; }
    for (j = 0; j <= n; j++) d[0][j] = j;
    for (i = 1; i <= m; i++) for (j = 1; j <= n; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    return d[m][n];
  }
  // How well one term matches a row's haystack: substring > word-prefix > typo.
  function tokenHits(term, text) {
    if (text.indexOf(term) >= 0) return 1;
    var words = text.split(/\s+/);
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (!w) continue;
      if (w.indexOf(term) >= 0) return 0.85;
      if (term.length >= 4 && w.length >= 4 && editDist(w, term) <= 2) return 0.7;
    }
    return 0;
  }
  // "25", "$25k", "25,000", "1.5m" -> a number, so a query like "start with
  // 25k" can match rows by CapEx / payback, not just by text.
  function numToken(term) {
    var m = /^\$?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)([km]?)$/i.exec(term);
    if (!m) return null;
    var v = parseFloat(m[1].replace(/,/g, ""));
    if (m[2] === "k") v *= 1000;
    else if (m[2] === "m") v *= 1000000;
    return v;
  }
  // Fuzzy AND score: every term must land somewhere (numeric ranges included),
  // and the score carries match quality so search results can be ranked.
  function searchScore(r, terms, numTerms) {
    var h = hay(r), sc = 0, ok = true;
    for (var i = 0; i < terms.length; i++) {
      var t = terms[i];
      if (numTerms[t] !== undefined) {
        var v = numTerms[t];
        // >60 reads as dollars (CapEx ceiling); <=60 as months (payback).
        var hitNum = v > 60
          ? (r.cx != null && r.cx <= v)
          : (r.pb != null && r.pb <= v);
        if (hitNum || h.indexOf(t) >= 0) sc += 1;
        else ok = false;
      } else {
        var hit = tokenHits(t, h);
        if (!hit) { ok = false; }
        else {
          var nl = (r.n || "").toLowerCase();
          sc += hit * (nl.indexOf(t) >= 0 ? 1.5 : 1);
        }
      }
    }
    return ok ? sc : 0;
  }

  // The single access model. Every CTA and badge on the page derives from it.
  function access(r) {
    if (subMode()) return "sub";
    var st = authState();
    if (!st || !st.signedIn) return "none";
    if (st.plan === "all") return "all";
    if (st.products && st.products.indexOf(r.s) >= 0) return "own";
    return "in";
  }
  function isOpen(r) {
    var a = access(r);
    return a === "sub" || a === "all" || a === "own";
  }
  // Priority window: a row with a future public release date ("rel") is open
  // to subscribers/owners now and to everyone else only after rel passes.
  // Public visitors see the concept, the verdict and the release date — but
  // no buy button. The pursuit window opens before the crowd.
  function inWindow(r) {
    if (!r.rel) return false;
    var today = new Date().toISOString().slice(0, 10);
    return r.rel > today;
  }
  function relBadge(r) {
    if (!inWindow(r)) return "";
    return '<span class="tag">priority &mdash; public ' + esc(r.rel) + "</span>";
  }
  // Concept names honour access: for an open row the name IS the door to the
  // dossier (the member-area rule: the row opens in place, no detour). The
  // dossier vault pages are local-only by SECURITY doctrine (06bfa70f: static
  // hosting cannot gate; option D delivers report bytes server-side), so the
  // door is the public concept page, where the server-gated report opens in
  // place for the entitled visitor. Everyone else gets the same public
  // presentation page — the buy CTA for products, the audit for rejections.
  function conceptHref(r) {
    return "/c/" + encodeURIComponent(r.s) + "/";
  }
  function isSaleable(r) { return !!(r.v || r.p === 1); }

  // IP / protectability. r.df is set by the deterministic sub-gate J audit:
  //   "declared"   = a specific protectable contribution was named (IP confirmed)
  //   "arbitrage"  = operational arbitrage, no patentable asset
  //   "none"/"partial" = prior-art/novelty boundary not (fully) drawn
  //   undefined    = report predates the Defensibility requirement (not assessed)
  function ipBadge(r) {
    if (r.df === "declared") return '<span class="tbadge ok">IP confirmed</span>';
    if (r.df === "arbitrage" || r.df === "none" || r.df === "partial")
      return '<span class="tbadge">no claim</span>';
    return "—";
  }

  // ------------------------------------------------------- attribution strip
  // The member ledger (/dossier/) is the SAME page as the public ledger — same
  // head, same toolbar, same table. The only addition is this strip between
  // the head and the toolbar: the visitor's role, in place. Identity and
  // sign-out live in the masthead chip; the strip carries only the role badge
  // and its status note, so nothing is said twice.
  function renderAttrib() {
    var el = $("aa-ledger-attrib");
    if (!el || !MINE) return;
    var st = authState();
    var signedIn = st && st.signedIn;
    var sub = subMode();
    var planAll = signedIn && st.plan === "all";
    var ownedN = (signedIn && st.products) ? st.products.length : 0;
    var h;
    if (sub) {
      h = '<div class="aa-user-line"><span class="aa-badge owned">Subscriber</span>' +
        '<span class="aa-attrib-note">Unlocked — every dossier is open to you. No paywalls; prices shown are informational.</span></div>';
    } else if (signedIn) {
      h = '<div class="aa-user-line">' +
        (planAll
          ? '<span class="aa-badge">Full Ledger Access</span>' +
            '<span class="aa-attrib-note">Every dossier, past and future. New survivors appear the moment the pipeline clears them.</span>'
          : '<span class="aa-badge owned">' + ownedN + " of " + (META ? META.total : "") + " dossiers open</span>" +
            '<span class="aa-attrib-note">The dossiers you own are open in the table below; the rest are one click away.</span>') +
        "</div>";
    } else {
      h = '<div class="aa-signin-card"><span>Already bought a dossier? Sign in and it unlocks right here, in this table.</span>' +
        '<button class="aa-btn" id="aa-attrib-signin" type="button">Sign in</button></div>';
    }
    el.innerHTML = h;
    var si = el.querySelector("#aa-attrib-signin");
    if (si && window.AA && window.AA.openSignIn) si.addEventListener("click", window.AA.openSignIn);
  }

  // ------------------------------------------------------------------ apply
  function apply() {
    var terms = tokens(q.value);
    var dv = disc.value, fv = fail.value;
    var pb = pay.value ? parseFloat(pay.value) : null;

    view = all.filter(function (r) {
      if (favOnly && favMode !== "none" && !favs[r.s]) return false;
      if (verdict !== "all") {
        if (verdict === "sale") { if (!isSaleable(r)) return false; }
        else if (String(r.v) !== verdict) return false;
      }
      if (dv && r.d !== dv) return false;
      if (fv) {
        var has = (r.f || []).indexOf(fv) >= 0 ||
                  (r.o || "").split(",").map(function (x) { return x.trim(); }).indexOf(fv) >= 0;
        if (!has) return false;
      }
      if (pb !== null && !(r.pb !== null && r.pb !== undefined && r.pb <= pb)) return false;
      // Startup-capital band: a one-click ceiling ("max" inverts to a floor).
      // ANDs with the precise CapEx input above, so band + exact cap combine.
      if (capexBand) {
        if (capexBand === "max") {
          if (!(r.cx !== null && r.cx !== undefined && r.cx > 500000)) return false;
        } else if (!(r.cx !== null && r.cx !== undefined && r.cx <= parseInt(capexBand, 10) * 1000)) {
          return false;
        }
      }
      // Bankability band (owner 2026-09-07): the model pack's verdict.
      // Values arrive as "BANKABLE (model)" etc. — normalize the suffix off.
      // "NO VERDICT" folds the two verdict-less states: pre-model reports
      // (no pack) and packs whose primitives can't support a verdict.
      if (bankBand) {
        var bv = r.bk != null ? String(r.bk).split(" (")[0] : null;
        if (bankBand === "NO VERDICT") {
          if (!(bv == null || bv === "NOT ASSESSABLE")) return false;
        } else if (bv !== bankBand) return false;
      }
      return true;
    });

    // Search terms: fuzzy AND over the haystack, with numeric tokens matching
    // CapEx/payback ranges. Rows can also be admitted by the semantic layer
    // (SEM, cosine scores from the ask function) even when no token lands —
    // that is what makes natural-language questions work.
    if (terms.length) {
      var numTerms = {};
      terms.forEach(function (t) { var v = numToken(t); if (v !== null) numTerms[t] = v; });
      view = view.map(function (r) {
        r._fs = searchScore(r, terms, numTerms);
        return r;
      }).filter(function (r) {
        return r._fs > 0 || (SEM[r.s] != null && SEM[r.s] >= SEM_MIN);
      });
    }

    var s = sort.value;
    function chosenCmp(a, b) {
      // A rejected concept's delta is a DISCREDITED claim, so it must never
      // outrank a verified one. Sorting by advantage ranks cleared first.
      if (s === "delta") {
        var ax = a.v ? (a.x || 0) : -1, bx = b.v ? (b.x || 0) : -1;
        return bx - ax;
      }
      if (s === "capex") return (a.cx == null ? Infinity : a.cx) - (b.cx == null ? Infinity : b.cx);
      if (s === "pay") return (a.pb == null ? Infinity : a.pb) - (b.pb == null ? Infinity : b.pb);
      if (s === "az") return a.n.localeCompare(b.n);
      return (b.t || "").localeCompare(a.t || "") || a.n.localeCompare(b.n);
    }
    // With a search active, relevance outranks the chosen sort: 45% fuzzy
    // quality + 55% semantic cosine (SEM absent for rows the function did
    // not rank). The chosen sort breaks ties. Without a search, the chosen
    // sort alone governs, exactly as before.
    if (terms.length) {
      var maxFs = 1;
      view.forEach(function (r) { if (r._fs > maxFs) maxFs = r._fs; });
      view.sort(function (a, b) {
        var ca = ((a._fs || 0) / maxFs) * 0.45 + (SEM[a.s] || 0) * 0.55;
        var cb = ((b._fs || 0) / maxFs) * 0.45 + (SEM[b.s] || 0) * 0.55;
        if (ca !== cb) return cb - ca;
        return chosenCmp(a, b);
      });
    } else {
      view.sort(chosenCmp);
    }

    if (viewmode === "grid") {
      shown = view.length;
      results.innerHTML = view.length ? renderGrid(view) : "";
      more.hidden = true;
      empty.hidden = view.length > 0;
      countline();
      syncHash();
      return;
    }

    shown = 0;
    results.innerHTML = "";
    render();
    syncHash();
  }

  function countline() {
    count.textContent = view.length === all.length
      ? all.length + " concepts assessed"
      : "Showing " + view.length + " of " + all.length + " concepts";
    bankline();
    favLabel();
    var es = empty ? empty.querySelector("strong") : null;
    if (es) {
      es.textContent = (favOnly && favMode !== "none" && !favList().length)
        ? "No favorites yet — tap the ☆ on any concept and it stays here."
        : "Nothing matches those filters.";
    }
  }

  // The insight line under the count: a measured statement for the active
  // verdict × bankability combination (computed at publish from the census,
  // never hardcoded prose). "Rejected × Bankable" is the thesis the filter
  // exists to expose: the debt math works, the venture case didn't.
  function bankline() {
    var el = $("bankline");
    if (!el) return;
    var key = verdict + "|" + bankBand;
    var ins = (DATA.bank_insights || {})[key];
    el.hidden = !ins;
    el.textContent = ins || "";
  }

  // ------------------------------------------------------------ CTA cells
  // Every row carries its EUR price for every visitor class (owner
  // 2026-09-07: concepts must be priced in the ledger). Entitled rows keep
  // the frictionless Open CTA; the price chip is informational. Stripe
  // charges EUR, so the engine mirrors the charge currency — singles.price
  // ("€999") is the authoritative string, never a reconstructed "$" price.
  function apBadges(r) {
    var ap = (r.ap != null) ? ("€" + Number(r.ap).toLocaleString()) : "";
    return '<span class="tbadge dead">autopsy</span>'
      + (ap ? '<span class="tbadge" aria-label="Full report priced by Autopsy Value Score">' + esc(ap) + "</span>" : "");
  }
  function rowPrice(r) {
    var s = SINGLES[r.s];
    if (s && s.price) return s.price;
    if (r.price != null) return "€" + Number(r.price).toLocaleString();
    return "€299";
  }
  function cta(r) {
    var a = access(r);
    if (a === "sub" || a === "all" || a === "own") {
      if (!isSaleable(r)) return '<div class="rcta">' + apBadges(r) + "</div>";
      return '<div class="rcta"><a class="row-btn row-btn--open" href="' + D +
        encodeURIComponent(r.s) + '/" aria-label="Open the full dossier for ' + esc(r.n) + '">' +
        'Open<span aria-hidden="true"> &rarr;</span></a>' +
        '<span class="tbadge" aria-label="Priced at ' + esc(rowPrice(r)) + '">' + esc(rowPrice(r)) + "</span></div>";
    }
    if (!isSaleable(r)) {
      return '<div class="rcta">' + apBadges(r) + "</div>";
    }
    // Priority window: no anonymous checkout until the public release date.
    if (inWindow(r)) {
      return '<div class="rcta"><span class="row-btn row-btn--wait" aria-label="' +
        esc(r.n) + ' opens publicly on ' + esc(r.rel) + '">Priority &mdash; public ' +
        esc(r.rel) + "</span></div>";
    }
    if (r.s === FREE) {
      return '<div class="rcta"><a class="row-btn row-btn--free" href="/sample/" ' +
        'aria-label="Open the free full entry for ' + esc(r.n) + '">' +
        'Free<span aria-hidden="true"> &rarr;</span></a></div>';
    }
    var s = SINGLES[r.s];
    if (s && s.checkout_url) {
      var price = rowPrice(r);
      return '<div class="rcta"><a class="row-btn row-btn--buy" href="' + esc(s.checkout_url) +
        '" rel="noopener" aria-label="Buy the full dossier for ' + esc(r.n) + " for " + esc(price) + '">' +
        'Full dossier <span class="row-btn__price">' + esc(price) + "</span></a></div>";
    }
    var fa = FULL_ACCESS || {};
    var url = fa.url || "/ledger/";
    var label = fa.label || "Full access";
    return '<div class="rcta"><a class="row-btn row-btn--buy" href="' + esc(url) + '" rel="noopener" ' +
      'aria-label="Subscribe for full access to ' + esc(r.n) + '">' + esc(label) + "</a></div>";
  }

  // The merged Edge cell: advantage vs incumbent (saleable rows only — a
  // failure never claims an edge) + the absence-verified marker. One column
  // instead of two, so the numeric columns can keep room to breathe.
  function edgeCell(r) {
    var adv = isSaleable(r) && r.x ? '<span class="edgeval">' + fmtx(r.x) + "</span>" : "";
    var abs = r.abs === 1 ? '<span class="tbadge ok" title="Absence search verified">verified</span>' : "";
    return adv + (adv && abs ? " " : "") + abs + (adv || abs ? "" : "—");
  }

  function gridCta(r) {
    var a = access(r);
    if (a === "sub" || a === "all" || a === "own") {
      if (!isSaleable(r)) return apBadges(r) + '<a class="tdossier" href="/c/' + encodeURIComponent(r.s) + '/">Read the audit &rarr;</a>';
      return '<a class="tdossier" href="' + D + encodeURIComponent(r.s) + '/">Open &rarr;</a> <span class="tbadge">' + esc(rowPrice(r)) + "</span>";
    }
    if (r.s === FREE) return '<a href="/sample/">Free</a>';
    if (!isSaleable(r)) {
      return apBadges(r);
    }
    if (inWindow(r)) {
      return '<span class="tbadge">priority &mdash; public ' + esc(r.rel) + "</span>";
    }
    var s = SINGLES[r.s];
    if (s && s.checkout_url) {
      return '<a class="tdossier" href="' + esc(s.checkout_url) + '" rel="noopener">Buy ' + esc(rowPrice(r)) + "</a>";
    }
    var fa = FULL_ACCESS || {};
    return '<a class="tdossier" href="' + esc(fa.url || "/ledger/") + '" rel="noopener">' +
      esc(fa.label || "Full access") + "</a>";
  }

  function bankBadge(r) {
    if (!r.bk) return "";
    var bv = String(r.bk).split(" (")[0];
    var cls = bv === "BANKABLE" ? "ok" : (bv === "NOT BANKABLE" ? "dead" : "");
    var ds = r.bkd != null ? String(r.bkd) : null;
    if (ds != null && ds.indexOf(".") >= 0) {
      var f = Number(ds).toFixed(2);
      f = f.indexOf(".") >= 0 ? f.replace(/0+$/, "").replace(/\.$/, "") : f;
      ds = f;
    }
    var capped = ds != null && Number(ds) >= 5;
    var t = "Model bankability: " + bv +
      (ds != null ? " \u2014 min DSCR " + ds + "\u00d7" : "") +
      (capped ? " (the loan is capped by use-of-proceeds \u2014 the business barely needs debt; see the pack for debt capacity)" : "") +
      ". Computed by the institutional pack, not a bank decision.";
    return '<span class="tbadge ' + cls + '" title="' + t + '">' +
      esc(bv) + (ds != null ? " " + ds + "\u00d7" : "") + "</span>";
  }

  // The cross as ONE chip (owner 2026-09-07): a rejected row never shows the
  // rejection alone — the audit verdict and the capital verdict share a single
  // status token ("rejected · BANKABLE 22.49×") so the honest cross reads at a
  // glance. Cleared rows keep their separate chips (positive-first already).
  function verdictChip(r) {
    var bv = String(r.bk).split(" (")[0];
    var ds = r.bkd != null ? String(r.bkd) : null;
    if (ds != null && ds.indexOf(".") >= 0) {
      var f = Number(ds).toFixed(2);
      f = f.indexOf(".") >= 0 ? f.replace(/0+$/, "").replace(/\.$/, "") : f;
      ds = f;
    }
    var capped = ds != null && Number(ds) >= 5;
    var t = "Audit verdict: didn&rsquo;t clear. Model bankability: " + bv +
      (ds != null ? " \u2014 min DSCR " + ds + "\u00d7" : "") +
      (capped ? " (the loan is capped by use-of-proceeds \u2014 the business barely needs debt; see the pack for debt capacity)" : "") +
      ". Computed by the institutional pack, not a bank decision.";
    var bankCls = bv === "BANKABLE" ? "bx-bank-ok" :
      (bv === "NOT BANKABLE" ? "bx-bank-dead" : "bx-bank-mid");
    return '<span class="tbadge bx" title="' + t + '"><span class="bx-rej">didn&rsquo;t clear</span>' +
      '<span class="bx-sep"> \u00b7 </span><span class="' + bankCls + '">' +
      esc(bv) + (ds != null ? " " + ds + "\u00d7" : "") + "</span></span>";
  }

  function ownedBadge(r) {
    if (!isSaleable(r)) return "";
    var a = access(r);
    if (a === "own") return '<span class="tbadge owned">owned</span>';
    if (a === "all" || a === "sub") return '<span class="tbadge owned">open</span>';
    return "";
  }

  // -------------------------------------------------------------- rendering
  function renderGrid(list) {
    var h = '<div class="gridwrap"><table class="term"><thead><tr>' +
      "<th>Concept</th><th>Status</th><th>Incumbent</th>" +
      '<th title="Advantage vs incumbent · absence search verified">Edge</th>' +
      "<th>IP</th><th>CapEx</th><th>Margin</th><th>Payback</th>" +
      "<th>Regulatory</th><th>Dossier</th></tr></thead><tbody>";
    list.forEach(function (r) {
      var badges = [];
      badges.push(ownedBadge(r));
      if (r.v) badges.push('<span class="tbadge ok">cleared</span>');
      else {
        if (r.p === 1) badges.push('<span class="tbadge">product</span>');
        badges.push(r.bk ? verdictChip(r) : '<span class="tbadge dead">didn&rsquo;t clear</span>');
      }
      badges.push(relBadge(r));
      if (r.v) badges.push(bankBadge(r));
      h += "<tr" + (isOpen(r) && isSaleable(r) ? ' class="row-open"' : "") + ">" +
        "<td>" + favBtn(r) + '<a class="tname" href="' + conceptHref(r) + '">' + esc(r.n) + "</a>" +
        '<span class="tdate">' + esc(r.t) + (r.d ? " · " + esc(r.d) : "") + "</span></td>" +
        "<td>" + badges.join(" ") + "</td>" +
        "<td>" + (r.i ? esc(r.i) : "—") + "</td>" +
        "<td>" + edgeCell(r) + "</td>" +
        "<td>" + ipBadge(r) + "</td>" +
        '<td class="num tdcx">' + (r.cx != null ? "$" + Number(r.cx).toLocaleString() : "—") + "</td>" +
        '<td class="num tdgm">' + (r.gm != null ? r.gm + "%" : "—") + "</td>" +
        '<td class="num tdpb">' + (r.pb != null ? r.pb + " mo" : "—") + "</td>" +
        "<td>" + (r.reg ? esc(r.reg) : "—") + "</td>" +
        "<td>" + (r.a ? '<a class="taudio" href="' + esc(r.a) + '" aria-label="Listen to the audio overview of ' + esc(r.n) + '">&#9835; audio</a> ' : "") + gridCta(r) + "</td>" +
        "</tr>";
    });
    return h + "</tbody></table></div>";
  }

  function render() {
    var slice = view.slice(shown, shown + BATCH);
    var frag = document.createDocumentFragment();
    slice.forEach(function (r) {
      var row = document.createElement("article");
      row.className = "row";
      if (isOpen(r) && isSaleable(r)) row.className += " row-open";
      var tags = [];
      if (r.v) {
        tags.push('<span class="tag">cleared</span>');
      } else {
        if (r.p === 1) tags.push('<span class="tag">product</span>');
        if (r.bk) tags.push(verdictChip(r));
        (r.o || "").split(",").forEach(function (p) {
          p = p.trim();
          if (p && p.toLowerCase() !== "none" && VOID_LABEL[p])
            tags.push('<span class="tag fail">' + esc(VOID_LABEL[p]) + "</span>");
        });
        (r.f || []).forEach(function (f) {
          tags.push('<span class="tag fail">' + esc(FAIL_LABEL[f] || f) + "</span>");
        });
      }
      if (r.abs === 1) tags.push('<span class="tag ok">absence verified</span>');
      if (r.df === "declared") tags.push('<span class="tag ok">IP confirmed</span>');
      if (r.v && r.bk) tags.push(bankBadge(r));
      if (inWindow(r)) tags.push(relBadge(r));
      if (r.reg === "high") tags.push('<span class="tag fail">high regulatory</span>');
      else if (r.reg === "med") tags.push('<span class="tag">regulatory</span>');
      row.innerHTML =
        "<div>" + favBtn(r) +
        '<h2><a href="' + conceptHref(r) + '">' + esc(r.n) + "</a></h2>" +
        '<p class="rmeta">' + esc(r.t) + (r.d ? " · " + esc(r.d) : "") +
          (r.i ? " · vs " + esc(r.i) : "") + "</p>" +
        (r.m ? '<p class="rmetric">' + esc(r.m) + "</p>" : "") +
        '<div class="tagline">' + tags.join("") + "</div></div>" +
        '<div class="rright">' +
          (isSaleable(r) && r.x ? '<div class="rdelta">' + fmtx(r.x) + "</div>" : "") +
          (r.cx ? "<div>$" + Number(r.cx).toLocaleString() + " capex</div>" : "") +
          (r.pb ? "<div>" + r.pb + " mo payback</div>" : "") +
          (r.gm ? "<div>" + r.gm + "% margin</div>" : "") +
          (r.a ? '<span class="raudio-label">&#9835; NotebookLM audio overview</span>' +
                 '<audio controls preload="none" src="' + esc(r.a) + '"></audio>' : "") +
          cta(r) +
        "</div>";
      frag.appendChild(row);
    });
    results.appendChild(frag);
    shown += slice.length;
    more.hidden = shown >= view.length;
    more.textContent = "Show more (" + Math.max(0, view.length - shown) + " remaining)";
    empty.hidden = view.length > 0;
    countline();
  }

  // ------------------------------------------------------------------- hash
  function syncHash() {
    var p = new URLSearchParams();
    if (q.value) p.set("q", q.value);
    if (verdict !== "all") p.set("v", verdict);
    if (disc.value) p.set("d", disc.value);
    if (fail.value) p.set("f", fail.value);
    if (capexBand) p.set("cb", capexBand);
    if (bankBand) p.set("bk", bankBand);
    if (pay.value) p.set("pb", pay.value);
    if (favOnly) p.set("fav", "1");
    if (sort.value !== "new") p.set("s", sort.value);
    if (viewmode !== "grid") p.set("w", viewmode);
    var s = p.toString();
    history.replaceState(null, "", s ? "?" + s : location.pathname);
  }

  function readHash() {
    var p = new URLSearchParams(location.search);
    if (p.get("q")) q.value = p.get("q");
    var v = p.get("v");
    if (v === "sale" || v === "0" || v === "all") verdict = v;
    if (p.get("d")) disc.value = p.get("d");
    if (p.get("f")) fail.value = p.get("f");
    var cb = p.get("cb");
    if (cb === "25" || cb === "100" || cb === "500" || cb === "max") capexBand = cb;
    var bk = p.get("bk");
    if (bk === "NOT ASSESSABLE" || bk === "NONE") bk = "NO VERDICT";
    if (bk === "BANKABLE" || bk === "NOT BANKABLE" || bk === "CONDITIONAL" ||
        bk === "NO VERDICT") bankBand = bk;
    if (p.get("pb")) pay.value = p.get("pb");
    if (p.get("fav") === "1") favOnly = true;
    if (p.get("s")) sort.value = p.get("s");
    if (p.get("w") === "list" || p.get("w") === "grid") viewmode = p.get("w");
    pressSegs();
  }

  function pressSegs() {
    document.querySelectorAll("#verdictseg button").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.v === verdict));
    });
    document.querySelectorAll("#viewseg button").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.view === viewmode));
    });
    document.querySelectorAll("#capexseg button").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.cx === capexBand));
    });
    document.querySelectorAll("#bankseg button").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.bk === bankBand));
    });
    document.querySelectorAll("#favseg button").forEach(function (b) {
      b.setAttribute("aria-pressed", String(favOnly));
    });
  }

  // ----------------------------------------------------------------- events
  q.addEventListener("input", function () {
    clearTimeout(timer);
    timer = setTimeout(apply, 140);
    if (AAS) {
      clearTimeout(semTimer);
      semTimer = setTimeout(semanticRank, 300);
    }
  });
  [disc, fail, pay, sort].forEach(function (el) {
    el.addEventListener("change", apply);
  });
  document.querySelectorAll("#verdictseg button").forEach(function (b) {
    b.addEventListener("click", function () {
      verdict = b.dataset.v;
      pressSegs();
      apply();
    });
  });
  document.querySelectorAll("#viewseg button").forEach(function (b) {
    b.addEventListener("click", function () {
      viewmode = b.dataset.view;
      pressSegs();
      apply();
    });
  });
  document.querySelectorAll("#capexseg button").forEach(function (b) {
    b.addEventListener("click", function () {
      capexBand = b.dataset.cx;
      pressSegs();
      apply();
    });
  });
  document.querySelectorAll("#bankseg button").forEach(function (b) {
    b.addEventListener("click", function () {
      bankBand = b.dataset.bk;
      pressSegs();
      apply();
    });
  });
  document.querySelectorAll("#favseg button").forEach(function (b) {
    b.addEventListener("click", function () {
      favOnly = !favOnly;
      pressSegs();
      apply();
    });
  });
  // Star toggles re-render with every apply(), so clicks are delegated to the
  // results container — the buttons themselves are never long-lived.
  results.addEventListener("click", function (e) {
    var t = e.target;
    var b = t && t.closest ? t.closest(".favbtn") : null;
    if (!b) return;
    toggleFav(b.getAttribute("data-slug"));
  });
  more.addEventListener("click", render);
  function reset() {
    q.value = ""; disc.value = ""; fail.value = ""; pay.value = "";
    sort.value = "new"; verdict = "all"; capexBand = ""; bankBand = ""; favOnly = false;
    SEM = {}; semToken++;
    var area = $("answerarea"); if (area) area.hidden = true;
    pressSegs();
    apply();
  }
  var rb = $("reset"); if (rb) rb.addEventListener("click", reset);
  var rb2 = $("reset2"); if (rb2) rb2.addEventListener("click", reset);

  // ------------------------------------------------------- semantic search
  // The search config is injected by the page (AA_LEDGER_CFG.search); an
  // explicit window.AA_SEARCH overrides it (QA/debug). The ask function ranks
  // queries by cosine similarity over precomputed concept embeddings and
  // answers questions citing corpus concepts only. Everything below degrades
  // silently: without the function, fuzzy local search still works.
  var AAS = (window.AA_SEARCH && window.AA_SEARCH.enabled !== false && window.AA_SEARCH.fn)
    ? window.AA_SEARCH
    : ((DATA.search && DATA.search.enabled !== false && DATA.search.fn) ? DATA.search : null);
  var SEM = {};                     // slug -> cosine score
  var SEM_MIN = 0.30;
  var semTimer = null, semToken = 0, askToken = 0;

  function semanticRank() {
    if (!AAS) return;
    var tq = q.value.trim();
    if (!tq || tq.length < 3) { SEM = {}; return; }
    var tok = ++semToken;
    var sig = null;
    try { sig = AbortSignal.timeout(7000); } catch (e) {}
    fetch(AAS.fn + "?mode=rank&q=" + encodeURIComponent(tq), { method: "GET", signal: sig })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.ok || tok !== semToken) return;
        SEM = {};
        (j.results || []).forEach(function (x) { SEM[x.s] = x.score; });
        apply();
      })
      .catch(function () { /* semantic layer unavailable — fuzzy search stands */ });
  }

  function renderAnswer(j) {
    var area = $("answerarea"), st = $("answerstate"), body = $("answerbody"), srcs = $("answersrcs");
    if (!area) return;
    area.hidden = false;
    st.hidden = true;
    body.innerHTML = esc(j.answer).replace(/\n/g, "<br>");
    var links = (j.sources || []).map(function (x) {
      var meta = x.v ? "cleared" : "didn&rsquo;t clear";
      if (x.cx != null) meta += " &middot; capEx $" + Number(x.cx).toLocaleString();
      return '<a class="answer-src" href="' + esc(x.url) + '"><span class="answer-src-name">' +
        esc(x.n) + '</span><span class="answer-src-meta">' + meta + "</span></a>";
    });
    srcs.innerHTML = links.join("");
    if (!links.length) {
      body.innerHTML += '<p class="answer-nosrc" style="margin-top:.6rem">No cited sources &mdash; treat this answer as noise.</p>';
    }
  }

  function askLedger() {
    if (!AAS) return;
    var ai = $("askinput"), area = $("answerarea"), st = $("answerstate");
    var tq = ((ai && ai.value) || q.value).trim();
    if (!tq) return;
    if (area) area.hidden = false;
    if (st) { st.hidden = false; st.textContent = "Asking the ledger\u2026"; }
    var tok = ++askToken;
    var sig = null;
    try { sig = AbortSignal.timeout(25000); } catch (e) {}
    fetch(AAS.fn, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "answer", q: tq }),
      signal: sig
    }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (tok !== askToken) return;
        if (!j || !j.ok) {
          if (st) { st.hidden = false; st.textContent = "The answer engine is unavailable \u2014 search still works."; }
          return;
        }
        renderAnswer(j);
      })
      .catch(function () {
        if (tok === askToken && st) {
          st.hidden = false;
          st.textContent = "The answer engine is unavailable \u2014 search still works.";
        }
      });
  }

  var askbtn = $("askbtn"), askinput = $("askinput");
  if (AAS && askbtn && askinput) {
    askbtn.addEventListener("click", askLedger);
    askinput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); askLedger(); }
    });
  }

  // --------------------------------------------------------- auth wiring
  // The access model re-reads state on every render, so a re-render after any
  // auth change is all it takes for rows to lock/unlock in place.
  function onAuthChange() {
    renderAttrib();
    favoritesSync();
    pressSegs();
    apply();
  }

  // ------------------------------------------------------------- bootstrap
  fetch("/ledger.json", { cache: "no-cache" })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      all = data.concepts || [];
      var ds = {}, fs = {};
      all.forEach(function (r) {
        if (r.d) ds[r.d] = 1;
        (r.f || []).forEach(function (f) { fs[f] = 1; });
        (r.o || "").split(",").forEach(function (p) {
          p = p.trim();
          if (p && p.toLowerCase() !== "none") fs[p] = 1;
        });
      });
      Object.keys(ds).sort().forEach(function (d) {
        var o = document.createElement("option"); o.value = d; o.textContent = d; disc.appendChild(o);
      });
      Object.keys(fs).sort().forEach(function (f) {
        var o = document.createElement("option");
        o.value = f;
        o.textContent = VOID_LABEL[f] || FAIL_LABEL[f] || f;
        fail.appendChild(o);
      });
      readHash();
      renderAttrib();
      favoritesSync();
      pressSegs();
      apply();

      // failure taxonomy — why concepts die, computed from the data
      var tc = {};
      all.forEach(function (r) {
        if (r.v) return;
        (r.f || []).forEach(function (f) { tc[f] = (tc[f] || 0) + 1; });
        (r.o || "").split(",").forEach(function (p) {
          p = p.trim();
          if (p && p.toLowerCase() !== "none") { var k = "v:" + p; tc[k] = (tc[k] || 0) + 1; }
        });
      });
      var tparts = Object.keys(tc).sort(function (a, b) { return tc[b] - tc[a]; }).map(function (k) {
        var lab = k.indexOf("v:") === 0 ? (VOID_LABEL[k.slice(2)] || k.slice(2))
                                        : (FAIL_LABEL[k] || k);
        return "<strong>" + tc[k] + "</strong> " + esc(lab);
      });
      var tl = $("taxline"), tb = $("taxbox");
      if (tparts.length && tl && tb) {
        tl.innerHTML = tparts.join(" &middot; ");
        tb.hidden = false;
      }
    })
    .catch(function () {
      count.textContent = "The ledger could not be loaded. Please reload the page.";
    });

  // The auth module loads lazily; subscribe when it is ready and also re-check
  // on a timer for the late-arriving case (engine loaded before auth.js).
  if (window.AA && window.AA.onReady) {
    window.AA.onReady(onAuthChange);
  } else {
    var ticks = 0;
    var iv = setInterval(function () {
      if (window.AA && window.AA.onReady) {
        clearInterval(iv);
        window.AA.onReady(onAuthChange);
      } else if (++ticks > 40) {
        clearInterval(iv);
      }
    }, 250);
  }

  // QA/debug affordance: force a re-render with the current auth state, or
  // repoint the ask function (e.g. at the local devserver).
  window.AALedger = {
    refresh: onAuthChange,
    setSearchFn: function (url) { AAS = url ? { enabled: true, fn: url } : null; },
    toggleFav: toggleFav // QA/debug affordance for the favorites layer
  };
})();
