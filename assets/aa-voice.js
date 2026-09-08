/* The Absence Audit — inline voice assistant card.
 *
 * Owner law (2026-09-08): the ElevenLabs chat must sit INSIDE the report
 * area, in the reading flow — not a floating corner pill (the widget bundle
 * is hard-wired to fixed corner placement, so we build the card ourselves on
 * the official JavaScript SDK: @elevenlabs/client, self-hosted).
 *
 * - Card mounts after the report figure (auth.js inserts the .aa-voice-card
 *   stub; this script renders the UI and wires the SDK).
 * - The agent id is read from data-agent at TAP time, so the entitled
 *   upgrade (public ledger agent -> full per-report agent) applies without
 *   rebuilding the card.
 * - SDK (1.1 MB) loads lazily on first tap; page load stays light.
 * - Fail-closed: mic denied / session failure / SDK load failure all show an
 *   honest status line, never a silent dead button.
 */
(function () {
  "use strict";
  var cards = document.querySelectorAll(".aa-voice-card");
  if (!cards.length) return;

  var sdkLoaded = false, sdkLoading = false;
  var conv = null, busy = false;

  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function loadSDK(cb) {
    if (window.ElevenLabsClient) return cb();
    if (sdkLoading) { var t = setInterval(function () { if (window.ElevenLabsClient) { clearInterval(t); cb(); } }, 300); return; }
    sdkLoading = true;
    var s = document.createElement("script");
    s.src = "/assets/elevenlabs-client.js";
    s.async = true;
    s.onload = function () { sdkLoaded = !!window.ElevenLabsClient; cb(); };
    s.onerror = function () { sdkLoading = false; cb(new Error("client failed to load")); };
    document.body.appendChild(s);
  }

  cards.forEach(function (card) {
    var title = card.getAttribute("data-title") || "Ask this report";
    card.innerHTML =
      '<div class="aa-voice-head">' +
        '<span class="aa-voice-title">' + esc(title) + "</span>" +
      "</div>" +
      '<div class="aa-voice-body">' +
        '<button type="button" class="aa-voice-btn" aria-label="Start voice chat">' +
          '<span class="aa-voice-mic" aria-hidden="true">🎙</span>' +
        "</button>" +
        '<span class="aa-voice-status">Tap the microphone to talk.</span>' +
      "</div>" +
      '<div class="aa-voice-powered">Voice assistant · powered by ElevenAgents</div>';

    var btn = card.querySelector(".aa-voice-btn");
    var statusEl = card.querySelector(".aa-voice-status");

    function setStatus(msg, isError) {
      statusEl.textContent = msg;
      statusEl.className = "aa-voice-status" + (isError ? " aa-voice-err" : "");
    }

    function end() {
      if (conv) { try { conv.endSession(); } catch (e) {} conv = null; }
      btn.classList.remove("aa-voice-live");
      busy = false;
    }

    btn.addEventListener("click", function () {
      if (conv) { end(); setStatus("Tap the microphone to talk again."); return; }
      if (busy) return;
      busy = true;
      setStatus("Requesting microphone access…");
      var p = navigator.mediaDevices
        ? navigator.mediaDevices.getUserMedia({ audio: true })
        : Promise.reject(new Error("no mediaDevices"));
      p.then(function () {
        setStatus("Connecting to the agent…");
        loadSDK(function (err) {
          if (err) { busy = false; setStatus("Voice is unavailable right now — try again in a moment.", true); return; }
          try {
            var C = window.ElevenLabsClient.Conversation;
            C.startSession({ agentId: card.getAttribute("data-agent") }).then(function (c) {
              conv = c;
              btn.classList.add("aa-voice-live");
              setStatus("Listening — tap to end. Speak when it pauses.");
            }).catch(function (e) {
              busy = false;
              setStatus("Could not start the call: " + esc(String((e && e.message) || e)).slice(0, 90), true);
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
    });
  });
})();
