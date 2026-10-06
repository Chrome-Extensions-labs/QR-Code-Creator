/* =============================================================
   content.js  —  8-BIT QR CODE MAKER  |  Content Script
   Injected into every page by manifest.json content_scripts.

   Responsibilities:
     1. Display pixel-art "Toast" notifications sent by background.js
     2. Route HOVER_TOGGLE messages to hover_engine.js state
   ============================================================= */

'use strict';

/* ─────────────────────────────────────────────────────────────
   PIXEL-ART TOAST SYSTEM
   Injects a styled div into the page for retro notifications.
   The toast is styled entirely inline (no external CSS needed),
   using the PICO-8 colour palette for authenticity.
   ───────────────────────────────────────────────────────────── */

/** Singleton toast element — created once, reused */
let _toastEl    = null;
let _toastTimer = null;

/**
 * Creates (or returns) the singleton toast DOM element.
 * Styled inline so it works on any host page without CSS conflicts.
 */
function getToastEl() {
  if (_toastEl) return _toastEl;

  const el = document.createElement('div');
  el.id = '__qrm_toast__';

  Object.assign(el.style, {
    // Position: fixed, bottom-right corner like an 8-bit HUD element
    position:        'fixed',
    bottom:          '20px',
    right:           '20px',
    zIndex:          '2147483647',   // max z-index
    // PICO-8 colours
    background:      '#000000',
    color:           '#00E436',
    border:          '2px solid #00E436',
    // The classic 3px right-down offset = raised pixel shadow
    boxShadow:       '3px 3px 0 #008751',
    // Press Start 2P from Google Fonts (must be available on the page;
    // falls back to system monospace)
    fontFamily:      '"Press Start 2P", monospace',
    fontSize:        '7px',
    lineHeight:      '1.5',
    padding:         '8px 14px',
    maxWidth:        '300px',
    wordBreak:       'break-word',
    pointerEvents:   'none',
    // Hidden initially
    opacity:         '0',
    transform:       'translateY(10px)',
    // Steps-based transition = snappy pixel appearance (no smooth easing)
    transition:      'opacity 0.08s steps(2), transform 0.1s steps(3)',
    imageRendering:  'pixelated',
    letterSpacing:   '0.5px',
  });

  document.documentElement.appendChild(el);
  _toastEl = el;
  return el;
}

/**
 * Shows a pixel-art toast notification on the host page.
 * @param {string}  message   — text to display
 * @param {boolean} isError   — red theme if true, green if false
 * @param {number}  duration  — milliseconds before auto-hide
 */
function showPageToast(message, isError = false, duration = 2500) {
  const el = getToastEl();

  // Apply error vs success colour scheme
  if (isError) {
    el.style.color      = '#FF004D';
    el.style.border     = '2px solid #FF004D';
    el.style.boxShadow  = '3px 3px 0 #8b0000';
  } else {
    el.style.color      = '#00E436';
    el.style.border     = '2px solid #00E436';
    el.style.boxShadow  = '3px 3px 0 #008751';
  }

  el.textContent = message;

  // Trigger show (next microtask to ensure transition fires)
  requestAnimationFrame(() => {
    el.style.opacity   = '1';
    el.style.transform = 'translateY(0)';
  });

  // Auto-hide
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    el.style.opacity   = '0';
    el.style.transform = 'translateY(10px)';
  }, duration);
}

/* ─────────────────────────────────────────────────────────────
   MESSAGE LISTENER
   Receives messages from background.js.

   MESSAGING FLOW (incoming):
     background.js  →  chrome.tabs.sendMessage(tabId, msg)
       →  content.js: chrome.runtime.onMessage listener
         SHOW_TOAST  → display pixel toast on page
         HOVER_TOGGLE → update hover_engine.js via custom event
   ───────────────────────────────────────────────────────────── */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {

    case 'SHOW_TOAST':
      /*
        Triggered by background.js after reverse-scanner success/failure.
        Displays a retro toast in the bottom-right of the current page.
      */
      showPageToast(msg.message, msg.isError ?? false, msg.duration ?? 2500);
      sendResponse({ ok: true });
      break;

    case 'HOVER_TOGGLE':
      /*
        Triggered by popup.js when the hover engine toggle is changed.
        We re-dispatch as a custom DOM event so hover_engine.js
        (which lives in the same content-script context) can hear it
        without needing its own chrome.runtime.onMessage listener.

        MESSAGING FLOW (outgoing to hover_engine):
          content.js → CustomEvent 'qrm:hoverToggle'
            → hover_engine.js addEventListener('qrm:hoverToggle')
      */
      document.dispatchEvent(new CustomEvent('qrm:hoverToggle', {
        detail: { enabled: msg.enabled },
      }));
      sendResponse({ ok: true });
      break;

    default:
      sendResponse({ ok: false, error: 'UNKNOWN MESSAGE TYPE' });
  }

  return true; // keep message channel open for async sendResponse
});

// Signal that the content script is alive (helps background detect active tabs)
console.log('[QR Maker] content.js loaded on', location.hostname);
