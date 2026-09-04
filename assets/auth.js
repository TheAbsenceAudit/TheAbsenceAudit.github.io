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
 *     products}. The ledger page and the dossier gates subscribe to this.
 *  4. Personal ledger renderer (/dossier/ index) and dossier lock overlays.
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
      if (!u) { setState({ email: "", plan: null, products: [], signedIn: false, ready: true }); return; }
      var em = userEmail(u);
      if (!em) { setState({ email: "", plan: null, products: [], signedIn: false, ready: true }); return; }
      firebase.firestore().collection("access").doc(em).get()
        .then(function (snap) {
          var d = snap.exists ? (snap.data() || {}) : {};
          setState({
            email: em,
            plan: d.plan === "all" ? "all" : null,
            products: (d.products && d.products.length) ? d.products : [],
            signedIn: true,
            ready: true
          });
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
    chip.innerHTML =
      '<a class="aa-who" href="' + VAULT + '">' + esc(state.email) + "</a>" +
      (bd ? '<span class="aa-badge">' + esc(bd) + "</span>" : "") +
      '<a class="aa-link" href="' + VAULT + '">My ledger</a>' +
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
      firebase.auth().sendSignInLinkToEmail(em, { url: location.origin + "/", handleCodeInApp: true })
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
  function gateDossier() {
    var slug = CFG.dossier;
    if (!slug) return;
    var overlay = document.createElement("div");
    overlay.id = "aa-gate";
    overlay.innerHTML =
      '<div class="aa-gate-card">' +
        '<p class="aa-kicker">The Absence Audit</p>' +
        '<h1>This dossier is part of the paid ledger.</h1>' +
        '<p class="aa-sub">Sign in with your purchase email to read it.</p>' +
        '<button class="aa-gbtn" id="aa-gate-signin" type="button">Sign in</button>' +
        '<p class="aa-note">Bought it and still locked? Reply to your purchase receipt. ' +
        '<a href="' + VAULT + '">My ledger</a></p>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.querySelector("#aa-gate-signin").addEventListener("click", openModal);
    function apply(st) {
      var ok = st.signedIn && (st.plan === "all" || (st.products || []).indexOf(slug) >= 0);
      if (ok) { overlay.remove(); }
      else { overlay.style.display = "flex"; }
    }
    if (state.ready) apply(state);
    else listeners.push(apply);
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
    if (CFG.ledger) ledgerInit();
    start();
  }

  // ------------------------------------------------------------------ ledger
  function ledgerInit() {
    var el = document.getElementById("aa-ledger");
    if (!el) return;
    var L = window.AA_LEDGER || { names: {}, tiers: {}, total: 0 };
    function rows(slugs) {
      var out = "";
      slugs.forEach(function (s) {
        out += '<li><a href="/dossier/' + encodeURIComponent(s) + '/">' + esc(L.names[s] || s) +
               "</a><span class=\"tier\">" + esc(L.tiers[s] || "") + "</span></li>";
      });
      return out;
    }
    function render(st) {
      if (!st.signedIn) {
        el.innerHTML =
          '<div class="ledger-intro">' +
            '<p class="eyebrow">The Absence Audit</p>' +
            '<h1>Your ledger</h1>' +
            '<p class="lede">Sign in to open the dossiers you bought — with the same email as your purchase receipt.</p>' +
            '<button class="row-btn" id="aa-ledger-signin" type="button">Sign in</button>' +
          "</div>";
        el.querySelector("#aa-ledger-signin").addEventListener("click", openModal);
        return;
      }
      var all = st.plan === "all";
      var slugs = all ? Object.keys(L.names)
                      : (st.products || []).filter(function (s) { return L.names[s]; });
      if (!all && !slugs.length) {
        el.innerHTML =
          '<div class="ledger-intro">' +
            '<p class="eyebrow">The Absence Audit</p>' +
            '<h1>No purchase for this email</h1>' +
            '<p class="lede">There is no paid access registered for ' + esc(st.email) +
            '. If you bought with a different email, sign out and use that one.</p>' +
            '<button class="aa-out" id="aa-ledger-out" type="button">Sign out</button>' +
            '<p class="note">Reply to your purchase receipt if something looks wrong.</p>' +
          "</div>";
        el.querySelector("#aa-ledger-out").addEventListener("click", function () {
          boot(function () { firebase.auth().signOut(); });
        });
        return;
      }
      var h =
        '<div class="ledger-user"><span class="who">' + esc(st.email) + "</span>" +
        '<button class="aa-out" id="aa-ledger-out" type="button">Sign out</button></div>' +
        '<p class="eyebrow">The Absence Audit</p><h1>Your ledger</h1>' +
        (all
          ? '<span class="aa-badge big">Full Ledger Access</span>' +
            '<p class="lede">Every dossier, past and future. New survivors appear here the moment the pipeline clears them.</p>'
          : '<p class="lede">The dossiers you own. Buy the full ledger for everything, past and future.</p>') +
        '<h2 class="ledger-h">Dossiers (' + slugs.length + (all ? " of " + L.total : "") + ")</h2>" +
        '<ul class="ledger-list">' + (slugs.length ? rows(slugs) : "<li>No dossiers found for this purchase — reply to your receipt.</li>") + "</ul>" +
        '<p class="note">Dossiers are licensed for your own use — see the <a href="/terms/">Terms of Use</a>.</p>';
      el.innerHTML = h;
      el.querySelector("#aa-ledger-out").addEventListener("click", function () {
        boot(function () { firebase.auth().signOut(); });
      });
    }
    if (state.ready) render(state);
    else listeners.push(render);
  }

  // -------------------------------------------------------------------- public
  window.AA = {
    onReady: function (f) {
      if (state.ready) f(state);
      else listeners.push(f);
    },
    openSignIn: openModal,
    getState: function () { return state; }
  };

  function start() {
    var found = sessionInLocalStorage();
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
