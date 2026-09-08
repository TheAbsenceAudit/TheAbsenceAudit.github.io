/* The Absence Audit — shared auth module (loaded on every page).
 *
 * One module, injected once per page by the publish pipeline:
 *   window.AA_AUTH = { fb: {...}, ledger: bool, dossier: "<slug>", report: "<slug>" }
 *
 *   ledger  -> /dossier/ (the personal ledger surface)
 *   dossier -> /dossier/<slug>/ (paid dossier pages; gated extras + report)
 *   report  -> /c/<slug>/ for cleared products (owner order 2026-09-07
 *              evening: the full report is no longer free text on product
 *              pages — it hides behind the entitlement check and reveals
 *              in place for dossier owners / subscribers)
 * Responsibilities:
 *  1. Masthead chip — "Sign in" button, or (signed in) "My ledger" door +
 *     "Sign out". Sign-in lands the visitor on their ledger (/dossier/) —
 *     the modal promises it and the code delivers it (owner order
 *     2026-09-07). Sign-out never navigates away.
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
  var state = { email: "", uid: null, plan: null, products: [], signedIn: false, ready: false };
  var freshSignIn = false; // armed by an explicit sign-in ACTION (Google popup
                           // or email link), never by session restore; consumed
                           // by resolve() to land the visitor on their ledger.
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
  function userEmail(u) {
    return ((u && (u.email || ((u.providerData || [])[0] || {}).email)) || "").toLowerCase();
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
      // A fresh sign-in ACTION (popup or email link — never session restore)
      // lands the visitor on their ledger: the modal promises "your ledger
      // opens", so signing in takes you home. Already on /dossier/? Stay.
      if (freshSignIn) {
        freshSignIn = false;
        if (location.pathname !== VAULT) location.assign(VAULT);
        return;
      }
      var em = userEmail(u);
      if (!em) { clearAccessCache(); setState({ email: "", uid: null, plan: null, products: [], signedIn: false, ready: true }); return; }
      var uid = u.uid || null;
      firebase.firestore().collection("access").doc(em).get()
        .then(function (snap) {
          var d = snap.exists ? (snap.data() || {}) : {};
          var st = {
            email: em,
            uid: uid,
            plan: d.plan === "all" ? "all" : null,
            products: (d.products && d.products.length) ? d.products : [],
            signedIn: true,
            ready: true
          };
          writeAccessCache({ email: em, uid: uid, plan: st.plan, products: st.products });
          setState(st);
        })
        .catch(function () {
          setState({ email: em, uid: uid, plan: null, products: [], signedIn: true, ready: true });
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
    // Signed-in cluster: ONE action and one exit. Identity and access level
    // (email, plan badge) moved to the ledger itself — the /dossier/
    // attribution strip carries the role and access badges — so the masthead
    // shows only the door, not the paperwork. The door is a solid button:
    // user testing showed an underlined text link read as plain text and
    // customers could not find their ledger.
    chip.innerHTML =
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
        '<p class="aa-sub">Sign in and your ledger opens.</p>' +
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
        .then(function () { freshSignIn = true; closeModal(); resolve(); })
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
        freshSignIn = true;
        history.replaceState(null, "", location.pathname);
        resolve();
      })
      .catch(function () { resolve(); });
    return true;
  }

  // --------------------------------------------------------------- dossier gate
  function subMode() { return document.cookie.indexOf("aa_sub=1") >= 0; }
  // Owner order 2026-09-07 (evening amendment): the full report on paid
  // product pages — dossier pages AND product concept pages — is no longer
  // free text. It hides behind the entitlement check (fail-closed,
  // data-aa-gated) alongside the paid EXTRAS: the Download-PDF row and the
  // full audio brief. All of them reveal at the same entitled moment —
  // subscriber cookie, a Full-Ledger account, or an account that owns this
  // slug. Rejected autopsies and the free sample stay fully public.
  function revealGated() {
    var g = document.querySelectorAll("[data-aa-gated]");
    for (var i = 0; i < g.length; i++) g[i].style.display = "";
    // The locked stand-in (data-aa-locked) is the anonymous placeholder for
    // the gated report on product concept pages; once the report reveals,
    // the stand-in goes away — never both at once.
    var l = document.querySelectorAll("[data-aa-locked]");
    for (var j = 0; j < l.length; j++) l[j].style.display = "none";
  }
  function revealDownload() {
    // The dossier's Download-PDF row is hidden by default (fail-closed)
    // and only appears to entitled readers — subscriber mode, a Full-Ledger
    // account, or an account that owns this slug. Same condition as the
    // other gated extras, same reveal moment.
    var dl = document.querySelector(".aa-pdf-dl");
    if (dl) dl.style.display = "flex";
  }
  function gateDossier() {
    var slug = CFG.dossier;
    if (!slug) return;
    function apply(st) {
      // Subscriber mode (aa_sub cookie, set by the invitation page) opens every
      // dossier too — the subscriber page promises "open any dossier and read
      // it in full", so the extras must honour that promise.
      var ok = subMode() ||
               (st.signedIn && (st.plan === "all" || (st.products || []).indexOf(slug) >= 0));
      if (ok) { revealDownload(); revealGated(); revealAgent(); }
      else { revealPublicAgent(); }
    }
    if (state.ready) apply(state);
    else listeners.push(apply);
  }

  // --------------------------------------------------------- product report gate
  // Cleared-product concept pages (/c/<slug>/) carry the same entitlement
  // check as the dossier (CFG.report): the full report and the chat agent
  // reveal in place for owners / subscribers; everyone else gets the locked
  // stand-in and the buy CTA. Same condition, same reveal moment.
  function gateReport() {
    var slug = CFG.report;
    if (!slug) return;
    function apply(st) {
      var ok = subMode() ||
               (st.signedIn && (st.plan === "all" || (st.products || []).indexOf(slug) >= 0));
      if (!ok) { revealPublicAgent(); return; }
      revealAgent();
      openServerReport(slug, st);
    }
    if (state.ready) apply(state);
    else listeners.push(apply);
  }

  // Server-delivered report (owner 2026-09-08, option D): the full report is
  // no longer in the served bytes on paid product pages — the static page
  // carries the locked stand-in and an empty [data-aa-report] target. The
  // entitled reader fetches the report from the Cloud Function, which
  // re-checks the entitlement server-side (Firebase ID token OR subscriber
  // invite token) and returns the HTML. Fail-closed: any failure keeps the
  // locked stand-in in place with an honest error note, never stale bytes.
  function openServerReport(slug, st) {
    var box = document.querySelector("[data-aa-report]");
    if (!box) return;
    var lock = document.querySelector("[data-aa-locked]");
    function fail(msg) {
      box.innerHTML = '<p style="margin:1rem 0;color:var(--ink-2)">The full report '
        + 'could not be loaded: ' + String(msg || "unknown error").replace(/</g, "&lt;")
        + '. Refresh to retry, or email info@theabsenceaudit.com.</p>';
      box.style.display = "";
    }
    boot(function () {
      var headers = { "Content-Type": "application/json" };
      var subTok = null;
      try { subTok = localStorage.getItem("aa_subtok"); } catch (e) {}
      if (subMode() && subTok) headers["X-Sub-Token"] = subTok;
      function doFetch(h) {
        var fn = CFG.reportFn;
        if (!fn) { fail("delivery not configured"); return; }
        fetch(fn + "?slug=" + encodeURIComponent(slug), { headers: h })
          .then(function (r) {
            if (!r.ok) throw new Error("http " + r.status);
            return r.json();
          })
          .then(function (d) {
            if (!d || !d.ok || !d.html) throw new Error("no report");
            box.innerHTML = d.html;
            box.style.display = "";
            if (lock) lock.style.display = "none";
          })
          .catch(function (e) { fail(e && e.message); });
      }
      if (st.signedIn && firebase.auth().currentUser) {
        firebase.auth().currentUser.getIdToken()
          .then(function (tok) { headers["Authorization"] = "Bearer " + tok; doFetch(headers); })
          .catch(function () { doFetch(headers); });
      } else {
        doFetch(headers);
      }
    });
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
  // -------------------------------------------------- inline voice card
  // Owner 2026-09-08: the ElevenLabs chat must sit INSIDE the report area,
  // in the reading flow — the widget bundle is hard-wired to a fixed screen
  // corner (and hides its orb on phones when collapsed), so we mount our own
  // inline card instead: a .aa-voice-card stub after the report figure,
  // rendered and wired by /assets/aa-voice.js on the official JS SDK
  // (@elevenlabs/client, self-hosted; loaded lazily on first tap).
  var voiceAssetsLoaded = false;
  function loadVoiceAssets() {
    if (voiceAssetsLoaded) return;
    voiceAssetsLoaded = true;
    var s = document.createElement("script");
    s.src = "/assets/aa-voice.js";
    s.async = true;
    document.body.appendChild(s);
  }

  function makeVoiceCard(agentId, title) {
    var badge = document.createElement("div");
    badge.className = "aa-voice-badge";
    badge.setAttribute("data-agent", agentId);
    badge.setAttribute("data-title", title);
    document.body.appendChild(badge);
    loadVoiceAssets();
  }

  // Public-content agent (owner 2026-09-08): anonymous visitors on gated
  // report/dossier pages get a PUBLIC ledger voice — prompt built from the
  // public verdicts only, so the paid report bytes are never exposed through
  // chat. The full agent (which has read the report) stays entitled-only.
  var PUBLIC_AGENT_ID = "agent_5001m209j2fge31snrs6s4tkxs6z";
  var publicAgentRevealed = false;
  function revealPublicAgent() {
    if (publicAgentRevealed || agentRevealed) return;
    publicAgentRevealed = true;
    makeVoiceCard(PUBLIC_AGENT_ID, "Ask the ledger — any concept, any verdict");
  }

  function revealAgent() {
    var A = window.AA_AGENT;
    if (!A || !A.id || agentRevealed) return;
    agentRevealed = true;
    // Upgrade the public badge to the full agent when the gate lifts.
    var badge = document.querySelector(".aa-voice-badge");
    if (badge) {
      badge.setAttribute("data-agent", A.id);
      badge.setAttribute("data-title", "Ask this report — the agent has read it in full");
      var t = document.querySelector(".aa-voice-title");
      if (t) t.textContent = "Ask this report — the agent has read it in full";
    } else {
      makeVoiceCard(A.id, "Ask this report — the agent has read it in full");
    }
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

  // ------------------------------------------------- post-pay recognition
  // (2026-09-08) Stripe appends ?session_id=cs_... to the after_completion
  // redirect. The claim Cloud Function retrieves the session server-side and,
  // when paid, grants access to the CHECKOUT email (the webhook does the same
  // async — either path suffices). If the visitor is signed in with that
  // email, entitlements re-resolve and the report opens in place; otherwise a
  // banner points them to sign in with the email they paid with. SILENT on
  // any failure — the webhook covers it and the page must never be blocked
  // by post-pay plumbing. The param is scrubbed only after a confirmed grant
  // so a refresh retries a failed claim.
  var CLAIMED_KEY = "aa_claimed_session_v1";
  function ensureClaimStyle() {
    if (document.getElementById("aa-claim-style")) return;
    var st = document.createElement("style");
    st.id = "aa-claim-style";
    st.textContent =
      "#aa-claim{position:fixed;left:0;right:0;bottom:0;z-index:900;" +
      "display:flex;gap:.9rem;align-items:center;justify-content:center;" +
      "padding:.65rem 1rem;background:var(--paper-2,#faf9f6);" +
      "border-top:1px solid var(--line,#d8d4c8);" +
      "font-family:var(--mono,ui-monospace,monospace);font-size:.85rem;" +
      "color:var(--ink,#16181d)}" +
      "#aa-claim .aa-claim-acts{display:flex;gap:.6rem;align-items:center}" +
      "#aa-claim button{font-size:.8rem}";
    document.head.appendChild(st);
  }
  function showClaimBar(d) {
    if (document.getElementById("aa-claim")) return;
    ensureClaimStyle();
    var mine = state.signedIn && state.email === String(d.email || "").toLowerCase();
    var bar = document.createElement("div");
    bar.id = "aa-claim";
    bar.setAttribute("role", "status");
    var msg = "Purchase confirmed for " + (d.emailMasked || d.email) + ".";
    msg += mine ? " Opening your report\u2026" : " Sign in with that email to open it.";
    bar.innerHTML =
      '<span class="aa-claim-msg">' + msg.replace(/</g, "&lt;") + "</span>" +
      '<span class="aa-claim-acts">' +
      (mine ? "" : '<button class="aa-btn" id="aa-claim-signin" type="button">Sign in</button>') +
      '<button class="aa-out" id="aa-claim-x" type="button" aria-label="Dismiss">&times;</button>' +
      "</span>";
    document.body.appendChild(bar);
    var b = bar.querySelector("#aa-claim-signin");
    if (b) b.addEventListener("click", function () {
      var m = ensureModal();
      m.classList.add("open");
      var em = m.querySelector("#aa-em");
      if (em) em.value = d.email;
      setTimeout(function () { if (em) em.focus(); }, 50);
    });
    bar.querySelector("#aa-claim-x").addEventListener("click", function () {
      if (bar.parentNode) bar.parentNode.removeChild(bar);
    });
  }
  function maybeClaim() {
    var m = (location.search || "").match(/[?&]session_id=(cs_(?:test|live)_[a-zA-Z0-9]+)/);
    if (!m) return;
    var sid = decodeURIComponent(m[1]);
    try {
      if (localStorage.getItem(CLAIMED_KEY) === sid) return;
    } catch (e) {}
    var fn = CFG.claimFn;
    if (!fn) return;
    setTimeout(function () {
      fetch(fn + "?session_id=" + encodeURIComponent(sid))
        .then(function (r) {
          if (!r.ok) throw new Error("http " + r.status);
          return r.json();
        })
        .then(function (d) {
          if (!d || !d.ok || d.status !== "granted" || !d.email) return;
          try { localStorage.setItem(CLAIMED_KEY, sid); } catch (e) {}
          try { history.replaceState(null, "", location.pathname + location.hash); } catch (e) {}
          showClaimBar(d);
          if (state.signedIn
              && state.email === String(d.email).toLowerCase()) {
            // The access doc was just written server-side: re-resolve so the
            // gate opens in place without a reload.
            boot(function () { resolve(); });
          }
        })
        .catch(function () { /* silent: webhook covers it; refresh retries */ });
    }, 800);
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
    else if (CFG.report) gateReport();
    // Public pages (rejected autopsies, the free sample — owner orders
    // 2026-09-07): the agent widget is open to every visitor — the full
    // report is public on the page, so the agent holds nothing that isn't
    // already in the served bytes.
    else if (window.AA_AGENT) revealAgent();
    // Public-content agent for anonymous visitors on GATED pages: revealed
    // IMMEDIATELY, before any Firebase boot, because the public ledger voice
    // needs no entitlement — waiting on auth left phone visitors with no
    // widget whenever the auth boot stalled (blocked gstatic, privacy mode).
    // gateReport/gateDossier upgrade it to the full agent at the entitled
    // moment; revealAgent() swaps the element.
    if (CFG.dossier || CFG.report) revealPublicAgent();
    listeners.push(inviteLinks);
    start();
    maybeClaim();
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
    // The lazy-SDK loader, shared with the ledger engine's favorites layer:
    // call AA.boot(cb) to run after firebase.app/auth/firestore are ready.
    boot: boot,
    getState: function () { return state; }
  };

  function start() {
    var found = sessionInLocalStorage();
    // Fast-path for a returning entitled account: session + cached grant in
    // hand, open the dossier immediately (no SDK round-trip). The SDK still
    // loads and revalidates; a revoke re-locks once Firestore answers.
    var cache = readAccessCache();
    if (found && cache && cache.email) {
      setState({ email: cache.email, uid: cache.uid || null, plan: cache.plan || null,
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
