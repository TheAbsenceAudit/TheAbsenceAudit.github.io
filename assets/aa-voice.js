/* The Absence Audit — floating voice badge (owner 2026-09-08, "Steve Jobs"):
 * a SMALL ink badge fixed to the viewport (follows the scroll), tap to talk.
 * Expands into a compact paper panel above the badge. Built on the official
 * ElevenLabs JavaScript SDK (@elevenlabs/client, self-hosted, lazy-loaded).
 *
 * - agent id is read from data-agent at TAP time, so the entitled upgrade
 *   (public ledger agent -> full per-report agent) needs no rebuild.
 * - WebRTC on mobile networks can fail to establish ("pc connection") —
 *   retry once automatically, then fail with an honest status line.
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
    var agent = (window.AA_AGENT && window.AA_AGENT.id) || PUBLIC_AGENT_ID;
    var title = window.AA_AGENT
      ? "Ask this report — the agent has read it in full"
      : "Ask the ledger — any concept, any verdict";
    b = document.createElement("div");
    b.className = "aa-voice-badge";
    b.setAttribute("data-agent", agent);
    b.setAttribute("data-title", title);
    document.body.appendChild(b);
    return b;
  }
  var badge = ensureBadge();
  if (!badge) return;
  // auth.js may reveal (or upgrade) the badge slightly later than this
  // script runs — re-check once after the auth boot window and re-ensure.
  setTimeout(function () {
    var again = ensureBadge();
    if (again !== badge) {
      // auth.js created/upgraded a badge after us — prefer its agent id.
      badge.setAttribute("data-agent", again.getAttribute("data-agent"));
      badge.setAttribute("data-title", again.getAttribute("data-title"));
      var t = document.querySelector(".aa-voice-title");
      if (t) t.textContent = again.getAttribute("data-title");
    }
  }, 4000);

  var sdkLoading = false;
  var conv = null, busy = false, retries = 0;

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
  var btn = panel.querySelector(".aa-voice-btn");
  var closeBtn = panel.querySelector(".aa-voice-close");

  function setStatus(msg, isError) {
    statusEl.textContent = msg;
    statusEl.className = "aa-voice-status" + (isError ? " aa-voice-err" : "");
  }

  function setLive(on) {
    badge.classList.toggle("aa-voice-live", on);
    btn.classList.toggle("aa-voice-live", on);
  }

  function end() {
    if (conv) { try { conv.endSession(); } catch (e) {} conv = null; }
    busy = false;
    setLive(false);
  }

  function start() {
    if (busy || conv) return;
    busy = true;
    setStatus("Requesting microphone access…");
    var p = navigator.mediaDevices
      ? navigator.mediaDevices.getUserMedia({ audio: true })
      : Promise.reject(new Error("no mediaDevices"));
    p.then(function () {
      setStatus("Connecting…");
      loadSDK(function (err) {
        if (err) { busy = false; setStatus("Voice is unavailable right now — try again in a moment.", true); return; }
        try {
          window.ElevenLabsClient.Conversation.startSession({
            agentId: badge.getAttribute("data-agent")
          }).then(function (c) {
            conv = c;
            retries = 0;
            setLive(true);
            setStatus("Listening — tap the button to end.");
          }).catch(function (e) {
            // WebRTC "pc connection" is the classic mobile-network failure.
            // One automatic retry, then an honest error.
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
