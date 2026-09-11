/* The Absence Audit — floating voice badge (owner 2026-09-08, "Steve Jobs"):
 * a SMALL ink badge fixed to the viewport (follows the scroll), tap to talk.
 * Expands into a compact paper panel above the badge. Built on the official
 * ElevenLabs JavaScript SDK (@elevenlabs/client, self-hosted, lazy-loaded).
 *
 * - MILITARY-GRADE (2026-09-12): per-report agent ids are SECRET and never
 *   ship in page bytes. At tap time the badge asks the voiceSession Cloud
 *   Function (AA_AUTH.voiceFn) for a short-lived signed URL — the function
 *   re-checks entitlement server-side (subscriber hash / plan / products).
 *   On 403 or any failure the badge falls back to the PUBLIC ledger agent
 *   (data-agent), which stays auth-off by design. A locked agent accepts
 *   nothing but a signed URL, so an id extracted from anywhere is useless.
 * - WebRTC on mobile networks can fail to establish ("pc connection") —
 *   retry once automatically (re-minting a fresh signed URL), then fail
 *   with an honest status line.
 * - LIVE TRANSCRIPT (owner 2026-09-08): every word is written down — the
 *   agent's replies AND the visitor's own questions — through the SDK's
 *   onMessage callback (docs: "tentative or final transcriptions of user
 *   voice, replies produced by LLM"). Agent corrections (agent_response_
 *   correction client event) rewrite the last agent line in place. The
 *   transcript survives the call: it stays readable after the session ends
 *   and is cleared only when a new call starts.
 * - Fail-closed everywhere: mic denied / SDK load failure / session failure.
 */
(function () {
  "use strict";
  // Defensive mount (owner 2026-09-08): the badge must exist even when the
  // page's auth.js is a stale cached copy or a concurrent publish dropped the
  // reveal call. If auth.js did not mount the badge, create it here from the
  // page's own agent config (or the public ledger agent as the fallback).
  var PUBLIC_AGENT_ID = "agent_5001m209j2fge31snrs6s4tkxs6z";
  function pageWantsVoice() {
    var cfg = window.AA_AUTH;
    return !!(window.AA_AGENT ||
              (cfg && (cfg.report || cfg.dossier)));
  }
  function ensureBadge() {
    if (!pageWantsVoice()) return null;
    var b = document.querySelector(".aa-voice-badge");
    if (b) return b;
    // Fail-closed agent choice (owner security law): on GATED pages
    // (cfg.report / cfg.dossier) the defensive mount starts with the
    // PUBLIC ledger agent; the full per-report agent opens only through a
    // server-minted signed URL (voiceSession CF) at the entitled moment.
    // A stale-auth.js mount here can never hand a non-entitled visitor
    // the paid report's voice.
    var cfg = window.AA_AUTH || {};
    var gated = !!(cfg.report || cfg.dossier);
    var slug = cfg.report || cfg.dossier ||
               (window.AA_AGENT && window.AA_AGENT.slug) || "";
    var kind = cfg.dossier ? "dossier" : "c";
    var agent = PUBLIC_AGENT_ID;
    var title = (!gated && window.AA_AGENT)
      ? "Ask this report — the agent has read it in full"
      : "Ask the ledger — any concept, any verdict";
    b = document.createElement("div");
    b.className = "aa-voice-badge";
    b.setAttribute("data-agent", agent);
    b.setAttribute("data-title", title);
    if (slug) {
      b.setAttribute("data-slug", slug);
      b.setAttribute("data-kind", kind);
    }
    document.body.appendChild(b);
    return b;
  }
  var badge = ensureBadge();
  if (!badge) return;
  // Single-boot guard (owner 2026-09-08): auth.js's makeVoiceCard() legacy
  // dynamic loader pulls /assets/aa-voice.js a SECOND time even though every
  // page already carries the versioned tag in <head>. Two boots meant two
  // stacked panels and two live conversations per tap (double audio, double
  // billing). The first boot wires the badge; later boots are no-ops. The
  // flag is set only AFTER a badge mounted, so a page whose badge appears
  // after this script's first pass (late auth.js reveal) is still wired by
  // the later load.
  if (window.__aaVoiceBooted) return;
  window.__aaVoiceBooted = true;
  // auth.js may reveal (or upgrade) the badge slightly later than this
  // script runs — re-check once after the auth boot window and re-ensure.
  setTimeout(function () {
    var again = ensureBadge();
    if (again !== badge) {
      // auth.js created/upgraded a badge after us — adopt its attributes.
      ["data-agent", "data-title", "data-slug", "data-kind"].forEach(function (a) {
        var v = again.getAttribute(a);
        if (v) badge.setAttribute(a, v);
      });
      var t = document.querySelector(".aa-voice-title");
      if (t) t.textContent = again.getAttribute("data-title");
    }
  }, 4000);

  var sdkLoading = false;
  var conv = null, busy = false, retries = 0, sessionSeq = 0;

  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function loadSDK(cb) {
    if (window.ElevenLabsClient) return cb();
    if (sdkLoading) {
      var t = setInterval(function () {
        if (window.ElevenLabsClient) { clearInterval(t); cb(); }
      }, 250);
      return;
    }
    sdkLoading = true;
    var s = document.createElement("script");
    s.src = "/assets/elevenlabs-client.js";
    s.async = true;
    s.onload = function () { cb(); };
    s.onerror = function () { sdkLoading = false; cb(new Error("client failed to load")); };
    document.body.appendChild(s);
  }

  // ---- badge UI ----
  badge.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' +
    '<path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3z"/>' +
    '<path fill="currentColor" d="M17.3 11.2a.9.9 0 0 0-1.8.2 3.5 3.5 0 0 1-7 0 .9.9 0 0 0-1.8-.2 5.3 5.3 0 0 0 4.4 4.9V18H9.5a.9.9 0 0 0 0 1.8h5a.9.9 0 0 0 0-1.8h-1.6v-1.9a5.3 5.3 0 0 0 4.4-4.9z"/></svg>';
  badge.setAttribute("role", "button");
  badge.setAttribute("aria-label", "Voice chat");

  // ---- panel UI ----
  var panel = document.createElement("div");
  panel.className = "aa-voice-panel";
  panel.innerHTML =
    '<div class="aa-voice-top">' +
      '<span class="aa-voice-title">' + esc(badge.getAttribute("data-title") || "Ask the ledger") + "</span>" +
      '<button type="button" class="aa-voice-close" aria-label="Close">&times;</button>' +
    "</div>" +
    '<p class="aa-voice-status">Tap the microphone to talk.</p>' +
    '<div class="aa-voice-msgs" aria-live="polite"></div>' +
    '<div class="aa-voice-actions">' +
      '<button type="button" class="aa-voice-btn" aria-label="Start voice chat">' +
        '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">' +
        '<path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3z"/>' +
        '<path fill="currentColor" d="M17.3 11.2a.9.9 0 0 0-1.8.2 3.5 3.5 0 0 1-7 0 .9.9 0 0 0-1.8-.2 5.3 5.3 0 0 0 4.4 4.9V18H9.5a.9.9 0 0 0 0 1.8h5a.9.9 0 0 0 0-1.8h-1.6v-1.9a5.3 5.3 0 0 0 4.4-4.9z"/></svg>' +
      "</button>" +
    "</div>" +
    '<div class="aa-voice-powered">Powered by ElevenAgents</div>';
  document.body.appendChild(panel);

  var statusEl = panel.querySelector(".aa-voice-status");
  var msgsEl = panel.querySelector(".aa-voice-msgs");
  var btn = panel.querySelector(".aa-voice-btn");
  var closeBtn = panel.querySelector(".aa-voice-close");
  var lastAgentBody = null; // last agent line — rewritten by corrections

  function setStatus(msg, isError) {
    statusEl.textContent = msg;
    statusEl.className = "aa-voice-status" + (isError ? " aa-voice-err" : "");
  }

  function setLive(on) {
    badge.classList.toggle("aa-voice-live", on);
    btn.classList.toggle("aa-voice-live", on);
  }

  function scrollMsgs() {
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function appendMsg(who, text) {
    text = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
    if (!text) return;
    var w = document.createElement("div");
    w.className = "aa-voice-msg " + who;
    var label = document.createElement("div");
    label.className = "aa-voice-who";
    label.textContent = who === "user" ? "You" : "Agent";
    var body = document.createElement("div");
    body.className = "aa-voice-body";
    body.textContent = text;
    w.appendChild(label);
    w.appendChild(body);
    msgsEl.appendChild(w);
    msgsEl.classList.add("has-msgs");
    if (who === "agent") lastAgentBody = body;
    scrollMsgs();
  }

  function clearTranscript() {
    msgsEl.innerHTML = "";
    msgsEl.classList.remove("has-msgs");
    lastAgentBody = null;
  }

  // Page context for the agent (owner 2026-09-08, revised): the concept
  // slug + title of the page the visitor is reading — PUBLIC identity only
  // (the slug is in the URL, the title is on the page). ENTITLEMENT LAW:
  // page IDENTITY ships to EVERY agent, including the public ledger agent —
  // identity is public, so anchoring the public agent to the page costs
  // nothing. What never ships here is report CONTENT: the full text lives
  // only inside the per-report agents' prompts, and auth.js reveals those
  // agents only to entitled readers. Non-payers keep exactly the knowledge
  // surface the public page itself shows.
  function pageContext() {
    var cfg = window.AA_AUTH || {};
    var slug = cfg.report || cfg.dossier || "";
    if (!slug) {
      var m = location.pathname.match(/^\/(c|dossier)\/([^/]+)\/?$/);
      if (m) slug = m[2];
    }
    var title = (window.AA_AGENT && window.AA_AGENT.title) || "";
    if (!title) {
      var h1 = document.querySelector("h1");
      if (h1) title = h1.textContent.replace(/\s+/g, " ").trim();
    }
    if (!title) {
      title = String(document.title || "")
        .replace(/\s*\|\s*The Absence Audit\s*$/, "").trim();
    }
    return { slug: slug, page_title: title };
  }

  // SDK callbacks (docs: elevenlabs.io/docs/eleven-agents/libraries/java-script):
  // onMessage -> {source:"ai"|"user", role, message, event_id}; agent
  // corrections arrive on onAgentResponseCorrection; onStatusChange ->
  // {status: connected|connecting|disconnected}; onModeChange ->
  // {mode: speaking|listening}. Every callback is fenced by the session
  // sequence so a stale session's late events can never touch the panel.
  function sessionCallbacks(seq) {
    return {
      onMessage: function (m) {
        if (seq !== sessionSeq) return;
        if (m && m.source === "user") appendMsg("user", m.message);
        else if (m && m.source === "ai") appendMsg("agent", m.message);
      },
      onAgentResponseCorrection: function (evt) {
        if (seq !== sessionSeq) return;
        var t = evt && (evt.corrected_text || evt.agent_response ||
                        evt.text || evt.message);
        if (lastAgentBody && t) {
          lastAgentBody.textContent = String(t);
          scrollMsgs();
        }
      },
      onStatusChange: function (s) {
        if (seq !== sessionSeq) return;
        var st = s && s.status;
        if (st === "connected") setStatus("Connected — go ahead and ask.");
        else if (st === "disconnected") {
          // remote end (idle cap, agent hangup): honest state, keep the
          // transcript readable, one tap restarts.
          busy = false; conv = null;
          setLive(false);
          setStatus("Call ended — tap the microphone to talk again.");
        }
      },
      onModeChange: function (s) {
        if (seq !== sessionSeq) return;
        var m = s && s.mode;
        if (m === "speaking") setStatus("Speaking…");
        else if (m === "listening") setStatus("Listening — ask your question.");
      },
      onError: function (e) {
        // non-fatal mid-call errors: log, keep the session alive.
        if (window.console) console.error("aa-voice session error:", e);
      },
    };
  }

  function end() {
    sessionSeq += 1; // fence: stale events from this session are dropped
    if (conv) { try { conv.endSession(); } catch (e) {} conv = null; }
    busy = false;
    setLive(false);
  }

  // Begin a conversation with the given session options (signedUrl or
  // agentId) + the page-identity dynamic variables. Shared by the mint
  // path and the public-agent fallback path.
  function begin(withOpts, seq, cb) {
    var opts = Object.assign({}, withOpts, cb);
    // Entitlement law: page identity (slug + title — public, on screen)
    // ships to every agent, public ledger agent included. Report content
    // never ships as variables — it lives only inside the per-report
    // agents' prompts, which open only via server-minted signed URLs.
    opts.dynamicVariables = pageContext();
    window.ElevenLabsClient.Conversation.startSession(opts).then(function (c) {
      if (seq !== sessionSeq) { try { c.endSession(); } catch (e) {} return; }
      conv = c;
      retries = 0;
      setLive(true);
      setStatus("Listening — ask your question.");
    }).catch(function (e) {
      // WebRTC "pc connection" is the classic mobile-network failure.
      // One automatic retry (re-mints a fresh signed URL), then an
      // honest error.
      var msg = String((e && e.message) || e);
      if (retries < 1) {
        retries += 1;
        setStatus("Reconnecting…");
        setTimeout(function () { busy = false; start(); }, 900);
      } else {
        retries = 0; busy = false;
        setStatus("Could not start the call: " + esc(msg).slice(0, 90), true);
      }
    });
  }

  function start() {
    if (busy || conv) return;
    busy = true;
    var seq = ++sessionSeq;
    clearTranscript();
    setStatus("Requesting microphone access…");
    var p = navigator.mediaDevices
      ? navigator.mediaDevices.getUserMedia({ audio: true })
      : Promise.reject(new Error("no mediaDevices"));
    p.then(function () {
      setStatus("Connecting…");
      loadSDK(function (err) {
        if (err) { busy = false; setStatus("Voice is unavailable right now — try again in a moment.", true); return; }
        var cb = sessionCallbacks(seq);
        try {
          var slug = badge.getAttribute("data-slug") || "";
          if (slug) {
            // Military-grade path: ask the voiceSession CF for a signed
            // URL. The CF re-checks entitlement server-side; 403 or any
            // failure -> public ledger agent. The browser never holds an
            // agent id or an entitlement guess.
            var vfn = (window.AA_AUTH && window.AA_AUTH.voiceFn) || "";
            var getH = (window.AA && window.AA.getAuthHeaders)
              ? window.AA.getAuthHeaders
              : function (f) { f({}); };
            if (!vfn) { begin({ agentId: PUBLIC_AGENT_ID }, seq, cb); return; }
            getH(function (h) {
              fetch(vfn + "?slug=" + encodeURIComponent(slug) +
                    "&kind=" + encodeURIComponent(badge.getAttribute("data-kind") || "c"),
                    { headers: h })
                .then(function (r) {
                  if (!r.ok) throw new Error("http " + r.status);
                  return r.json();
                })
                .then(function (d) {
                  if (d && d.ok && d.signed_url) {
                    begin({ signedUrl: d.signed_url }, seq, cb);
                  } else {
                    begin({ agentId: PUBLIC_AGENT_ID }, seq, cb);
                  }
                })
                .catch(function () {
                  begin({ agentId: PUBLIC_AGENT_ID }, seq, cb);
                });
            });
          } else {
            begin({ agentId: PUBLIC_AGENT_ID }, seq, cb);
          }
        } catch (e) {
          busy = false;
          setStatus("Could not start the call: " + esc(String((e && e.message) || e)).slice(0, 90), true);
        }
      });
    }).catch(function () {
      busy = false;
      setStatus("Microphone blocked — allow microphone access for this site, then tap again.", true);
    });
  }

  function openPanel() {
    panel.classList.add("open");
  }
  function closePanel() {
    end();
    panel.classList.remove("open");
    setStatus("Tap the microphone to talk.");
  }

  badge.addEventListener("click", function () {
    if (panel.classList.contains("open")) { closePanel(); return; }
    openPanel();
    start();
  });
  btn.addEventListener("click", function () {
    if (conv) { end(); setStatus("Tap the microphone to talk."); }
    else start();
  });
  closeBtn.addEventListener("click", closePanel);
})();
