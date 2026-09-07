/* The Absence Audit — shared auth module (loaded on every page).
 *
 * One module, injected once per page by the publish pipeline:
 *   window.AA_AUTH = { fb: {...}, ledger: bool, dossier: "<slug>" }
 *
 * Responsibilities:
 *  1. Masthead chip — "Sign in" button, or (signed in) name + plan badge +
 *     "My ledger" / "Sign out". Never navigates away: sign-in is a MODAL.
 *  2. Session restore — Firebase v9+ keeps auth state in IndexedDB; we scan
 *     it synchronously-ish so the chip flips to the signed-in state
 *     immediately, then load the SDKs lazily.
 *  3. Entitlements — one Firestore read of access/<email> (allowed by the
 *     security rules for the owner only) -> window.AA.state {email, plan,
 *     products}. The ledger engine (/assets/ledger.js) and the dossier gates
 *     subscribe to this, so signing in unlocks rows in place everywhere.
 */
(function () {
  "use strict";
  var CFG = window.AA_AUTH || null;
  if (!CFG || !CFG.fb || !CFG.fb.apiKey) return;

  var V = "10.12.2";
  var VAULT = "/do" + "ssier/"; // assembled at runtime; never a literal
  var state = { email: "", plan: null, products: [], signedIn: false, ready: false };
  var listeners = [];
  var chip = null;
  var modal = null;
  var agentRevealed = false;

  // -------------------------------------------------- entitlement fast-cache
  // The dossier gate resolves on a Firestore read of access/<email>, which the
  // lazy Firebase SDK can't do until it has loaded — so an entitled account
  // sees a "checking" overlay (or, before, a false "paid ledger" gate) for a
  // second or two on every dossier. Cache the grant after a successful read
  // and replay it on the next load BEFORE the SDK is up, so a returning
  // Full-Ledger/owning account opens their dossier instantly. The SDK still
  // loads and revalidates; a revoked grant re-locks the gate on revalidation.
  var ACC_KEY = "aa_access_cache_v1";
  function readAccessCache() {
    try {
      var s = localStorage.getItem(ACC_KEY);
      if (!s) return null;
      var c = JSON.parse(s);
      return (c && c.email) ? c : null;
    } catch (e) { return null; }
  }
  function writeAccessCache(c) {
    try { localStorage.setItem(ACC_KEY, JSON.stringify(c)); } catch (e) {}
  }
  function clearAccessCache() {
    try { localStorage.removeItem(ACC_KEY); } catch (e) {}
  }

  // ---------------------------------------------------------------- SDK loader
  var SDK = { loading: false, loaded: false, queue: [] };
  function loadScripts(names, cb) {
    if (!names.length) { cb(); return; }
    var s = document.createElement("script");
    s.src = "https://www.gstatic.com/firebasejs/" + V + "/" + names[0];
    s.onload = function () { loadScripts(names.slice(1), cb); };
    s.onerror = function () { SDK.loading = false; };
    document.head.appendChild(s);
  }
  function boot(cb) {
    if (SDK.loaded) { cb(); return; }
    SDK.queue.push(cb);
    if (SDK.loading) return;
    SDK.loading = true;
    loadScripts(["firebase-app-compat.js", "firebase-auth-compat.js",
                 "firebase-firestore-compat.js"], function () {
      if (typeof firebase === "undefined" || SDK.loaded) return;
      firebase.initializeApp(CFG.fb);
      SDK.loaded = true;
      var q = SDK.queue; SDK.queue = [];
      for (var i = 0; i < q.length; i++) q[i]();
    });
  }

  // ------------------------------------------------------- session detection
  function sessionInLocalStorage() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i) || "";
        if (k.indexOf("firebase:authUser:" + CFG.fb.apiKey) !== 0) continue;
        var v = JSON.parse(localStorage.getItem(k) || "{}");
        if (v && v.value && v.value.email) return true;
      }
    } catch (e) {}
    return false;
  }
  function sessionInIndexedDB(cb) {
    try {
      var req = indexedDB.open("firebaseLocalStorageDb");
      req.onsuccess = function () {
        var db = req.result;
        try {
          var all = db.transaction(["firebaseLocalStorage"], "readonly")
                        .objectStore("firebaseLocalStorage").getAllKeys();
          all.onsuccess = function () {
            var found = false;
            (all.result || []).forEach(function (x) {
              if (String(x).indexOf("firebase:authUser:" + CFG.fb.apiKey) === 0) found = true;
            });
            try { db.close(); } catch (e) {}
            cb(found);
          };
          all.onerror = function () { try { db.close(); } catch (e) {} cb(false); };
        } catch (e) { try { db.close(); } catch (e2) {} cb(false); }
      };
      req.onerror = function () { cb(false); };
    } catch (e) { cb(false); }
  }

  // ------------------------------------------------------------------- helpers
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function userEmail(u) {
    return ((u && (u.email || ((u.providerData || [])[0] || {}).email)) || "").toLowerCase();
  }
  function badge(st) {
    if (!st.signedIn) return "";
    if (st.plan === "all") return "Full Ledger";
    if (st.products && st.products.length)
      return st.products.length + (st.products.length > 1 ? " dossiers" : " dossier");
    return "";
  }

  // --------------------------------------------------------------------- state
  function setState(st) {
    state = st;
    renderChip();
    for (var i = 0; i < listeners.length; i++) listeners[i](state);
  }
  function resolve() {
    firebase.auth().onAuthStateChanged(function (u) {
      if (!u) { clearAccessCache(); setState({ email: "", plan: null, products: [], signedIn: false, ready: true }); return; }
      var em = userEmail(u);
      if (!em) { clearAccessCache(); setState({ email: "", plan: null, products: [], signedIn: false, ready: true }); return; }
      firebase.firestore().collection("access").doc(em).get()
        .then(function (snap) {
          var d = snap.exists ? (snap.data() || {}) : {};
          var st = {
            email: em,
            plan: d.plan === "all" ? "all" : null,
            products: (d.products && d.products.length) ? d.products : [],
            signedIn: true,
            ready: true
          };
          writeAccessCache({ email: em, plan: st.plan, products: st.products });
          setState(st);
        })
        .catch(function () {
          setState({ email: em, plan: null, products: [], signedIn: true, ready: true });
        });
    });
  }

  // ---------------------------------------------------------------------- chip
  function renderChip() {
    if (!chip) return;
    if (!state.signedIn) {
      chip.innerHTML = '<button class="aa-btn" id="aa-signin" type="button">Sign in</button>';
      var b = chip.querySelector("#aa-signin");
      if (b) b.addEventListener("click", openModal);
      return;
    }
    var bd = badge(state);
    // Signed-in cluster: identity (plain), access-level badge, the member-area
    // link, and sign out. The member link is the explicit door — user testing
    // showed the email-as-link read as plain text (no underline), so customers
    // could not find their ledger. Identity ("who I am") and action ("my
    // things") are separate affordances now.
    chip.innerHTML =
      '<span class="aa-who">' + esc(state.email) + "</span>" +
      (bd ? '<span class="aa-badge">' + esc(bd) + "</span>" : "") +
      '<a class="aa-myledger" href="' + VAULT + '">My ledger</a>' +
      '<button class="aa-out" type="button">Sign out</button>';
    var o = chip.querySelector(".aa-out");
    if (o) o.addEventListener("click", function () {
      boot(function () { firebase.auth().signOut(); });
    });
  }

  // --------------------------------------------------------------------- modal
  function ensureModal() {
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = "aa-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.innerHTML =
      '<div class="aa-overlay"></div>' +
      '<div class="aa-card" role="document">' +
        '<button class="aa-x" type="button" aria-label="Close">&times;</button>' +
        '<p class="aa-kicker">The Absence Audit</p>' +
        '<h2>Sign in</h2>' +
        '<p class="aa-sub">Your ledger opens with the email on your purchase receipt.</p>' +
        '<button class="aa-gbtn" id="aa-google" type="button">Continue with Google</button>' +
        '<div class="aa-or">or</div>' +
        '<form class="aa-elink" id="aa-elinkform">' +
          '<input id="aa-em" type="email" placeholder="you@receipt-email.com" autocomplete="email" required>' +
          '<button type="submit">Email me a link</button>' +
        '</form>' +
        '<p class="aa-msg" id="aa-msg" role="status"></p>' +
      '</div>';
    document.body.appendChild(modal);
    modal.querySelector(".aa-overlay").addEventListener("click", closeModal);
    modal.querySelector(".aa-x").addEventListener("click", closeModal);
    modal.querySelector("#aa-google").addEventListener("click", googleSignIn);
    modal.querySelector("#aa-elinkform").addEventListener("submit", function (ev) {
      ev.preventDefault();
      emailLink();
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && modal.classList.contains("open")) closeModal();
    });
    return modal;
  }
  function openModal() {
    var m = ensureModal();
    m.classList.add("open");
    m.querySelector("#aa-msg").textContent = "";
    var em = m.querySelector("#aa-em");
    setTimeout(function () { if (em) em.focus(); }, 50);
  }
  function closeModal() { if (modal) modal.classList.remove("open"); }
  function modalMsg(t, isErr) {
    var m = ensureModal();
    m.querySelector("#aa-msg").textContent = t;
    m.querySelector("#aa-msg").className = "aa-msg" + (isErr ? " err" : "");
  }
  function googleSignIn() {
    boot(function () {
      firebase.auth().signInWithPopup(new firebase.auth.GoogleAuthProvider())
        .then(function () { closeModal(); resolve(); })
        .catch(function (e) { modalMsg((e && e.message) || String(e), true); });
    });
  }
  function emailLink() {
    var m = ensureModal();
    var em = (m.querySelector("#aa-em").value || "").trim();
    if (!/^[^@]+@[^@]+$/.test(em)) { modalMsg("Enter a valid email address.", true); return; }
    try { localStorage.setItem("aaEmail", em); } catch (e) {}
    boot(function () {
      // Return the visitor to the page they signed in from (Google popup keeps
      // them on-page; email-link has to round-trip through the inbox, so bake
      // the current path into the continue URL for parity with the popup flow).
      firebase.auth().sendSignInLinkToEmail(em, { url: location.origin + location.pathname, handleCodeInApp: true })
        .then(function () {
          modalMsg("Check your inbox — we emailed " + em + " a sign-in link. Open it in this browser.");
        })
        .catch(function (e) { modalMsg((e && e.message) || String(e), true); });
    });
  }
  function completeEmailLink() {
    if (!firebase.auth().isSignInWithEmailLink(location.href)) return false;
    var em = null;
    try { em = localStorage.getItem("aaEmail"); } catch (e) {}
    if (!em) em = window.prompt("Confirm the email you used at checkout:");
    if (!em) return false;
    firebase.auth().signInWithEmailLink(em, location.href)
      .then(function () {
        try { localStorage.removeItem("aaEmail"); } catch (e) {}
        history.replaceState(null, "", location.pathname);
        resolve();
      })
      .catch(function () { resolve(); });
    return true;
  }

  // --------------------------------------------------------------- dossier gate
  function subMode() { return document.cookie.indexOf("aa_sub=1") >= 0; }
  function gateCard(kicker, title, sub, note) {
    var b = '<button class="aa-gbtn" id="aa-gate-signin" type="button">Sign in</button>';
    var n = note
      ? '<p class="aa-note">Bought it and still locked? Reply to your purchase receipt. ' +
        '<a href="' + VAULT + '">My ledger</a></p>'
      : "";
    return '<div class="aa-gate-card">' +
      '<p class="aa-kicker">' + kicker + "</p>" +
      "<h1>" + title + "</h1>" + "<p class=\"aa-sub\">" + sub + "</p>" +
      (note ? b : "") + n +
      "</div>";
  }
  function gateDossier() {
    var slug = CFG.dossier;
    if (!slug) return;
    // Start NEUTRAL. The auth state (SDK load + Firestore read) resolves a
    // second or two after paint; an entitled account must never see a false
    // "part of the paid ledger" gate before their access is confirmed. So the
    // card first says "checking your access", then either flips to the real
    // sign-in gate (not entitled) or is removed (entitled). Show nothing else
    // in the gap — the report is under here too and must stay covered either
    // way, so the overlay covers from the first paint.
    var overlay = document.createElement("div");
    overlay.id = "aa-gate";
    overlay.innerHTML = gateCard("The Absence Audit", "Checking your access\u2026",
                                 "Verifying your purchase and ledger access.", false);
    document.body.appendChild(overlay);
    function signInCard() {
      overlay.innerHTML = gateCard("The Absence Audit",
                                   "This dossier is part of the paid ledger.",
                                   "Sign in with your purchase email to read it.", true);
      var b = overlay.querySelector("#aa-gate-signin");
      if (b) b.addEventListener("click", openModal);
    }
    function revealDownload() {
      // The dossier's Download-PDF row is hidden by default (fail-closed)
      // and only appears to entitled readers — subscriber mode, a Full-Ledger
      // account, or an account that owns this slug. Same condition as the
      // gate, same reveal moment: no gate, no button.
      var dl = document.querySelector(".aa-pdf-dl");
      if (dl) dl.style.display = "flex";
    }
    function apply(st) {
      // Subscriber mode (aa_sub cookie, set by the invitation page) opens every
      // dossier too — the subscriber page promises "open any dossier and read
      // it in full", so the gate must honour that promise.
      var ok = subMode() ||
               (st.signedIn && (st.plan === "all" || (st.products || []).indexOf(slug) >= 0));
      if (ok) { overlay.remove(); revealDownload(); revealAgent(); }
      else { signInCard(); overlay.style.display = "flex"; }
    }
    if (state.ready) apply(state);
    else {
      listeners.push(apply);
      // Fail-closed: if auth never resolves (SDK/network), fall back to the
      // sign-in gate rather than hanging on "Checking your access" forever —
      // and never reveal the report beneath.
      setTimeout(function () { if (overlay.parentNode && !state.ready) apply(state); }, 5000);
    }
  }

  // --------------------------------------------------------- dossier agent
  // Each paid dossier page may carry window.AA_AGENT (injected by the publish
  // pipeline from agents.json; build_agents.py). The ElevenLabs conversational
  // widget appears ONLY at the entitled-reader moment — the same condition
  // that lifts the gate — so anonymous visitors never get an agent that has
  // read the full paid report. The agent is text-only (no mic permission,
  // billed per message, not per audio minute). The agent id is not a secret:
  // the dossier text is in the served bytes already; the widget reveal is the
  // gate convention, same as the Download-PDF row.
  function revealAgent() {
    var A = window.AA_AGENT;
    if (!A || !A.id || agentRevealed) return;
    agentRevealed = true;
    var el = document.createElement("elevenlabs-convai");
    el.setAttribute("agent-id", A.id);
    el.setAttribute("dismissible", "true");
    el.setAttribute("action-text", "Ask the report");
    el.setAttribute("start-call-text", "Ask a question");
    el.setAttribute("end-call-text", "Close");
    el.setAttribute("expand-text", "Ask this report");
    // ink-on-paper orb, per the site palette
    el.setAttribute("avatar-orb-color-1", "#16181d");
    el.setAttribute("avatar-orb-color-2", "#6b7280");
    document.body.appendChild(el);
    var s = document.createElement("script");
    s.src = "https://unpkg.com/@elevenlabs/convai-widget-embed";
    s.async = true;
    document.body.appendChild(s);
  }

  // -------------------------------------------------------- entitled invites
  // Subscriber mode (aa_sub cookie) turns [data-aa-invite] placeholders into
  // "Open research" links via an inline page script. Signed-in ENTITLEMENT
  // needs the same treatment: a Full-Ledger or owning account landing on a
  // presentation page (/c/<slug>/) must see the door to their dossier, not a
  // buy box for what they already own.
  function entitledFor(st, slug) {
    return st.signedIn &&
      (st.plan === "all" || (st.products || []).indexOf(slug) >= 0);
  }
  function inviteLinks(st) {
    if (!st.signedIn) return;
    var invs = document.querySelectorAll("[data-aa-invite]");
    var shown = false;
    for (var i = 0; i < invs.length; i++) {
      var el = invs[i], slug = el.getAttribute("data-aa-invite");
      if (!slug || !entitledFor(st, slug)) continue;
      // Guard against double-injection: the cookie-mode inline script may have
      // already placed the link next to this placeholder.
      if (el.getAttribute("data-aa-invited") === "1") continue;
      if (el.parentNode.querySelector('a[href^="' + VAULT + '"]')) continue;
      el.setAttribute("data-aa-invited", "1");
      var a = document.createElement("a");
      a.href = VAULT + encodeURIComponent(slug) + "/";
      a.className = el.getAttribute("data-aa-invite-class") || "row-btn";
      a.style.fontWeight = "600";
      a.textContent = "Open research \u2192";
      a.setAttribute("aria-label", "Open the full research for this concept");
      el.parentNode.insertBefore(a, el);
      shown = true;
    }
    if (shown) {
      var comms = document.querySelectorAll("[data-aa-commerce]");
      for (var j = 0; j < comms.length; j++) comms[j].style.display = "none";
    }
  }

  // ------------------------------------------------------------------ init
  function init() {
    chip = document.getElementById("aa-auth");
    if (!chip) {
      var nav = document.querySelector(".masthead nav");
      if (nav) {
        chip = document.createElement("span");
        chip.className = "aa-auth";
        nav.appendChild(chip);
      }
    }
    if (chip) renderChip();
    if (CFG.dossier) gateDossier();
    // Public pages (concept pages, owner order 2026-09-07): the agent widget
    // is open to every visitor — the full report is public on the page, so
    // the agent holds nothing that isn't already in the served bytes.
    else if (window.AA_AGENT) revealAgent();
    listeners.push(inviteLinks);
    start();
  }

  // ------------------------------------------------------------------ ledger
  // The personal ledger (/dossier/) is rendered by the shared ledger engine
  // (/assets/ledger.js), which reads this module's state and subscribes to
  // onReady. Nothing ledger-specific lives here anymore — one engine, one
  // access model, no drift between the public and personal surfaces.

  // -------------------------------------------------------------------- public
  window.AA = {
    onReady: function (f) {
      if (state.ready) f(state);
      else listeners.push(f);
    },
    openSignIn: openModal,
    signOut: function () {
      boot(function () { firebase.auth().signOut(); });
    },
    getState: function () { return state; }
  };

  function start() {
    var found = sessionInLocalStorage();
    // Fast-path for a returning entitled account: session + cached grant in
    // hand, open the dossier immediately (no SDK round-trip). The SDK still
    // loads and revalidates; a revoke re-locks once Firestore answers.
    var cache = readAccessCache();
    if (found && cache && cache.email) {
      setState({ email: cache.email, plan: cache.plan || null,
                 products: cache.products || [], signedIn: true, ready: true });
      boot(function () { completeEmailLink(); resolve(); });
      return;
    }
    if (found) { boot(function () { completeEmailLink(); resolve(); }); return; }
    sessionInIndexedDB(function (f) {
      if (f) { boot(function () { completeEmailLink(); resolve(); }); return; }
      if (!state.ready) {
        setState({ email: "", plan: null, products: [], signedIn: false, ready: true });
      }
      // Email-link deep links still need the SDK to complete the sign-in.
      boot(function () { completeEmailLink(); });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
