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
 *   "sub"  aa_sub=1 cookie (invited subscriber)      -> open, no prices
 *   "all"  signed in, plan=all (Full Ledger Access)  -> open, no prices
 *   "own"  signed in, owns this dossier              -> open
 *   "in"   signed in, does not own this dossier      -> buy CTA
 *   "none" anonymous                                 -> buy / free / autopsy
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
  var D = "/do" + "ssier/"; // dossier path assembled at runtime; never a literal
  var FREE = "liquid-metal-nanoparticle-conductive-ink-via-ultrasonic-probe-cavitati";

  var all = [], view = [], shown = 0;
  var verdict = "all", viewmode = "grid";
  var timer = null;

  var $ = function (id) { return document.getElementById(id); };
  var results = $("results"), count = $("count"), more = $("more"), empty = $("empty");
  var q = $("q"), disc = $("disc"), fail = $("fail"), capex = $("capex"), pay = $("pay"), sort = $("sort");
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
  function hay(r) {
    if (!r._h) r._h = [r.n, r.d, r.i, r.m].join(" ").toLowerCase();
    return r._h;
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
  function isSaleable(r) { return !!(r.v || r.p === 1); }

  // ------------------------------------------------------- attribution strip
  // The member ledger (/dossier/) is the SAME page as the public ledger — same
  // head, same toolbar, same table. The only addition is this strip between
  // the head and the toolbar: the visitor's role, in place. Anonymous visitors
  // see a sign-in card; owners see their account line; subscribers see the
  // "unlocked" note. Rendered only in mine mode.
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
        '<span class="aa-attrib-note">Unlocked — every dossier is open to you. No prices, no paywalls.</span></div>';
    } else if (signedIn) {
      h = '<div class="aa-user-line"><span class="aa-who">' + esc(st.email) + "</span>" +
        (planAll
          ? '<span class="aa-badge">Full Ledger Access</span>'
          : '<span class="aa-badge owned">' + ownedN + " of " + (META ? META.total : "") + " dossiers open</span>") +
        '<button class="aa-out" id="aa-attrib-out" type="button">Sign out</button></div>';
    } else {
      h = '<div class="aa-signin-card"><span>Already bought a dossier? Sign in and it unlocks right here, in this table.</span>' +
        '<button class="aa-btn" id="aa-attrib-signin" type="button">Sign in</button></div>';
    }
    el.innerHTML = h;
    var out = el.querySelector("#aa-attrib-out");
    if (out) out.addEventListener("click", function () {
      if (window.AA && window.AA.signOut) window.AA.signOut();
    });
    var si = el.querySelector("#aa-attrib-signin");
    if (si && window.AA && window.AA.openSignIn) si.addEventListener("click", window.AA.openSignIn);
  }

  // ------------------------------------------------------------------ apply
  function apply() {
    var terms = tokens(q.value);
    var dv = disc.value, fv = fail.value;
    var cx = capex.value ? parseFloat(capex.value) : null;
    var pb = pay.value ? parseFloat(pay.value) : null;

    view = all.filter(function (r) {
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
      if (cx !== null && !(r.cx !== null && r.cx !== undefined && r.cx <= cx)) return false;
      if (pb !== null && !(r.pb !== null && r.pb !== undefined && r.pb <= pb)) return false;
      if (terms.length) {
        var h = hay(r);
        for (var i = 0; i < terms.length; i++) if (h.indexOf(terms[i]) < 0) return false;
      }
      return true;
    });

    var s = sort.value;
    view.sort(function (a, b) {
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
    });

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
  }

  // ------------------------------------------------------------ CTA cells
  function cta(r) {
    var a = access(r);
    // Owner/subscriber: the row IS the door. No prices, no friction.
    if (a === "sub" || a === "all" || a === "own") {
      if (!isSaleable(r)) return ""; // rejections open via the audit link in the title
      return '<div class="rcta"><a class="row-btn row-btn--open" href="' + D +
        encodeURIComponent(r.s) + '/" aria-label="Open the full dossier for ' + esc(r.n) + '">' +
        'Open<span aria-hidden="true"> &rarr;</span></a></div>';
    }
    if (!isSaleable(r)) return "";
    if (r.s === FREE) {
      return '<div class="rcta"><a class="row-btn row-btn--free" href="/sample/" ' +
        'aria-label="Open the free full entry for ' + esc(r.n) + '">' +
        'Free<span aria-hidden="true"> &rarr;</span></a></div>';
    }
    var s = SINGLES[r.s];
    if (s && s.checkout_url) {
      var price = (r.price != null) ? ("$" + Number(r.price).toLocaleString()) : (s.price || "$299");
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

  function gridCta(r) {
    var a = access(r);
    if (a === "sub" || a === "all" || a === "own") {
      if (!isSaleable(r)) return '<a class="tdossier" href="/c/' + encodeURIComponent(r.s) + '/">Read the audit &rarr;</a>';
      return '<a class="tdossier" href="' + D + encodeURIComponent(r.s) + '/">Open &rarr;</a>';
    }
    if (r.s === FREE) return '<a href="/sample/">Free</a>';
    if (!isSaleable(r)) return '<span class="tbadge dead">autopsy only</span>';
    var s = SINGLES[r.s];
    if (s && s.checkout_url) {
      var price = (r.price != null) ? ("$" + Number(r.price).toLocaleString()) : (s.price || "$299");
      return '<a class="tdossier" href="' + esc(s.checkout_url) + '" rel="noopener">Buy ' + esc(price) + "</a>";
    }
    var fa = FULL_ACCESS || {};
    return '<a class="tdossier" href="' + esc(fa.url || "/ledger/") + '" rel="noopener">' +
      esc(fa.label || "Full access") + "</a>";
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
      "<th>Concept</th><th>Status</th><th>Incumbent</th><th>Advantage</th>" +
      "<th>Absence</th><th>CapEx</th><th>Margin</th><th>Payback</th>" +
      "<th>Regulatory</th><th>Dossier</th></tr></thead><tbody>";
    list.forEach(function (r) {
      var badges = [];
      badges.push(ownedBadge(r));
      if (r.v) badges.push('<span class="tbadge ok">cleared</span>');
      else {
        if (r.p === 1) badges.push('<span class="tbadge">product</span>');
        badges.push('<span class="tbadge dead">rejected</span>');
      }
      h += "<tr" + (isOpen(r) && isSaleable(r) ? ' class="row-open"' : "") + ">" +
        '<td><a class="tname" href="/c/' + encodeURIComponent(r.s) + '/">' + esc(r.n) + "</a>" +
        '<span class="tdate">' + esc(r.t) + (r.d ? " · " + esc(r.d) : "") + "</span></td>" +
        "<td>" + badges.join(" ") + "</td>" +
        "<td>" + (r.i ? esc(r.i) : "—") + "</td>" +
        '<td class="num">' + (isSaleable(r) && r.x ? fmtx(r.x) : "—") + "</td>" +
        "<td>" + (r.abs === 1 ? '<span class="tbadge ok">verified</span>' : "—") + "</td>" +
        '<td class="num">' + (r.cx != null ? "$" + Number(r.cx).toLocaleString() : "—") + "</td>" +
        '<td class="num">' + (r.gm != null ? r.gm + "%" : "—") + "</td>" +
        '<td class="num">' + (r.pb != null ? r.pb + " mo" : "—") + "</td>" +
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
      if (r.reg === "high") tags.push('<span class="tag fail">high regulatory</span>');
      else if (r.reg === "med") tags.push('<span class="tag">regulatory</span>');
      row.innerHTML =
        '<div><h2><a href="/c/' + encodeURIComponent(r.s) + '/">' + esc(r.n) + "</a></h2>" +
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
    if (capex.value) p.set("cx", capex.value);
    if (pay.value) p.set("pb", pay.value);
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
    if (p.get("cx")) capex.value = p.get("cx");
    if (p.get("pb")) pay.value = p.get("pb");
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
  }

  // ----------------------------------------------------------------- events
  q.addEventListener("input", function () {
    clearTimeout(timer);
    timer = setTimeout(apply, 140);
  });
  [disc, fail, capex, pay, sort].forEach(function (el) {
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
  more.addEventListener("click", render);
  function reset() {
    q.value = ""; disc.value = ""; fail.value = ""; capex.value = ""; pay.value = "";
    sort.value = "new"; verdict = "all";
    pressSegs();
    apply();
  }
  var rb = $("reset"); if (rb) rb.addEventListener("click", reset);
  var rb2 = $("reset2"); if (rb2) rb2.addEventListener("click", reset);

  // --------------------------------------------------------- auth wiring
  // The access model re-reads state on every render, so a re-render after any
  // auth change is all it takes for rows to lock/unlock in place.
  function onAuthChange() {
    renderAttrib();
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

  // QA/debug affordance: force a re-render with the current auth state.
  window.AALedger = { refresh: onAuthChange };
})();
