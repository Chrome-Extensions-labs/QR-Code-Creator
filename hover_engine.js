/* =============================================================
   hover_engine.js  —  8-BIT QR CODE MAKER  |  Hover Engine
   Content script injected after libs/qr-code-styling.min.js

   Listens for mouseenter events on <a> elements.
   If the hover feature is enabled, generates a mini QR code
   using QRCodeStyling (loaded before this script in manifest)
   and shows a pixel-bordered floating tooltip near the cursor.

   MESSAGING (incoming):
     content.js dispatches CustomEvent 'qrm:hoverToggle'
     → this script updates its enabled state

   STORAGE:
     Reads 'qrMaker_hoverEnabled' from chrome.storage.sync
     on script load, and listens for live changes via the
     custom event dispatched by content.js.
   ============================================================= */

'use strict';

/* ─────────────────────────────────────────────────────────────
   GUARD: don't run inside iframes or special pages
   ───────────────────────────────────────────────────────────── */
if (window.self !== window.top) {
  throw new Error('[HoverEngine] Skipping iframe context.');
}

/* ─────────────────────────────────────────────────────────────
   CONSTANTS
   ───────────────────────────────────────────────────────────── */
const HOVER_KEY      = 'qrMaker_hoverEnabled';
const HOVER_DELAY_MS = 350;   // ms delay before tooltip appears (avoids flash)
const QR_SIZE        = 120;   // tooltip QR size in pixels
const TOOLTIP_ID     = '__qrm_hover_tooltip__';

/* PICO-8 colours used for the tooltip frame */
const COLOR = {
  black:  '#000000',
  green:  '#00E436',
  dgrn:   '#008751',
  dblu:   '#1D2B53',
  white:  '#FFF1E8',
  lgrey:  '#C2C3C7',
};

/* ─────────────────────────────────────────────────────────────
   STATE
   ───────────────────────────────────────────────────────────── */
let hoverEnabled = false;    // master on/off switch
let hoverTimer   = null;     // delay timer handle
let currentLink  = null;     // the <a> element currently being hovered
let tooltipEl    = null;     // the floating div (created on demand)
let qrInstance   = null;     // reused QRCodeStyling instance

/* ─────────────────────────────────────────────────────────────
   LOAD INITIAL STATE from chrome.storage.sync
   ───────────────────────────────────────────────────────────── */
chrome.storage.sync.get([HOVER_KEY], result => {
  hoverEnabled = result[HOVER_KEY] ?? false;
  if (hoverEnabled) attachListeners();
  console.log('[HoverEngine] initialised, enabled:', hoverEnabled);
});

/* ─────────────────────────────────────────────────────────────
   LISTEN FOR LIVE TOGGLE from content.js custom event
   MESSAGING FLOW:
     popup.js changes toggle
       → chrome.tabs.sendMessage({ type: 'HOVER_TOGGLE' })
         → content.js onMessage
           → dispatchEvent('qrm:hoverToggle')
             → HERE
   ───────────────────────────────────────────────────────────── */
document.addEventListener('qrm:hoverToggle', e => {
  const { enabled } = e.detail;
  hoverEnabled = enabled;
  if (enabled) {
    attachListeners();
  } else {
    detachListeners();
    hideTooltip();
  }
  console.log('[HoverEngine] toggled:', enabled);
});

/* ─────────────────────────────────────────────────────────────
   TOOLTIP ELEMENT
   Created once and reused. Styled inline for host-page safety.
   Uses pixel-art aesthetics: hard borders, zero border-radius,
   PICO-8 palette, chunky corner decorators.
   ───────────────────────────────────────────────────────────── */
function createTooltip() {
  if (tooltipEl) return tooltipEl;

  const wrap = document.createElement('div');
  wrap.id = TOOLTIP_ID;

  Object.assign(wrap.style, {
    position:        'fixed',
    zIndex:          '2147483646',
    pointerEvents:   'none',
    display:         'none',
    flexDirection:   'column',
    alignItems:      'center',
    gap:             '0',
    // PICO-8 dark blue background
    background:      COLOR.dblu,
    border:          `3px solid ${COLOR.green}`,
    // Chunky pixel drop-shadow
    boxShadow:       `4px 4px 0 ${COLOR.black}, 0 0 0 1px ${COLOR.black}`,
    padding:         '4px',
    imageRendering:  'pixelated',
  });

  // Four pixel corner decorators (2×2 green squares)
  ['tl','tr','bl','br'].forEach(pos => {
    const corner = document.createElement('div');
    Object.assign(corner.style, {
      position: 'absolute',
      width: '6px', height: '6px',
      background: COLOR.green,
      ...(pos === 'tl' ? { top: '-3px', left: '-3px' } : {}),
      ...(pos === 'tr' ? { top: '-3px', right: '-3px' } : {}),
      ...(pos === 'bl' ? { bottom: '-3px', left: '-3px' } : {}),
      ...(pos === 'br' ? { bottom: '-3px', right: '-3px' } : {}),
    });
    wrap.appendChild(corner);
  });

  // Inner white canvas container (QR renders here)
  const canvasWrap = document.createElement('div');
  canvasWrap.id = '__qrm_hover_canvas__';
  Object.assign(canvasWrap.style, {
    width:           `${QR_SIZE}px`,
    height:          `${QR_SIZE}px`,
    background:      COLOR.white,
    display:         'flex',
    alignItems:      'center',
    justifyContent:  'center',
    imageRendering:  'pixelated',
  });
  wrap.appendChild(canvasWrap);

  // Label below the QR
  const label = document.createElement('div');
  Object.assign(label.style, {
    fontFamily:     '"Press Start 2P", monospace',
    fontSize:       '5px',
    color:          COLOR.lgrey,
    padding:        '3px 2px 1px',
    letterSpacing:  '0.5px',
    textAlign:      'center',
    maxWidth:       `${QR_SIZE}px`,
    overflow:       'hidden',
    textOverflow:   'ellipsis',
    whiteSpace:     'nowrap',
  });
  label.id = '__qrm_hover_label__';
  wrap.appendChild(label);

  document.documentElement.appendChild(wrap);
  tooltipEl = wrap;
  return wrap;
}

/* ─────────────────────────────────────────────────────────────
   QR GENERATION in tooltip
   LIBRARY: QRCodeStyling — same library used by popup.js.
   We reuse a single instance, calling .update() for each link.
   ───────────────────────────────────────────────────────────── */
function renderHoverQR(url) {
  const canvasWrap = document.getElementById('__qrm_hover_canvas__');
  if (!canvasWrap) return;

  /** @type {import('qr-code-styling').Options} */
  const cfg = {
    width:   QR_SIZE,
    height:  QR_SIZE,
    type:    'canvas',
    data:    url,
    dotsOptions: {
      type:  'square',          // always square for hover — pixel perfect
      color: COLOR.black,
    },
    cornersSquareOptions: { type: 'square', color: COLOR.black },
    cornersDotOptions:    { type: 'square', color: COLOR.black },
    backgroundOptions:    { color: COLOR.white },
    qrOptions: { errorCorrectionLevel: 'M' },
  };

  if (!qrInstance) {
    // LIBRARY: first render — create instance and append
    qrInstance = new QRCodeStyling(cfg);
    qrInstance.append(canvasWrap);
  } else {
    // LIBRARY: subsequent renders — update in-place
    qrInstance.update(cfg);
  }
}

/* ─────────────────────────────────────────────────────────────
   TOOLTIP POSITIONING
   Keeps the tooltip fully within the viewport.
   ───────────────────────────────────────────────────────────── */
function positionTooltip(mouseX, mouseY) {
  if (!tooltipEl) return;

  const OFFSET    = 16;             // pixels from cursor
  const vpW       = window.innerWidth;
  const vpH       = window.innerHeight;
  const tipW      = QR_SIZE + 16;  // approx width with padding
  const tipH      = QR_SIZE + 30;  // approx height with label

  let x = mouseX + OFFSET;
  let y = mouseY + OFFSET;

  // Flip to the left if overflowing right edge
  if (x + tipW > vpW - 10) x = mouseX - tipW - OFFSET;
  // Flip above if overflowing bottom edge
  if (y + tipH > vpH - 10) y = mouseY - tipH - OFFSET;

  // Clamp to viewport
  x = Math.max(6, x);
  y = Math.max(6, y);

  tooltipEl.style.left = `${x}px`;
  tooltipEl.style.top  = `${y}px`;
}

/* ─────────────────────────────────────────────────────────────
   SHOW / HIDE TOOLTIP
   ───────────────────────────────────────────────────────────── */
function showTooltip(url, mouseX, mouseY) {
  const tip = createTooltip();

  renderHoverQR(url);

  // Update label
  const label = document.getElementById('__qrm_hover_label__');
  if (label) {
    try {
      label.textContent = new URL(url).hostname || url;
    } catch {
      label.textContent = url.slice(0, 30);
    }
  }

  positionTooltip(mouseX, mouseY);
  tip.style.display = 'flex';
}

function hideTooltip() {
  if (tooltipEl) tooltipEl.style.display = 'none';
  clearTimeout(hoverTimer);
  hoverTimer  = null;
  currentLink = null;
}

/* ─────────────────────────────────────────────────────────────
   LINK HOVER HANDLERS
   ───────────────────────────────────────────────────────────── */

/** Stores last known mouse position for tooltip placement */
let _mouseX = 0;
let _mouseY = 0;

function onMouseMove(e) {
  _mouseX = e.clientX;
  _mouseY = e.clientY;
  // Reposition if tooltip is visible
  if (tooltipEl && tooltipEl.style.display !== 'none') {
    positionTooltip(_mouseX, _mouseY);
  }
}

function onLinkEnter(e) {
  if (!hoverEnabled) return;

  const link = e.currentTarget;
  const url  = link.href;

  // Skip non-http links (javascript:, mailto:, tel:, #fragments on same page)
  if (!url || !url.startsWith('http')) return;

  currentLink = link;

  // Delayed show — avoids flash when quickly passing over links
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    if (currentLink === link) {
      showTooltip(url, _mouseX, _mouseY);
    }
  }, HOVER_DELAY_MS);
}

function onLinkLeave(e) {
  clearTimeout(hoverTimer);
  // Small grace period so cursor can reach the tooltip edge
  hoverTimer = setTimeout(hideTooltip, 80);
}

/* ─────────────────────────────────────────────────────────────
   ATTACH / DETACH LISTENERS
   We use event delegation on document for efficiency — no need
   to re-wire on dynamic DOM mutations.
   ───────────────────────────────────────────────────────────── */
let _listenersAttached = false;

/**
 * Delegate handler — finds the nearest <a> ancestor.
 */
function delegatedEnter(e) {
  if (!hoverEnabled) return;
  const link = e.target.closest('a[href]');
  if (link) {
    // Temporarily assign currentTarget for handler compatibility
    const fakeEvent = Object.create(e, {
      currentTarget: { value: link }
    });
    link.href && onLinkEnter(fakeEvent);
  }
}

function delegatedLeave(e) {
  const link = e.target.closest('a[href]');
  if (link) onLinkLeave(e);
}

function attachListeners() {
  if (_listenersAttached) return;
  document.addEventListener('mouseover',  delegatedEnter, true);
  document.addEventListener('mouseout',   delegatedLeave, true);
  document.addEventListener('mousemove',  onMouseMove,    { passive: true });
  _listenersAttached = true;
  console.log('[HoverEngine] Listeners attached.');
}

function detachListeners() {
  document.removeEventListener('mouseover',  delegatedEnter, true);
  document.removeEventListener('mouseout',   delegatedLeave, true);
  document.removeEventListener('mousemove',  onMouseMove);
  _listenersAttached = false;
  console.log('[HoverEngine] Listeners removed.');
}

/* ─────────────────────────────────────────────────────────────
   STORAGE CHANGE LISTENER
   Handles changes made from another popup instance or device
   (chrome.storage.sync fires across contexts).
   ───────────────────────────────────────────────────────────── */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && HOVER_KEY in changes) {
    const enabled = changes[HOVER_KEY].newValue ?? false;
    hoverEnabled  = enabled;
    if (enabled) {
      attachListeners();
    } else {
      detachListeners();
      hideTooltip();
    }
  }
});
