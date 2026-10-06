/* =============================================================
   popup.js  —  8-BIT QR CODE MAKER  |  Main Controller
   Depends on: QRCodeStyling (loaded via libs/qr-code-styling.min.js)
   ============================================================= */

'use strict';

/* ─────────────────────────────────────────────────────────────
   CONSTANTS & STATE
   ───────────────────────────────────────────────────────────── */
const QR_SIZE      = 200;   // pixels — matches CSS .qr-canvas-inner size
const STORAGE_KEY  = 'qrMaker_presets_v2';
const HOVER_KEY    = 'qrMaker_hoverEnabled';

/** Current design state — the single source of truth.
    Every UI control reads/writes this object, then calls render(). */
const state = {
  type:          'url',          // 'url' | 'wifi' | 'vcard'
  data:          '',             // the encoded QR string
  ecl:           'M',           // error correction level
  dotStyle:      'square',       // qr-code-styling dot type
  cornerSqStyle: 'square',       // corner square type
  cornerDotStyle:'square',       // corner dot type
  dotColor:      '#000000',
  bgColor:       '#ffffff',
  cornerColor:   '#000000',
  invert:        false,
  logoDataUrl:   null,           // base64 logo or null
  logoRatio:     0.3,            // fraction of QR size occupied by logo
};

/* ─────────────────────────────────────────────────────────────
   QR CODE INSTANCE
   LIBRARY: QRCodeStyling — instantiated once, updated in-place.
   Using .update() avoids re-appending a new element each render.
   ───────────────────────────────────────────────────────────── */
let qrInstance = null;   // will be set in init()
let renderTimer = null;  // debounce handle for live preview

/* ─────────────────────────────────────────────────────────────
   DOM REFERENCES
   ───────────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);

const dom = {
  // Tabs
  tabBtns:      document.querySelectorAll('.px-tab'),
  panelUrl:     $('panel-url'),
  panelWifi:    $('panel-wifi'),
  panelVcard:   $('panel-vcard'),

  // URL panel
  inputUrl:     $('inputUrl'),

  // WiFi panel
  wifiSsid:     $('wifiSsid'),
  wifiPass:     $('wifiPass'),
  wifiEnc:      $('wifiEnc'),
  wifiHidden:   $('wifiHidden'),

  // vCard panel
  vcardFirst:   $('vcardFirst'),
  vcardLast:    $('vcardLast'),
  vcardPhone:   $('vcardPhone'),
  vcardEmail:   $('vcardEmail'),
  vcardOrg:     $('vcardOrg'),
  vcardUrl:     $('vcardUrl'),

  // QR canvas target
  qrCanvas:     $('qrCanvas'),

  // Action buttons
  btnPng:       $('btnDownloadPng'),
  btnSvg:       $('btnDownloadSvg'),
  btnCopy:      $('btnCopyImg'),
  btnData:      $('btnCopyData'),

  // Accordion
  advToggle:    $('advToggle'),
  advContent:   $('advContent'),
  accArrow:     $('accArrow'),

  // Error correction
  eclGroup:     $('eclGroup'),

  // Style selectors
  dotStyleGroup:  $('dotStyleGroup'),
  cornerSqGroup:  $('cornerSqGroup'),
  cornerDotGroup: $('cornerDotGroup'),

  // Colors
  colorDots:    $('colorDots'),
  colorBg:      $('colorBg'),
  colorCorner:  $('colorCorner'),
  swatchDots:   $('swatchDots'),
  swatchBg:     $('swatchBg'),
  swatchCorner: $('swatchCorner'),
  toggleInvert: $('toggleInvert'),
  invertState:  $('invertState'),

  // Quick palette
  quickPalette: $('quickPalette'),

  // Logo
  btnUploadLogo:  $('btnUploadLogo'),
  btnRemoveLogo:  $('btnRemoveLogo'),
  logoFileInput:  $('logoFileInput'),
  logoThumbWrap:  $('logoThumbWrap'),
  logoThumb:      $('logoThumb'),

  // Hover toggle
  toggleHover:  $('toggleHover'),
  hoverState:   $('hoverState'),

  // Presets
  btnSavePreset: $('btnSavePreset'),
  presetsGrid:   $('presetsGrid'),
  presetEmpty:   $('presetEmpty'),

  // Status / toast
  statusMsg:    $('statusMsg'),
  popupToast:   $('popupToast'),
  particleLayer:$('particleLayer'),
};

/* ─────────────────────────────────────────────────────────────
   DATA BUILDERS
   These functions encode the UI fields into the QR data string.
   ───────────────────────────────────────────────────────────── */

/**
 * Builds the WiFi QR string per the WIFI: URI format.
 * e.g.  WIFI:T:WPA;S:MyNet;P:secret;;
 */
function buildWifiString() {
  const ssid   = dom.wifiSsid.value.trim();
  const pass   = dom.wifiPass.value;
  const enc    = dom.wifiEnc.value;
  const hidden = dom.wifiHidden.checked ? 'true' : 'false';
  if (!ssid) return '';
  // Escape special chars in SSID/password
  const esc = s => s.replace(/([\\;,":"])/g, '\\$1');
  return `WIFI:T:${enc};S:${esc(ssid)};P:${esc(pass)};H:${hidden};;`;
}

/**
 * Builds a vCard 3.0 string from the form fields.
 */
function buildVCardString() {
  const first = dom.vcardFirst.value.trim();
  const last  = dom.vcardLast.value.trim();
  const phone = dom.vcardPhone.value.trim();
  const email = dom.vcardEmail.value.trim();
  const org   = dom.vcardOrg.value.trim();
  const url   = dom.vcardUrl.value.trim();
  if (!first && !last) return '';

  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `N:${last};${first};;;`,
    `FN:${first} ${last}`.trim(),
  ];
  if (org)   lines.push(`ORG:${org}`);
  if (phone) lines.push(`TEL;TYPE=CELL:${phone}`);
  if (email) lines.push(`EMAIL:${email}`);
  if (url)   lines.push(`URL:${url}`);
  lines.push('END:VCARD');
  return lines.join('\n');
}

/**
 * Returns the current QR data string based on active type.
 */
function getCurrentData() {
  switch (state.type) {
    case 'wifi':  return buildWifiString();
    case 'vcard': return buildVCardString();
    default:      return dom.inputUrl.value.trim() || 'https://example.com';
  }
}

/* ─────────────────────────────────────────────────────────────
   QR COLOUR HELPERS
   Handles the "Invert" toggle by swapping dot/bg colours.
   ───────────────────────────────────────────────────────────── */
function resolvedColors() {
  if (state.invert) {
    return { dot: state.bgColor, bg: state.dotColor, corner: state.bgColor };
  }
  return { dot: state.dotColor, bg: state.bgColor, corner: state.cornerColor };
}

/* ─────────────────────────────────────────────────────────────
   QR RENDER  (core function)
   LIBRARY: QRCodeStyling — .update() re-renders the existing
   instance in-place, avoiding DOM thrash.
   ───────────────────────────────────────────────────────────── */
function buildQRConfig() {
  const colors = resolvedColors();
  const data   = getCurrentData();

  /** @type {import('qr-code-styling').Options} */
  const cfg = {
    width:  QR_SIZE,
    height: QR_SIZE,
    type:   'canvas',          // renders to <canvas> for pixel sharpness
    data:   data || ' ',       // never empty — library throws on ''

    // ── Dot options ──────────────────────────────────────────
    dotsOptions: {
      type:  state.dotStyle,   // 'square' = pixel-perfect, others available
      color: colors.dot,
    },

    // ── Corner square options ────────────────────────────────
    cornersSquareOptions: {
      type:  state.cornerSqStyle,
      color: colors.corner,
    },

    // ── Corner dot options ───────────────────────────────────
    cornersDotOptions: {
      type:  state.cornerDotStyle,
      color: colors.corner,
    },

    // ── Background ───────────────────────────────────────────
    backgroundOptions: {
      color: colors.bg,
    },

    // ── Error correction ─────────────────────────────────────
    qrOptions: {
      errorCorrectionLevel: state.ecl,
    },

    // ── Logo / image in centre ───────────────────────────────
    // Only set if user has uploaded a logo.
    // imageOptions.margin provides a white background pad for
    // better scan reliability around the logo.
    ...(state.logoDataUrl ? {
      image: state.logoDataUrl,
      imageOptions: {
        crossOrigin:    'anonymous',
        margin:         4,                      // pixel padding around logo
        imageSize:      state.logoRatio,        // fraction of QR size (0–1)
        hideBackgroundDots: true,               // punch out dots under logo
      },
    } : {}),
  };

  return cfg;
}

/**
 * Debounced render — waits 80ms after last change before
 * re-rendering. This keeps typing responsive.
 */
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 80);
}

/**
 * Main render function. Creates or updates the QRCodeStyling instance.
 */
function render() {
  const cfg = buildQRConfig();
  state.data = cfg.data;

  if (!qrInstance) {
    // First render: create instance and append to DOM
    // LIBRARY: new QRCodeStyling(config) — creates the QR renderer
    qrInstance = new QRCodeStyling(cfg);
    qrInstance.append(dom.qrCanvas);
  } else {
    // Subsequent renders: just update the existing canvas
    // LIBRARY: .update(config) — mutates the existing render
    qrInstance.update(cfg);
  }

  setStatus(`QR READY — ${cfg.data.length} CHARS`);
}

/* ─────────────────────────────────────────────────────────────
   STATUS BAR
   ───────────────────────────────────────────────────────────── */
function setStatus(msg) {
  dom.statusMsg.textContent = msg;
}

/* ─────────────────────────────────────────────────────────────
   IN-POPUP TOAST
   Shows a snappy pixel-art notification inside the popup.
   ───────────────────────────────────────────────────────────── */
let toastTimer = null;

function showToast(msg, isError = false, durationMs = 2000) {
  const t = dom.popupToast;
  t.textContent = (isError ? '✖ ' : '✔ ') + msg;
  t.className   = 'popup-toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'popup-toast'; }, durationMs);
}

/* ─────────────────────────────────────────────────────────────
   8-BIT PARTICLE BURST
   Fires coloured squares from a button's position on click.
   ───────────────────────────────────────────────────────────── */
const PICO8_COLORS = ['#FF004D','#FFA300','#FFEC27','#00E436','#29ADFF','#FF77A8','#83769C','#FFF1E8'];

function spawnParticles(originEl) {
  const rect = originEl.getBoundingClientRect();
  const cx = rect.left + rect.width  / 2;
  const cy = rect.top  + rect.height / 2;
  const layer = dom.particleLayer;
  const count = 12;

  for (let i = 0; i < count; i++) {
    const p  = document.createElement('div');
    p.className = 'particle';
    const angle = (i / count) * Math.PI * 2;
    const dist  = 30 + Math.random() * 40;
    const tx    = Math.cos(angle) * dist;
    const ty    = Math.sin(angle) * dist;
    p.style.left   = `${cx - 2}px`;
    p.style.top    = `${cy - 2}px`;
    p.style.setProperty('--tx', `${tx}px`);
    p.style.setProperty('--ty', `${ty}px`);
    p.style.background = PICO8_COLORS[i % PICO8_COLORS.length];
    layer.appendChild(p);
    // Remove the element once animation ends
    p.addEventListener('animationend', () => p.remove());
  }
}

/* ─────────────────────────────────────────────────────────────
   TAB SWITCHING
   ───────────────────────────────────────────────────────────── */
function activateTab(type) {
  state.type = type;

  dom.tabBtns.forEach(btn => {
    const isActive = btn.dataset.type === type;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  });

  // Show/hide panels
  dom.panelUrl.classList.toggle('active', type === 'url');
  dom.panelWifi.classList.toggle('active', type === 'wifi');
  dom.panelVcard.classList.toggle('active', type === 'vcard');

  // hidden attr for a11y
  dom.panelUrl.hidden   = type !== 'url';
  dom.panelWifi.hidden  = type !== 'wifi';
  dom.panelVcard.hidden = type !== 'vcard';

  scheduleRender();
}

/* ─────────────────────────────────────────────────────────────
   ACCORDION (ADVANCED SETTINGS)
   ───────────────────────────────────────────────────────────── */
function toggleAccordion() {
  const open = dom.advToggle.getAttribute('aria-expanded') === 'true';
  dom.advToggle.setAttribute('aria-expanded', String(!open));
  dom.advContent.setAttribute('aria-hidden', String(open));
  dom.advContent.classList.toggle('open', !open);
  dom.accArrow.textContent = open ? '▶' : '▼';
  dom.accArrow.classList.toggle('open', !open);
}

/* ─────────────────────────────────────────────────────────────
   STYLE SELECTOR HELPERS
   Highlight the active button in a group and update state.
   ───────────────────────────────────────────────────────────── */
function activateStyleBtn(group, btn, stateKey) {
  group.querySelectorAll('.px-style').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  scheduleRender();
}

function activateEclBtn(btn) {
  dom.eclGroup.querySelectorAll('.px-ecl').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.ecl = btn.dataset.ecl;
  const hints = { L:'LOW (7% recovery)', M:'MEDIUM (15% recovery)', Q:'QUARTILE (25% recovery)', H:'HIGH (30% recovery)' };
  scheduleRender();
}

/* ─────────────────────────────────────────────────────────────
   COLOUR HANDLING
   ───────────────────────────────────────────────────────────── */
function syncSwatchColor(swatchEl, hexColor) {
  swatchEl.style.background = hexColor;
}

function applyPalette(dotsHex, bgHex, cornerHex) {
  state.dotColor    = dotsHex;
  state.bgColor     = bgHex;
  state.cornerColor = cornerHex;

  // Sync native pickers
  dom.colorDots.value   = dotsHex;
  dom.colorBg.value     = bgHex;
  dom.colorCorner.value = cornerHex;

  // Sync visible swatches
  syncSwatchColor(dom.swatchDots,   dotsHex);
  syncSwatchColor(dom.swatchBg,     bgHex);
  syncSwatchColor(dom.swatchCorner, cornerHex);

  scheduleRender();
}

/* ─────────────────────────────────────────────────────────────
   LOGO UPLOAD
   Reads the file, converts to data URL, stores in state.
   The qr-code-styling library accepts a data-URL for its
   `image` option, placing it at the centre with padding.
   ───────────────────────────────────────────────────────────── */
function handleLogoUpload(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    state.logoDataUrl = e.target.result;
    dom.logoThumb.src       = state.logoDataUrl;
    dom.logoThumbWrap.style.display = 'flex';
    dom.btnRemoveLogo.style.display = 'inline-flex';
    setStatus('LOGO LOADED');
    scheduleRender();
  };
  reader.readAsDataURL(file);
}

function removeLogo() {
  state.logoDataUrl = null;
  dom.logoThumb.src             = '';
  dom.logoThumbWrap.style.display = 'none';
  dom.btnRemoveLogo.style.display = 'none';
  scheduleRender();
}

/* ─────────────────────────────────────────────────────────────
   DOWNLOAD HANDLERS
   LIBRARY: qr-code-styling provides .download({ name, extension })
   which triggers a browser download of the generated QR code.
   PNG: uses canvas — pixel-perfect, integer scaling.
   SVG: produces a clean vector for print use.
   ───────────────────────────────────────────────────────────── */
async function downloadPng() {
  if (!qrInstance) return;
  // LIBRARY: .download() — triggers save dialog
  await qrInstance.download({ name: 'qr-code-8bit', extension: 'png' });
  spawnParticles(dom.btnPng);
  showToast('PNG DOWNLOADED!');
}

async function downloadSvg() {
  if (!qrInstance) return;
  // Force SVG type for this export only
  const svgInstance = new QRCodeStyling({ ...buildQRConfig(), type: 'svg' });
  await svgInstance.download({ name: 'qr-code-8bit', extension: 'svg' });
  spawnParticles(dom.btnSvg);
  showToast('SVG DOWNLOADED!');
}

/* ─────────────────────────────────────────────────────────────
   COPY QR TO CLIPBOARD
   Gets the canvas element rendered by qr-code-styling,
   converts it to a Blob, and writes it to the clipboard API.
   ───────────────────────────────────────────────────────────── */
async function copyQrToClipboard() {
  if (!qrInstance) return;
  try {
    // LIBRARY: .getRawData('png') — returns a Promise<Blob>
    const blob = await qrInstance.getRawData('png');
    if (!blob) throw new Error('No blob');
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': blob }),
    ]);
    spawnParticles(dom.btnCopy);
    showToast('QR COPIED TO CLIPBOARD!');
  } catch (err) {
    console.error('[QR Maker] Copy failed:', err);
    showToast('COPY FAILED — CHECK PERMISSIONS', true);
  }
}

/** Copies the raw data string (URL/WiFi/vCard) to clipboard */
async function copyDataString() {
  const data = getCurrentData();
  try {
    await navigator.clipboard.writeText(data);
    spawnParticles(dom.btnData);
    showToast('DATA STRING COPIED!');
  } catch {
    showToast('COPY FAILED', true);
  }
}

/* ─────────────────────────────────────────────────────────────
   PRESETS — Save / Load / Delete
   Stored in chrome.storage.local as an array of preset objects.
   Each preset contains: name, config snapshot, thumbnail dataURL.
   ───────────────────────────────────────────────────────────── */

/**
 * Captures a 52x52 thumbnail of the current QR code for the preset grid.
 * LIBRARY: .getRawData('png') → Blob → createObjectURL → draw to canvas
 */
async function capturePresetThumbnail() {
  if (!qrInstance) return null;
  try {
    const blob = await qrInstance.getRawData('png');
    const url  = URL.createObjectURL(blob);
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const c  = document.createElement('canvas');
        c.width  = 52; c.height = 52;
        const ctx = c.getContext('2d');
        // Use nearest-neighbour scaling to keep pixel art crisp
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0, 52, 52);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  } catch { return null; }
}

async function loadPresets() {
  return new Promise(resolve => {
    chrome.storage.local.get([STORAGE_KEY], result => {
      resolve(result[STORAGE_KEY] || []);
    });
  });
}

async function savePresets(presets) {
  return new Promise(resolve => {
    chrome.storage.local.set({ [STORAGE_KEY]: presets }, resolve);
  });
}

async function saveCurrentAsPreset() {
  const name = prompt('NAME THIS PRESET:', 'PRESET ' + Date.now().toString(36).toUpperCase());
  if (!name) return;

  const thumb = await capturePresetThumbnail();
  const preset = {
    id:             Date.now(),
    name:           name.trim().slice(0, 20).toUpperCase(),
    thumb,
    // Store the full design state snapshot
    dotStyle:       state.dotStyle,
    cornerSqStyle:  state.cornerSqStyle,
    cornerDotStyle: state.cornerDotStyle,
    dotColor:       state.dotColor,
    bgColor:        state.bgColor,
    cornerColor:    state.cornerColor,
    ecl:            state.ecl,
    invert:         state.invert,
    logoDataUrl:    state.logoDataUrl,
  };

  const presets = await loadPresets();
  presets.push(preset);
  await savePresets(presets);
  renderPresetGrid(presets);
  spawnParticles(dom.btnSavePreset);
  showToast('PRESET SAVED: ' + preset.name);
}

/**
 * Applies a saved preset to the current state and re-renders.
 */
function applyPreset(preset) {
  state.dotStyle       = preset.dotStyle       ?? 'square';
  state.cornerSqStyle  = preset.cornerSqStyle  ?? 'square';
  state.cornerDotStyle = preset.cornerDotStyle ?? 'square';
  state.dotColor       = preset.dotColor       ?? '#000000';
  state.bgColor        = preset.bgColor        ?? '#ffffff';
  state.cornerColor    = preset.cornerColor    ?? '#000000';
  state.ecl            = preset.ecl            ?? 'M';
  state.invert         = preset.invert         ?? false;
  state.logoDataUrl    = preset.logoDataUrl     ?? null;

  // Sync all UI controls to the restored state
  syncUIToState();
  scheduleRender();
  showToast('PRESET LOADED: ' + preset.name);
}

/**
 * Updates every UI widget to match the current `state` object.
 * Called after loading a preset or receiving data from background.
 */
function syncUIToState() {
  // ECL buttons
  dom.eclGroup.querySelectorAll('.px-ecl').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.ecl === state.ecl);
  });

  // Dot style buttons
  dom.dotStyleGroup.querySelectorAll('.px-style').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.dot === state.dotStyle);
  });

  // Corner square buttons
  dom.cornerSqGroup.querySelectorAll('.px-style').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.csq === state.cornerSqStyle);
  });

  // Corner dot buttons
  dom.cornerDotGroup.querySelectorAll('.px-style').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.cdot === state.cornerDotStyle);
  });

  // Colours
  dom.colorDots.value   = state.dotColor;
  dom.colorBg.value     = state.bgColor;
  dom.colorCorner.value = state.cornerColor;
  syncSwatchColor(dom.swatchDots,   state.dotColor);
  syncSwatchColor(dom.swatchBg,     state.bgColor);
  syncSwatchColor(dom.swatchCorner, state.cornerColor);

  // Invert toggle
  dom.toggleInvert.checked = state.invert;
  dom.invertState.textContent = state.invert ? 'ON' : 'OFF';

  // Logo
  if (state.logoDataUrl) {
    dom.logoThumb.src = state.logoDataUrl;
    dom.logoThumbWrap.style.display = 'flex';
    dom.btnRemoveLogo.style.display = 'inline-flex';
  } else {
    dom.logoThumbWrap.style.display = 'none';
    dom.btnRemoveLogo.style.display = 'none';
  }
}

/**
 * Renders the preset grid in the DOM.
 */
function renderPresetGrid(presets) {
  // Keep the "empty" placeholder but hide it when presets exist
  dom.presetEmpty.style.display = presets.length ? 'none' : 'block';

  // Remove existing preset cards (but not the empty placeholder)
  dom.presetsGrid.querySelectorAll('.preset-card').forEach(el => el.remove());

  presets.forEach(preset => {
    const card = document.createElement('div');
    card.className = 'preset-card';
    card.title = preset.name;

    if (preset.thumb) {
      const img = document.createElement('img');
      img.className = 'preset-thumb';
      img.src = preset.thumb;
      img.alt = preset.name;
      card.appendChild(img);
    }

    const nameEl = document.createElement('div');
    nameEl.className = 'preset-name';
    nameEl.textContent = preset.name;
    card.appendChild(nameEl);

    // Delete button (shown on hover by CSS)
    const delBtn = document.createElement('button');
    delBtn.className = 'preset-del';
    delBtn.textContent = '✕';
    delBtn.title = 'Delete preset';
    delBtn.addEventListener('click', async e => {
      e.stopPropagation();
      const all = await loadPresets();
      const filtered = all.filter(p => p.id !== preset.id);
      await savePresets(filtered);
      renderPresetGrid(filtered);
      showToast('PRESET DELETED');
    });
    card.appendChild(delBtn);

    card.addEventListener('click', () => applyPreset(preset));
    dom.presetsGrid.appendChild(card);
  });
}

/* ─────────────────────────────────────────────────────────────
   HOVER ENGINE TOGGLE
   State is stored in chrome.storage.sync so it persists across
   devices and is accessible to the hover_engine.js content script.
   ───────────────────────────────────────────────────────────── */
function setHoverState(enabled) {
  dom.toggleHover.checked = enabled;
  dom.hoverState.textContent = enabled ? 'ON' : 'OFF';
  // Persist to sync storage for hover_engine.js to read
  chrome.storage.sync.set({ [HOVER_KEY]: enabled });
  // Notify all tabs' hover_engine that the state changed
  chrome.tabs.query({}, tabs => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, {
        type: 'HOVER_TOGGLE',
        enabled,
      }).catch(() => {}); // ignore tabs with no content script
    });
  });
}

/* ─────────────────────────────────────────────────────────────
   AUTO-CAPTURE  —  Runs on popup open
   Queries the active tab URL and pre-fills the URL input.
   MESSAGING: chrome.tabs.query → get current URL → set input → render
   ───────────────────────────────────────────────────────────── */
async function autoCapture() {
  setStatus('SCANNING TAB…');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
      dom.inputUrl.value = tab.url;
      setStatus(`CAPTURED: ${tab.url.length > 40 ? tab.url.slice(0,40)+'…' : tab.url}`);
    } else {
      dom.inputUrl.value = '';
      setStatus('ENTER URL OR TEXT ABOVE');
    }
  } catch (err) {
    console.warn('[QR Maker] autoCapture failed:', err);
    setStatus('READY — ENTER DATA');
  }
  scheduleRender();
}

/* ─────────────────────────────────────────────────────────────
   MESSAGE LISTENER
   Receives data from background.js (context menu selections).
   MESSAGING FLOW:
     background.js → chrome.runtime.sendMessage → popup.js listener
     The background sets pendingData in storage, then opens the popup.
     On open, popup reads pending data and pre-fills.
   ───────────────────────────────────────────────────────────── */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'LOAD_DATA') {
    // Pre-fill URL/text field with data from context menu
    dom.inputUrl.value = msg.data;
    activateTab('url');
    scheduleRender();
    sendResponse({ ok: true });
  }
  return true; // keep channel open for async
});

/* ─────────────────────────────────────────────────────────────
   EVENT WIRING
   ───────────────────────────────────────────────────────────── */
function wireEvents() {
  // ── Tab buttons ─────────────────────────────────────────
  dom.tabBtns.forEach(btn => {
    btn.addEventListener('click', () => activateTab(btn.dataset.type));
  });

  // ── URL / text input (live) ──────────────────────────────
  dom.inputUrl.addEventListener('input', scheduleRender);

  // ── WiFi inputs (live) ──────────────────────────────────
  [dom.wifiSsid, dom.wifiPass, dom.wifiEnc, dom.wifiHidden].forEach(el => {
    el.addEventListener('change', scheduleRender);
    if (el.tagName !== 'SELECT') el.addEventListener('input', scheduleRender);
  });

  // ── vCard inputs (live) ─────────────────────────────────
  [dom.vcardFirst, dom.vcardLast, dom.vcardPhone,
   dom.vcardEmail, dom.vcardOrg, dom.vcardUrl].forEach(el => {
    el.addEventListener('input', scheduleRender);
  });

  // ── Accordion toggle ────────────────────────────────────
  dom.advToggle.addEventListener('click', toggleAccordion);

  // ── ECL buttons ─────────────────────────────────────────
  dom.eclGroup.querySelectorAll('.px-ecl').forEach(btn => {
    btn.addEventListener('click', () => activateEclBtn(btn));
  });

  // ── Dot style buttons ────────────────────────────────────
  dom.dotStyleGroup.querySelectorAll('.px-style').forEach(btn => {
    btn.addEventListener('click', () => {
      state.dotStyle = btn.dataset.dot;
      activateStyleBtn(dom.dotStyleGroup, btn, 'dotStyle');
    });
  });

  // ── Corner square style buttons ──────────────────────────
  dom.cornerSqGroup.querySelectorAll('.px-style').forEach(btn => {
    btn.addEventListener('click', () => {
      state.cornerSqStyle = btn.dataset.csq;
      activateStyleBtn(dom.cornerSqGroup, btn, 'cornerSqStyle');
    });
  });

  // ── Corner dot style buttons ─────────────────────────────
  dom.cornerDotGroup.querySelectorAll('.px-style').forEach(btn => {
    btn.addEventListener('click', () => {
      state.cornerDotStyle = btn.dataset.cdot;
      activateStyleBtn(dom.cornerDotGroup, btn, 'cornerDotStyle');
    });
  });

  // ── Colour pickers (live preview on input) ───────────────
  dom.colorDots.addEventListener('input', e => {
    state.dotColor = e.target.value;
    syncSwatchColor(dom.swatchDots, state.dotColor);
    scheduleRender();
  });
  dom.colorBg.addEventListener('input', e => {
    state.bgColor = e.target.value;
    syncSwatchColor(dom.swatchBg, state.bgColor);
    scheduleRender();
  });
  dom.colorCorner.addEventListener('input', e => {
    state.cornerColor = e.target.value;
    syncSwatchColor(dom.swatchCorner, state.cornerColor);
    scheduleRender();
  });

  // ── Quick palette swatches ───────────────────────────────
  dom.quickPalette.querySelectorAll('.qp-swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      applyPalette(btn.dataset.dots, btn.dataset.bg, btn.dataset.corner);
    });
  });

  // ── Invert toggle ────────────────────────────────────────
  dom.toggleInvert.addEventListener('change', () => {
    state.invert = dom.toggleInvert.checked;
    dom.invertState.textContent = state.invert ? 'ON' : 'OFF';
    scheduleRender();
  });

  // ── Logo upload ──────────────────────────────────────────
  dom.btnUploadLogo.addEventListener('click', () => dom.logoFileInput.click());
  dom.logoFileInput.addEventListener('change', e => handleLogoUpload(e.target.files[0]));
  dom.btnRemoveLogo.addEventListener('click', removeLogo);

  // ── Hover engine toggle ──────────────────────────────────
  dom.toggleHover.addEventListener('change', () => {
    setHoverState(dom.toggleHover.checked);
    dom.hoverState.textContent = dom.toggleHover.checked ? 'ON' : 'OFF';
  });

  // ── Download / copy buttons ──────────────────────────────
  dom.btnPng.addEventListener('click',  downloadPng);
  dom.btnSvg.addEventListener('click',  downloadSvg);
  dom.btnCopy.addEventListener('click', copyQrToClipboard);
  dom.btnData.addEventListener('click', copyDataString);

  // ── Preset save ──────────────────────────────────────────
  dom.btnSavePreset.addEventListener('click', saveCurrentAsPreset);
}

/* ─────────────────────────────────────────────────────────────
   CHECK FOR PENDING DATA
   Background sets a pending message in session storage when
   the user uses a context menu action; we pick it up here.
   ───────────────────────────────────────────────────────────── */
async function checkPendingData() {
  return new Promise(resolve => {
    chrome.storage.session.get(['pendingQrData'], result => {
      if (result.pendingQrData) {
        dom.inputUrl.value = result.pendingQrData;
        activateTab('url');
        // Clear the pending flag
        chrome.storage.session.remove('pendingQrData');
        resolve(true);
      } else {
        resolve(false);
      }
    });
  });
}

/* ─────────────────────────────────────────────────────────────
   INIT
   ───────────────────────────────────────────────────────────── */
async function init() {
  wireEvents();

  // Load hover engine state from sync storage
  chrome.storage.sync.get([HOVER_KEY], result => {
    const enabled = result[HOVER_KEY] ?? false;
    dom.toggleHover.checked    = enabled;
    dom.hoverState.textContent = enabled ? 'ON' : 'OFF';
  });

  // Load saved presets from local storage
  const presets = await loadPresets();
  renderPresetGrid(presets);

  // Check if background.js sent us pre-loaded data (context menu)
  const hadPending = await checkPendingData();

  if (!hadPending) {
    // Auto-capture current tab URL
    await autoCapture();
  } else {
    scheduleRender();
  }
}

// Kick off once DOM is ready (it will be — scripts load at end of body)
init().catch(console.error);
