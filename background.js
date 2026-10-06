/* =============================================================
   background.js  —  8-BIT QR CODE MAKER  |  Service Worker
   Handles: Context Menus · Reverse Scanner (jsQR) · Messaging
   NOTE: This is a CLASSIC (non-module) service worker so that
         importScripts() can load the jsQR library.
   ============================================================= */

'use strict';

/*
  LIBRARY: jsQR — loaded via importScripts so the service worker
  can decode QR images without spinning up a full page context.
  jsQR is exposed as a global function: jsQR(imageData, w, h)
*/
try {
  importScripts('libs/jsqr.js');
} catch (e) {
  console.error('[BG] Failed to load jsqr:', e);
}

/* ─────────────────────────────────────────────────────────────
   CONTEXT MENU IDs
   ───────────────────────────────────────────────────────────── */
const MENU = {
  SELECTION: 'qrm_selection',
  LINK:      'qrm_link',
  SCAN_IMG:  'qrm_scan_image',
};

/* ─────────────────────────────────────────────────────────────
   CREATE CONTEXT MENUS  (on first install / update)
   ───────────────────────────────────────────────────────────── */
chrome.runtime.onInstalled.addListener(() => {
  // Clear any stale menus
  chrome.contextMenus.removeAll(() => {

    /**
     * MENU 1: Generate QR from selected text.
     * Visible only when text is selected on a page.
     * The "%s" token is replaced by the selected text by Chrome.
     */
    chrome.contextMenus.create({
      id:       MENU.SELECTION,
      title:    '🎮 Generate 8-Bit QR for: "%s"',
      contexts: ['selection'],
    });

    /**
     * MENU 2: Generate QR from a hovered hyperlink.
     * Visible only when right-clicking an anchor/link.
     */
    chrome.contextMenus.create({
      id:       MENU.LINK,
      title:    '🔗 Generate 8-Bit QR for this link',
      contexts: ['link'],
    });

    /**
     * MENU 3: Reverse-scan QR from an image on the page.
     * Visible only when right-clicking an image element.
     * If the image doesn't contain a QR, we show an error toast.
     */
    chrome.contextMenus.create({
      id:       MENU.SCAN_IMG,
      title:    '🔍 Scan this image for QR code',
      contexts: ['image'],
    });
  });

  console.log('[BG] Context menus installed.');
});

/* ─────────────────────────────────────────────────────────────
   CONTEXT MENU CLICK HANDLER
   ───────────────────────────────────────────────────────────── */
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  switch (info.menuItemId) {

    /* ── Selected text → open popup with that text pre-loaded ── */
    case MENU.SELECTION: {
      const text = info.selectionText?.trim();
      if (!text) return;

      /*
        MESSAGING FLOW (Selection):
          1. Store data in chrome.storage.session (popup reads it on open)
          2. Open / focus the extension popup
      */
      await chrome.storage.session.set({ pendingQrData: text });
      await openPopup(tab);
      break;
    }

    /* ── Link → open popup with URL pre-loaded ── */
    case MENU.LINK: {
      const url = info.linkUrl?.trim();
      if (!url) return;

      /*
        MESSAGING FLOW (Link):
          Same pattern — session storage → popup reads on open.
      */
      await chrome.storage.session.set({ pendingQrData: url });
      await openPopup(tab);
      break;
    }

    /* ── Image → decode QR code from the image URL ── */
    case MENU.SCAN_IMG: {
      const imageUrl = info.srcUrl;
      if (!imageUrl) {
        sendToastToTab(tab.id, '✖ NO IMAGE URL FOUND', true);
        return;
      }
      await reverseScanner(imageUrl, tab);
      break;
    }
  }
});

/* ─────────────────────────────────────────────────────────────
   OPEN POPUP HELPER
   chrome.action.openPopup() is only available in MV3 extensions
   when triggered by a user gesture, so we use a workaround:
   We send a message to the popup if it's open, otherwise the
   session-storage data will be read the next time it opens.
   ───────────────────────────────────────────────────────────── */
async function openPopup(tab) {
  try {
    // Try to open the popup programmatically (Chrome 127+)
    if (chrome.action.openPopup) {
      await chrome.action.openPopup();
    }
    // Also try messaging in case popup is already open
    chrome.runtime.sendMessage({ type: 'LOAD_DATA',
      data: (await chrome.storage.session.get('pendingQrData')).pendingQrData ?? ''
    }).catch(() => {});
  } catch (err) {
    console.warn('[BG] Could not open popup programmatically:', err.message);
  }
}

/* ─────────────────────────────────────────────────────────────
   REVERSE SCANNER
   Uses an OffscreenCanvas (available in MV3 service workers)
   to draw the fetched image, then passes ImageData to jsQR.

   LIBRARY: jsQR(imageData.data, width, height, options)
     → returns { data: 'decoded string' } or null
   ───────────────────────────────────────────────────────────── */
async function reverseScanner(imageUrl, tab) {
  sendToastToTab(tab.id, '⏳ SCANNING QR…', false, 3000);

  try {
    /* ── Step 1: Fetch the image ── */
    const response = await fetch(imageUrl, { mode: 'cors' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();

    /* ── Step 2: Decode the image using ImageBitmap (worker-safe) ── */
    const blob   = new Blob([arrayBuffer]);
    const bitmap = await createImageBitmap(blob);

    /* ── Step 3: Draw to OffscreenCanvas ── */
    const { width, height } = bitmap;
    const canvas  = new OffscreenCanvas(width, height);
    const ctx     = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    /* ── Step 4: Extract raw pixel data ── */
    const imageData = ctx.getImageData(0, 0, width, height);

    /* ── Step 5: LIBRARY: jsQR decodes the pixel data ── */
    const result = jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: 'dontInvert',  // try normal orientation first
    });

    if (!result || !result.data) {
      /*
        Edge case: QR not found — show retro error toast.
        This could mean the image has no QR code, the code
        is damaged, or the orientation is unusual.
      */
      sendToastToTab(tab.id, '✖ NO QR CODE FOUND IN IMAGE', true);
      return;
    }

    /* ── Step 6: Copy decoded text to clipboard ── */
    const decoded = result.data;

    /*
      MESSAGING FLOW (Reverse Scanner success):
        background.js → scripting.executeScript → content.js toast
        We inject a tiny clipboard-write script into the active tab.
    */
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func:   writeClipboardText,
      args:   [decoded],
    });

    /* ── Step 7: Show success toast on the page ── */
    sendToastToTab(tab.id,
      `✔ QR DECODED: ${decoded.length > 30 ? decoded.slice(0,30)+'…' : decoded}`,
      false
    );

    /* Also show a Chrome notification for maximum visibility */
    chrome.notifications.create({
      type:    'basic',
      iconUrl: 'icons/icon48.png',
      title:   '8-Bit QR Maker — QR Decoded!',
      message: decoded.length > 100 ? decoded.slice(0,100)+'…' : decoded,
    });

  } catch (err) {
    console.error('[BG] Reverse scanner error:', err);

    /* Edge case: fetch failed (CORS, network, etc.) */
    if (err.name === 'TypeError' && err.message.includes('fetch')) {
      sendToastToTab(tab.id, '✖ CANNOT FETCH IMAGE (CORS BLOCKED)', true);
    } else {
      sendToastToTab(tab.id, '✖ SCAN FAILED — 8-BIT ERROR', true);
    }
  }
}

/**
 * Injected function that writes text to the page's clipboard.
 * Runs in the content script context (has clipboard permissions).
 * @param {string} text
 */
function writeClipboardText(text) {
  navigator.clipboard.writeText(text).catch(console.error);
}

/* ─────────────────────────────────────────────────────────────
   SEND TOAST TO TAB
   Sends a message to the content script (content.js) running
   on the tab, instructing it to display a pixel-art toast.

   MESSAGING FLOW:
     background.js → chrome.tabs.sendMessage
       → content.js listener → injects toast div into page DOM
   ───────────────────────────────────────────────────────────── */
function sendToastToTab(tabId, message, isError = false, duration = 2500) {
  chrome.tabs.sendMessage(tabId, {
    type:     'SHOW_TOAST',
    message,
    isError,
    duration,
  }).catch(err => {
    // Content script not loaded (e.g. chrome:// pages) — ignore silently
    console.warn('[BG] Could not send toast to tab', tabId, ':', err.message);
  });
}

/* ─────────────────────────────────────────────────────────────
   RUNTIME MESSAGE LISTENER
   Handles messages from popup.js or content scripts.
   ───────────────────────────────────────────────────────────── */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_PENDING_DATA') {
    chrome.storage.session.get(['pendingQrData'], result => {
      sendResponse({ data: result.pendingQrData || null });
      chrome.storage.session.remove('pendingQrData');
    });
    return true; // async response
  }
});

console.log('[BG] 8-Bit QR Maker service worker started.');
