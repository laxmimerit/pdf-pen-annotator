import {
  getDocument,
  GlobalWorkerOptions,
  AnnotationEditorType,
  AnnotationEditorParamsType,
} from "./pdf.mjs";
import {
  EventBus,
  PDFViewer,
  PDFFindController,
  PDFLinkService,
  GenericL10n,
} from "./pdf_viewer.mjs";

const WORKER_URL = new URL("./pdf.worker.mjs", import.meta.url).toString();
const CMAP_URL = new URL("./cmaps/", import.meta.url).toString();
const STANDARD_FONT_DATA_URL = new URL(
  "./standard_fonts/",
  import.meta.url
).toString();

const vscode = acquireVsCodeApi();

const $ = (sel) => document.querySelector(sel);

function report(message) {
  vscode.postMessage({ type: "error", message: String(message) });
  const banner = $("#error");
  const errorText = $("#errorText");
  if (banner) {
    if (errorText) {
      errorText.textContent = String(message);
    } else {
      banner.textContent = String(message);
    }
    banner.classList.remove("hidden");
  }
}

const errorDismiss = $("#errorDismiss");
if (errorDismiss) {
  errorDismiss.addEventListener("click", () => {
    const banner = $("#error");
    if (banner) banner.classList.add("hidden");
  });
}

window.addEventListener("error", (e) => report(e.message));
window.addEventListener("unhandledrejection", (e) =>
  report(e.reason?.message ?? e.reason)
);

// Some tablet drivers (XP-Pen, Wacom, …) report a non-zero button for the
// pen tip; PDF.js only starts a stroke for button 0, so normalize it.
window.addEventListener(
  "pointerdown",
  (e) => {
    if (
      (e.pointerType === "pen" || e.pointerType === "touch") &&
      e.button !== 0 &&
      (e.buttons === 1 || e.buttons === 0)
    ) {
      try {
        Object.defineProperty(e, "button", { value: 0 });
      } catch {}
    }
  },
  { capture: true }
);

const viewerContainerEl = $("#viewerContainer");
const viewerWrapperEl = $("#viewerWrapper");

// Sidebar controls
const sidebarToggle = $("#sidebarToggle");
const sidebar = $("#sidebar");
const sidebarOutlineBtn = $("#sidebarOutlineBtn");
const sidebarThumbnailBtn = $("#sidebarThumbnailBtn");
const outlineView = $("#outlineView");
const thumbnailView = $("#thumbnailView");

// Toolbar controls
const btnPrev = $("#btnPrev");
const btnNext = $("#btnNext");
const pageNumberInput = $("#pageNumber");
const numPagesSpan = $("#numPages");

const zoomInBtn = $("#zoomIn");
const zoomOutBtn = $("#zoomOut");
const scaleSelect = $("#scaleSelect");

const toolButtons = {
  none: $("#toolNone"),
  pen: $("#toolPen"),
  highlighter: $("#toolHighlighter"),
  eraser: $("#toolEraser"),
  laser: $("#toolLaser"),
};

const btnUndo = $("#btnUndo");
const btnRedo = $("#btnRedo");
const btnClearPage = $("#btnClearPage");
const btnClearAll = $("#btnClearAll");

// Find controls
const btnFind = $("#btnFind");
const findBar = $("#findBar");
const findInput = $("#findInput");
const findPrev = $("#findPrev");
const findNext = $("#findNext");
const findMatchCount = $("#findMatchCount");

const drawCursorEl = $("#drawCursor");

const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus });
const findController = new PDFFindController({ linkService, eventBus });
const l10n = new GenericL10n("en-US");

const pdfViewer = new PDFViewer({
  container: viewerContainerEl,
  viewer: $("#viewer"),
  eventBus,
  linkService,
  findController,
  l10n,
  annotationMode: 2, // ENABLE_FORMS
  annotationEditorMode: AnnotationEditorType.NONE,
  // Must be "name=color" pairs. A plain color list makes PDF.js throw while
  // the FIRST editor layer initializes, permanently breaking drawing on the
  // first rendered page.
  annotationEditorHighlightColors:
    "yellow=#FFFF98,green=#53FFBC,pink=#FF7EEE,blue=#80EBFF,red=#FFBE0B",
  textLayerMode: 1, // ENABLE
  removePageBorders: true,
});

linkService.setViewer(pdfViewer);

let currentPdfDocument = null;
let currentWorker = null;
let uiManager = null;
let dirtyNotified = false;
let editorReady = false;
let pendingTool = "none";
let toolRequest = 0;

// Debug handle (used by the dev harness tests)
window.__pdfAnnotator = {
  pdfViewer,
  eventBus,
  get uiManager() {
    return uiManager;
  },
  get state() {
    return { editorReady, pendingTool, mode: pdfViewer.annotationEditorMode };
  },
  get laser() {
    return {
      strokes: laserStrokes.length,
      active: !!laserActiveStroke,
      looping: !!laserRafId,
      config: LASER,
    };
  },
};

// Per-tool settings
const tools = {
  pen: { color: "#e03131", size: 2 },
  // Translucent: a (near-)opaque band camouflages text whose colour is
  // close to the ink (e.g. yellow headings under a yellow highlight).
  // Overlap uniformity comes from session merging, not opacity — see the
  // idle-split pointerup handler.
  highlighter: { color: "#ffd43b", size: 14, opacity: 0.5, blend: "auto" },
  eraser: { size: 24, mode: "stroke" },
};

// Web worker initialization
async function createWorkerPort() {
  const source = await (await fetch(WORKER_URL)).text();
  const blobUrl = URL.createObjectURL(
    new Blob([source], { type: "text/javascript" })
  );
  const worker = new Worker(blobUrl, { type: "module" });
  URL.revokeObjectURL(blobUrl);
  return worker;
}

async function loadPdf(bytes) {
  if (currentPdfDocument) {
    try {
      await currentPdfDocument.destroy();
    } catch {}
  }
  currentWorker?.terminate();
  dirtyNotified = false;
  editorReady = false;
  uiManager = null;

  currentWorker = await createWorkerPort();
  GlobalWorkerOptions.workerPort = currentWorker;

  const loadingTask = getDocument({
    data: bytes,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  });

  const pdfDocument = await loadingTask.promise;
  currentPdfDocument = pdfDocument;
  linkService.setDocument(pdfDocument);
  pdfViewer.setDocument(pdfDocument);
  // Scale is set once in the "pagesinit" handler. Setting it here as well
  // makes page 1 render twice, and the second render's editor layer gets
  // deregistered by the first one's deferred teardown (the UI manager keys
  // layers by page index), which broke drawing on page 1.

  buildSidebar();
}

eventBus.on("annotationeditoruimanager", ({ uiManager: manager }) => {
  uiManager = manager;
  editorReady = true;
  setTool(pendingTool);
});

eventBus.on("pagesinit", () => {
  pdfViewer.currentScaleValue = "page-width";
  numPagesSpan.textContent = pdfViewer.pagesCount;
  pageNumberInput.max = pdfViewer.pagesCount;
  pageNumberInput.value = pdfViewer.currentPageNumber;
});

eventBus.on("pagechanging", (evt) => {
  pageNumberInput.value = evt.pageNumber;
  document.querySelectorAll(".thumbnail-item").forEach((item) => {
    item.classList.toggle(
      "active",
      parseInt(item.dataset.pageNumber, 10) === evt.pageNumber
    );
  });
});

// --- Sidebar (Chapters / Thumbnails) ---------------------------------

sidebarToggle.addEventListener("click", () => {
  sidebar.classList.toggle("hidden");
});

function switchSidebarTab(tab) {
  if (tab === "outline") {
    sidebarOutlineBtn.classList.add("active");
    sidebarThumbnailBtn.classList.remove("active");
    outlineView.classList.remove("hidden");
    thumbnailView.classList.add("hidden");
  } else {
    sidebarThumbnailBtn.classList.add("active");
    sidebarOutlineBtn.classList.remove("active");
    thumbnailView.classList.remove("hidden");
    outlineView.classList.add("hidden");
  }
}

sidebarOutlineBtn.addEventListener("click", () => switchSidebarTab("outline"));
sidebarThumbnailBtn.addEventListener("click", () =>
  switchSidebarTab("thumbnail")
);

async function buildSidebar() {
  outlineView.innerHTML = "";
  thumbnailView.innerHTML = "";

  let outline = null;
  try {
    outline = await currentPdfDocument.getOutline();
  } catch {}

  if (outline && outline.length > 0) {
    const ul = renderOutlineList(outline);
    outlineView.appendChild(ul);
    switchSidebarTab("outline");
  } else {
    outlineView.innerHTML =
      '<div class="sidebar-empty">No chapters in document</div>';
    switchSidebarTab("thumbnail");
  }

  buildThumbnails(thumbnailView);
}

function renderOutlineList(items) {
  const ul = document.createElement("ul");
  ul.className = "outline-list";
  for (const item of items) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.textContent = item.title;
    a.className = "outline-item";
    a.href = "#";
    a.addEventListener("click", (e) => {
      e.preventDefault();
      // linkService resolves every destination form (named destinations,
      // explicit arrays, zoom specs) — the previous hand-rolled logic broke
      // on named destinations.
      if (item.dest) {
        linkService.goToDestination(item.dest).catch(() => {});
      }
    });
    li.appendChild(a);
    if (item.items && item.items.length > 0) {
      li.appendChild(renderOutlineList(item.items));
    }
    ul.appendChild(li);
  }
  return ul;
}

async function buildThumbnails(container) {
  if (!currentPdfDocument) return;
  const numPages = currentPdfDocument.numPages;
  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const itemDiv = document.createElement("div");
    itemDiv.className = "thumbnail-item";
    if (pageNum === pdfViewer.currentPageNumber) {
      itemDiv.classList.add("active");
    }
    itemDiv.dataset.pageNumber = pageNum;

    const canvas = document.createElement("canvas");
    canvas.className = "thumbnail-canvas";

    const label = document.createElement("span");
    label.className = "thumbnail-label";
    label.textContent = `Page ${pageNum}`;

    itemDiv.appendChild(canvas);
    itemDiv.appendChild(label);
    container.appendChild(itemDiv);

    const currentPage = pageNum;
    itemDiv.addEventListener("click", () => {
      pdfViewer.currentPageNumber = currentPage;
    });

    (async () => {
      try {
        const page = await currentPdfDocument.getPage(currentPage);
        const viewport = page.getViewport({ scale: 0.18 });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d");
        await page.render({ canvasContext: ctx, viewport }).promise;
      } catch {}
    })();
  }
}

// --- Page Navigation ------------------------------------------------

btnPrev.addEventListener("click", () => {
  if (pdfViewer.currentPageNumber > 1) {
    pdfViewer.currentPageNumber--;
  }
});

btnNext.addEventListener("click", () => {
  if (pdfViewer.currentPageNumber < pdfViewer.pagesCount) {
    pdfViewer.currentPageNumber++;
  }
});

pageNumberInput.addEventListener("change", () => {
  const page = parseInt(pageNumberInput.value, 10);
  if (page >= 1 && page <= pdfViewer.pagesCount) {
    pdfViewer.currentPageNumber = page;
  } else {
    pageNumberInput.value = pdfViewer.currentPageNumber;
  }
});

// --- Zoom Controls ---------------------------------------------------

zoomInBtn.addEventListener("click", () => {
  if (!currentPdfDocument) return;
  pdfViewer.currentScale = Math.min(pdfViewer.currentScale + 0.1, 5.0);
});

zoomOutBtn.addEventListener("click", () => {
  if (!currentPdfDocument) return;
  pdfViewer.currentScale = Math.max(pdfViewer.currentScale - 0.1, 0.1);
});

scaleSelect.addEventListener("change", () => {
  if (!currentPdfDocument) return;
  const val = scaleSelect.value;
  if (val === "auto" || val === "page-width") {
    // Automatic Zoom = fill the available width.
    pdfViewer.currentScaleValue = "page-width";
  } else if (["page-actual", "page-fit"].includes(val)) {
    pdfViewer.currentScaleValue = val;
  } else {
    pdfViewer.currentScale = parseFloat(val);
  }
});

eventBus.on("scalechanging", (evt) => {
  const preset = evt.presetValue;
  if (preset) {
    scaleSelect.value = preset === "page-width" ? "auto" : preset;
  } else {
    const scaleStr = evt.scale.toFixed(2);
    const percentStr = `${Math.round(evt.scale * 100)}%`;
    let matched = false;
    for (const opt of scaleSelect.options) {
      if (opt.value === scaleStr || opt.text === percentStr) {
        scaleSelect.value = opt.value;
        matched = true;
        break;
      }
    }
    if (!matched) {
      scaleSelect.value = "auto";
    }
  }
  eraserCache.clear();
  updateDrawCursorStyle();
});

// --- Popovers (pen / highlighter / eraser settings) -------------------

const popovers = [];

function registerPopover(toggleEl, panelEl) {
  if (!toggleEl || !panelEl) return null;
  const entry = { toggleEl, panelEl };
  popovers.push(entry);
  toggleEl.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = panelEl.classList.contains("hidden");
    closeAllPopovers();
    if (willOpen) setPopover(entry, true);
  });
  return entry;
}

function setPopover(entry, open) {
  entry.panelEl.classList.toggle("hidden", !open);
  entry.toggleEl.setAttribute("aria-expanded", String(open));
}

function closeAllPopovers() {
  for (const p of popovers) setPopover(p, false);
}

document.addEventListener("click", (e) => {
  for (const p of popovers) {
    if (p.panelEl.contains(e.target) || p.toggleEl.contains(e.target)) return;
  }
  closeAllPopovers();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeAllPopovers();
});

// Pen settings
const penToggle = $("#penToggle");
const penParams = $("#penParams");
const penSwatch = $("#penSwatch");
const penColor = $("#penColor");
const penSize = $("#penSize");
const penSizeVal = $("#penSizeVal");
const penSizeReadout = $("#penSizeReadout");
registerPopover(penToggle, penParams);

// Highlighter settings
const hlToggle = $("#hlToggle");
const hlParams = $("#hlParams");
const hlSwatch = $("#hlSwatch");
const hlColor = $("#hlColor");
const hlSize = $("#hlSize");
const hlSizeVal = $("#hlSizeVal");
const hlSizeReadout = $("#hlSizeReadout");
registerPopover(hlToggle, hlParams);

// Eraser settings
const eraserToggle = $("#eraserToggle");
const eraserParams = $("#eraserParams");
const eraserModeLabel = $("#eraserModeLabel");
const eraserModes = $("#eraserModes");
const eraserSize = $("#eraserSize");
const eraserSizeVal = $("#eraserSizeVal");
const eraserSizeReadout = $("#eraserSizeReadout");
registerPopover(eraserToggle, eraserParams);

// Laser settings
const laserToggle = $("#laserToggle");
const laserParamsPanel = $("#laserParams");
const laserWidthInput = $("#laserWidth");
const laserWidthReadout = $("#laserWidthReadout");
const laserFadeInput = $("#laserFade");
const laserFadeReadout = $("#laserFadeReadout");
const laserVal = $("#laserVal");
registerPopover(laserToggle, laserParamsPanel);

function updateLaserLabels() {
  const w = LASER.width;
  const s = LASER.holdMs / 1000;
  if (laserWidthReadout) laserWidthReadout.textContent = `${w} px`;
  if (laserFadeReadout) laserFadeReadout.textContent = `${s} s`;
  if (laserVal) laserVal.textContent = `${w} px · ${s} s`;
}

function wireSwatchRow(rowEl, colorInput, swatchEl, onChange) {
  if (!rowEl) return;
  rowEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".swatch");
    if (!btn) return;
    for (const s of rowEl.querySelectorAll(".swatch")) {
      s.classList.remove("selected");
    }
    btn.classList.add("selected");
    colorInput.value = btn.dataset.color;
    if (swatchEl) swatchEl.style.background = btn.dataset.color;
    onChange(btn.dataset.color);
  });
}

wireSwatchRow($("#penSwatches"), penColor, penSwatch, (color) => {
  tools.pen.color = color;
  applyToolParams();
});

wireSwatchRow($("#hlSwatches"), hlColor, hlSwatch, (color) => {
  tools.highlighter.color = color;
  applyToolParams();
});

penSize.addEventListener("input", () => {
  tools.pen.size = Number(penSize.value);
  const label = `${penSize.value} px`;
  if (penSizeVal) penSizeVal.textContent = label;
  if (penSizeReadout) penSizeReadout.textContent = label;
  applyToolParams();
});

hlSize.addEventListener("input", () => {
  tools.highlighter.size = Number(hlSize.value);
  const label = `${hlSize.value} px`;
  if (hlSizeVal) hlSizeVal.textContent = label;
  if (hlSizeReadout) hlSizeReadout.textContent = label;
  applyToolParams();
});

eraserSize.addEventListener("input", () => {
  tools.eraser.size = Number(eraserSize.value);
  const label = `${eraserSize.value} px`;
  if (eraserSizeVal) eraserSizeVal.textContent = label;
  if (eraserSizeReadout) eraserSizeReadout.textContent = label;
  updateDrawCursorStyle();
});

// --- Background-aware highlighter blending ----------------------------
// The highlighter always runs in one adaptive "behind text" mode: each
// highlight SVG samples the rendered page pixels under its ink and picks
// darken on light backgrounds or lighten on dark ones, so the colour reads
// like the chosen swatch and text stays legible on both. The ink stays
// translucent so text can never be camouflaged by a solid band.

const HL_SAMPLE = 16;
const hlSampleCanvas = document.createElement("canvas");
hlSampleCanvas.width = hlSampleCanvas.height = HL_SAMPLE;
const hlSampleCtx = hlSampleCanvas.getContext("2d", {
  willReadFrequently: true,
});

// Rasterize a stroke's SVG into a small coverage mask so classification can
// look only at page pixels actually under the ink. A stroke's bounding box
// is mostly empty background (especially for scribbles), so sampling the
// whole box mis-classifies strokes near light/dark boundaries.
const hlMaskCache = new WeakMap();
function getInkMask(svg) {
  let cached = hlMaskCache.get(svg);
  if (!cached) {
    cached = (async () => {
      try {
        const clone = svg.cloneNode(true);
        clone.removeAttribute("style");
        clone.setAttribute("width", "48");
        clone.setAttribute("height", "48");
        for (const path of clone.querySelectorAll("path")) {
          path.setAttribute("fill", "#000");
          if (path.getAttribute("stroke") !== "none") {
            path.setAttribute("stroke", "#000");
          }
        }
        const blob = new Blob([new XMLSerializer().serializeToString(clone)], {
          type: "image/svg+xml",
        });
        const url = URL.createObjectURL(blob);
        try {
          const img = new Image();
          await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = url;
          });
          const c = document.createElement("canvas");
          c.width = c.height = HL_SAMPLE;
          const cx = c.getContext("2d", { willReadFrequently: true });
          cx.drawImage(img, 0, 0, HL_SAMPLE, HL_SAMPLE);
          return cx.getImageData(0, 0, HL_SAMPLE, HL_SAMPLE).data;
        } finally {
          URL.revokeObjectURL(url);
        }
      } catch {
        return null;
      }
    })();
    hlMaskCache.set(svg, cached);
  }
  return cached;
}

async function isDarkUnderSvg(svg) {
  const pageEl = svg.closest(".page");
  const canvas = pageEl?.querySelector(".canvasWrapper canvas");
  if (!canvas || !hlSampleCtx) return false;
  const cRect = canvas.getBoundingClientRect();
  const sRect = svg.getBoundingClientRect();
  const left = Math.max(cRect.left, sRect.left);
  const top = Math.max(cRect.top, sRect.top);
  const right = Math.min(cRect.right, sRect.right);
  const bottom = Math.min(cRect.bottom, sRect.bottom);
  if (right - left < 1 || bottom - top < 1 || cRect.width < 1) return false;
  const scaleX = canvas.width / cRect.width;
  const scaleY = canvas.height / cRect.height;
  try {
    const mask = await getInkMask(svg);
    hlSampleCtx.drawImage(
      canvas,
      (left - cRect.left) * scaleX,
      (top - cRect.top) * scaleY,
      (right - left) * scaleX,
      (bottom - top) * scaleY,
      0,
      0,
      HL_SAMPLE,
      HL_SAMPLE
    );
    const d = hlSampleCtx.getImageData(0, 0, HL_SAMPLE, HL_SAMPLE).data;
    // Majority vote over ink-covered samples; fall back to all samples if
    // the mask could not be rasterized.
    let dark = 0;
    let total = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (mask && mask[i + 3] < 32) continue;
      total++;
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (lum < 128) dark++;
    }
    if (total === 0) return false;
    return dark * 2 > total;
  } catch {
    return false;
  }
}

async function applyHighlightBlend() {
  const mode = tools.highlighter.blend;
  const svgs = document.querySelectorAll(
    '.canvasWrapper svg.draw:not([stroke-opacity="1"])'
  );
  for (const svg of svgs) {
    if (mode === "auto") {
      // lighten/darken rather than screen/multiply: at (near-)full ink
      // opacity they are idempotent, so overlapping strokes are seamless —
      // and they inherently preserve text (dark text survives darken,
      // light text survives lighten).
      const dark = await isDarkUnderSvg(svg);
      if (!svg.isConnected) continue;
      svg.style.mixBlendMode = dark ? "lighten" : "darken";
    } else {
      // Manual override: clear inline styles, the CSS class rules decide.
      svg.style.mixBlendMode = "";
    }
  }
}

let hlBlendRafId = 0;
function scheduleHighlightBlend() {
  if (hlBlendRafId) return;
  hlBlendRafId = requestAnimationFrame(() => {
    hlBlendRafId = 0;
    applyHighlightBlend();
  });
}

// Re-classify whenever strokes or page pixels change: stroke drawn/undone
// (editingstateschanged), zoom/scroll re-render (pagerendered), existing
// annotations materializing (editorsrendered), mode switches.
eventBus.on("pagerendered", scheduleHighlightBlend);
eventBus.on("editingstateschanged", scheduleHighlightBlend);
eventBus.on("editorsrendered", scheduleHighlightBlend);
eventBus.on("annotationeditormodechanged", scheduleHighlightBlend);

laserWidthInput?.addEventListener("input", () => {
  LASER.width = Number(laserWidthInput.value);
  updateLaserLabels();
  updateDrawCursorStyle();
});

laserFadeInput?.addEventListener("input", () => {
  LASER.holdMs = Number(laserFadeInput.value) * 1000;
  updateLaserLabels();
});

if (eraserModes) {
  eraserModes.addEventListener("click", (e) => {
    const btn = e.target.closest(".mode-btn");
    if (!btn) return;
    tools.eraser.mode = btn.dataset.mode;
    for (const b of eraserModes.querySelectorAll(".mode-btn")) {
      b.classList.toggle("active", b === btn);
    }
    if (eraserModeLabel) {
      eraserModeLabel.textContent =
        btn.dataset.mode === "stroke" ? "Stroke" : "Partial";
    }
  });
}

// --- Tool Switching -------------------------------------------------

function dispatchParam(type, value) {
  eventBus.dispatch("switchannotationeditorparams", { type, value });
}

function applyToolParams() {
  if (!editorReady) return;
  // PDF.js applies param changes to the selected editors as well as to the
  // defaults. The last-drawn stroke stays selected after a session commits,
  // so changing the colour would silently re-colour it — unselect first so
  // only future strokes are affected.
  uiManager?.unselectAll();
  const tool = pendingTool;
  if (tool === "pen") {
    dispatchParam(AnnotationEditorParamsType.INK_COLOR, tools.pen.color);
    dispatchParam(AnnotationEditorParamsType.INK_THICKNESS, tools.pen.size);
    dispatchParam(AnnotationEditorParamsType.INK_OPACITY, 1);
  } else if (tool === "highlighter") {
    dispatchParam(
      AnnotationEditorParamsType.INK_COLOR,
      tools.highlighter.color
    );
    dispatchParam(
      AnnotationEditorParamsType.INK_THICKNESS,
      tools.highlighter.size
    );
    dispatchParam(
      AnnotationEditorParamsType.INK_OPACITY,
      tools.highlighter.opacity
    );
  }
  updateDrawCursorStyle();
}

function awaitEditorMode(mode) {
  return new Promise((resolve) => {
    if (pdfViewer.annotationEditorMode === mode) {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      eventBus.off("annotationeditormodechanged", onChange);
      resolve();
    };
    const onChange = (evt) => {
      if (evt.mode === mode) finish();
    };
    eventBus.on("annotationeditormodechanged", onChange);
    setTimeout(finish, 1000);
  });
}

async function setTool(tool) {
  pendingTool = tool;
  const request = ++toolRequest;

  Object.entries(toolButtons).forEach(([key, btn]) => {
    if (btn) btn.classList.toggle("active", key === tool);
  });

  if (penToggle) penToggle.classList.toggle("hidden", tool !== "pen");
  if (hlToggle) hlToggle.classList.toggle("hidden", tool !== "highlighter");
  if (eraserToggle) eraserToggle.classList.toggle("hidden", tool !== "eraser");
  if (laserToggle) laserToggle.classList.toggle("hidden", tool !== "laser");
  closeAllPopovers();

  const appEl = $("#app");
  if (appEl) {
    appEl.classList.toggle("pen-active", tool === "pen");
    appEl.classList.toggle("hl-active", tool === "highlighter");
    appEl.classList.toggle("eraser-active", tool === "eraser");
    appEl.classList.toggle("laser-active", tool === "laser");
    appEl.classList.toggle("drawing-tool-active", tool !== "none");
  }
  updateDrawCursorStyle();
  if (tool !== "laser") clearLaser();

  if (!currentPdfDocument || !editorReady) return;

  // The laser draws on its own overlay canvas; PDF.js stays in NONE mode so
  // nothing it draws can ever become part of the document.
  const wantsInk = tool !== "none" && tool !== "laser";

  // Always pass through NONE first: it commits any in-progress drawing
  // session and lets PDF.js reset its pointer-type latch, then re-enter INK
  // with this tool's parameters.
  if (pdfViewer.annotationEditorMode !== AnnotationEditorType.NONE) {
    pdfViewer.annotationEditorMode = { mode: AnnotationEditorType.NONE };
    await awaitEditorMode(AnnotationEditorType.NONE);
    if (request !== toolRequest) return;
  }

  if (wantsInk) {
    pdfViewer.annotationEditorMode = { mode: AnnotationEditorType.INK };
    await awaitEditorMode(AnnotationEditorType.INK);
    if (request !== toolRequest) return;
    applyToolParams();
  }
}

toolButtons.none.addEventListener("click", () => setTool("none"));
toolButtons.pen.addEventListener("click", () => setTool("pen"));
toolButtons.highlighter.addEventListener("click", () => setTool("highlighter"));
toolButtons.eraser.addEventListener("click", () => setTool("eraser"));
toolButtons.laser.addEventListener("click", () => setTool("laser"));

// Re-apply drawing params whenever the editor mode lands on INK (e.g. after
// PDF.js internally toggles modes) so the active tool's colour/size stick.
eventBus.on("annotationeditormodechanged", (evt) => {
  if (
    evt.mode === AnnotationEditorType.INK &&
    (pendingTool === "pen" || pendingTool === "highlighter")
  ) {
    applyToolParams();
  }
});

// --- Eraser -----------------------------------------------------------

// Geometry cache: pageIndex -> [{ editor, data, strokes }] where each stroke
// holds client-space points for hit-testing.
const eraserCache = new Map();
let erasing = false;
let eraseQueue = Promise.resolve();

function markDirty() {
  vscode.postMessage({ type: "dirty" });
  dirtyNotified = true;
}

function getPageLayerRect(pageIndex) {
  const pageView = pdfViewer.getPageView(pageIndex);
  const layerDiv = pageView?.annotationEditorLayer?.div;
  const el = layerDiv || pageView?.div;
  return el ? el.getBoundingClientRect() : null;
}

function buildEraserCacheForPage(pageIndex) {
  const entries = [];
  if (!uiManager) return entries;
  const pageView = pdfViewer.getPageView(pageIndex);
  const layerRect = getPageLayerRect(pageIndex);
  if (!pageView || !layerRect) return entries;
  const viewport = pageView.viewport;

  for (const editor of uiManager.getEditors(pageIndex)) {
    if (editor.deleted) continue;
    let data;
    try {
      data = editor.serialize(true);
    } catch {
      continue;
    }
    if (!data?.paths?.points?.length) continue;
    const thicknessCss = (data.thickness || 1) * pdfViewer.currentScale;
    const strokes = data.paths.points.map((pts) => {
      const client = new Float32Array(pts.length);
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (let i = 0; i < pts.length; i += 2) {
        const [vx, vy] = viewport.convertToViewportPoint(pts[i], pts[i + 1]);
        const cx = layerRect.left + vx;
        const cy = layerRect.top + vy;
        client[i] = cx;
        client[i + 1] = cy;
        if (cx < minX) minX = cx;
        if (cy < minY) minY = cy;
        if (cx > maxX) maxX = cx;
        if (cy > maxY) maxY = cy;
      }
      return { client, bbox: [minX, minY, maxX, maxY] };
    });
    entries.push({ editor, data, strokes, thicknessCss });
  }
  eraserCache.set(pageIndex, entries);
  return entries;
}

function segmentDistanceSq(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = 0;
  if (lenSq > 0) {
    t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
  }
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  const ddx = px - cx;
  const ddy = py - cy;
  return ddx * ddx + ddy * ddy;
}

function strokeHit(stroke, x, y, radius) {
  const [minX, minY, maxX, maxY] = stroke.bbox;
  if (x < minX - radius || x > maxX + radius || y < minY - radius || y > maxY + radius) {
    return false;
  }
  const pts = stroke.client;
  const rSq = radius * radius;
  if (pts.length === 2) {
    const dx = x - pts[0];
    const dy = y - pts[1];
    return dx * dx + dy * dy <= rSq;
  }
  for (let i = 0; i + 3 < pts.length; i += 2) {
    if (segmentDistanceSq(x, y, pts[i], pts[i + 1], pts[i + 2], pts[i + 3]) <= rSq) {
      return true;
    }
  }
  return false;
}

function strokeBBoxWithMargin(points, margin) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const pts of points) {
    for (let i = 0; i < pts.length; i += 2) {
      if (pts[i] < minX) minX = pts[i];
      if (pts[i + 1] < minY) minY = pts[i + 1];
      if (pts[i] > maxX) maxX = pts[i];
      if (pts[i + 1] > maxY) maxY = pts[i + 1];
    }
  }
  return [minX - margin, minY - margin, maxX + margin, maxY + margin];
}

function makeInkData(template, pointArrays) {
  const margin = (template.thickness || 1) / 2 + 1;
  return {
    annotationType: AnnotationEditorType.INK,
    color: template.color,
    thickness: template.thickness,
    opacity: template.opacity,
    // PDF.js expects typed arrays here (it calls .subarray on each stroke).
    paths: {
      lines: null,
      points: pointArrays.map((p) =>
        p instanceof Float32Array ? p : new Float32Array(p)
      ),
    },
    pageIndex: template.pageIndex,
    rect: strokeBBoxWithMargin(pointArrays, margin),
    rotation: template.rotation || 0,
    structTreeParentId: null,
  };
}

// Replace an editor's strokes with new point sets (undoable). An empty
// newPointSets deletes the editor outright.
async function replaceEditorStrokes(entry, newPointSets) {
  const { editor, data } = entry;
  const layer =
    editor.parent || uiManager.getLayer?.(editor.pageIndex) || null;
  if (!layer) return;

  const newEditors = [];
  if (newPointSets.length) {
    const newData = makeInkData(data, newPointSets);
    const created = await layer.deserialize(newData);
    if (created) newEditors.push(created);
  }

  const cmd = () => {
    editor.remove();
    for (const e of newEditors) uiManager.rebuild(e);
  };
  const undo = () => {
    for (const e of newEditors) e.remove();
    uiManager.rebuild(editor);
  };
  uiManager.addCommands({ cmd, undo, mustExec: true });
  markDirty();
}

function eraseHitsAt(clientX, clientY) {
  const pageEl = document
    .elementsFromPoint(clientX, clientY)
    .find((el) => el.classList?.contains("page"));
  if (!pageEl) return;
  const pageIndex = parseInt(pageEl.dataset.pageNumber, 10) - 1;
  if (Number.isNaN(pageIndex)) return;

  let entries = eraserCache.get(pageIndex);
  if (!entries) entries = buildEraserCacheForPage(pageIndex);

  const radius = tools.eraser.size / 2;
  for (const entry of entries) {
    const effRadius = radius + entry.thicknessCss / 2;
    const hitIndexes = [];
    entry.strokes.forEach((stroke, i) => {
      if (strokeHit(stroke, clientX, clientY, effRadius)) hitIndexes.push(i);
    });
    if (!hitIndexes.length) continue;

    const pagePoints = entry.data.paths.points;
    let newPointSets;

    if (tools.eraser.mode === "stroke") {
      newPointSets = pagePoints.filter((_, i) => !hitIndexes.includes(i));
    } else {
      // Partial: drop the points inside the eraser circle, splitting each
      // hit stroke into the runs of points that remain.
      const pageView = pdfViewer.getPageView(pageIndex);
      const layerRect = getPageLayerRect(pageIndex);
      if (!pageView || !layerRect) return;
      const lx = clientX - layerRect.left;
      const ly = clientY - layerRect.top;
      const rSq = (radius + entry.thicknessCss / 2) ** 2;
      newPointSets = [];
      pagePoints.forEach((pts, i) => {
        if (!hitIndexes.includes(i)) {
          newPointSets.push(pts);
          return;
        }
        const clientPts = entry.strokes[i].client;
        let run = [];
        for (let j = 0; j < pts.length; j += 2) {
          const dx = clientPts[j] - clientX;
          const dy = clientPts[j + 1] - clientY;
          if (dx * dx + dy * dy <= rSq) {
            if (run.length >= 4) newPointSets.push(run);
            run = [];
          } else {
            run.push(pts[j], pts[j + 1]);
          }
        }
        if (run.length >= 4) newPointSets.push(run);
      });
    }

    // Remove the entry from the cache now; it is rebuilt on the next hit.
    eraserCache.delete(pageIndex);
    eraseQueue = eraseQueue.then(() =>
      replaceEditorStrokes(entry, newPointSets).catch((err) =>
        report(err?.message ?? err)
      )
    );
    // Only handle one editor per event; the cache rebuild after the queued
    // replacement keeps subsequent hits consistent.
    break;
  }
}

function isEraserGesturePressed(e) {
  return e.buttons === 1 || (e.buttons === 0 && e.pointerType === "pen");
}

viewerWrapperEl.addEventListener(
  "pointerdown",
  (e) => {
    if (pendingTool !== "eraser") return;
    e.preventDefault();
    e.stopPropagation();
    erasing = true;
    eraserCache.clear();
    eraseHitsAt(e.clientX, e.clientY);
  },
  { capture: true }
);

viewerWrapperEl.addEventListener(
  "pointermove",
  (e) => {
    if (pendingTool !== "eraser") return;
    e.stopPropagation();
    if (erasing && isEraserGesturePressed(e)) {
      eraseHitsAt(e.clientX, e.clientY);
    }
  },
  { capture: true }
);

window.addEventListener(
  "pointerup",
  () => {
    erasing = false;
  },
  { capture: true }
);

// Invalidate eraser geometry when strokes change (draw/undo/redo).
// Also keep strokes deselected while a writing tool is active: PDF.js
// selects the last-drawn editor when a drawing session commits (toolbar
// click, window blur when a recording starts, Escape), and its focus
// manager restores that selection when the window regains focus — which
// shows a selection box that writing tools should never display.
eventBus.on("editingstateschanged", (evt) => {
  eraserCache.clear();
  if (evt?.details?.hasSelectedEditor && pendingTool !== "none") {
    queueMicrotask(() => uiManager?.unselectAll());
  }
});

// --- Laser pointer ----------------------------------------------------
// GoodNotes-style presentation laser: strokes glow on an overlay canvas
// above the pages and are never part of the PDF. While you keep writing
// they stay; once you stop, they hold for LASER.holdMs and then fade out.

const LASER = {
  color: "#ff3b30",
  coreColor: "#ffe7e4",
  width: 2,
  holdMs: 3000,
  fadeMs: 650,
};

const laserCanvasEl = $("#laserCanvas");
const laserCtx = laserCanvasEl ? laserCanvasEl.getContext("2d") : null;
let laserStrokes = [];
let laserActiveStroke = null;
let laserLastActivity = 0;
let laserRafId = 0;

// Points are stored in scroll-content coordinates so strokes stay glued to
// the page if the user scrolls while they are visible.
function laserPoint(e) {
  return {
    x: e.clientX + viewerContainerEl.scrollLeft,
    y: e.clientY + viewerContainerEl.scrollTop,
  };
}

function sizeLaserCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = viewerWrapperEl.clientWidth;
  const h = viewerWrapperEl.clientHeight;
  if (
    laserCanvasEl.width !== Math.round(w * dpr) ||
    laserCanvasEl.height !== Math.round(h * dpr)
  ) {
    laserCanvasEl.width = Math.round(w * dpr);
    laserCanvasEl.height = Math.round(h * dpr);
    laserCanvasEl.style.width = `${w}px`;
    laserCanvasEl.style.height = `${h}px`;
  }
}

function laserStrokePath(pts, ox, oy) {
  laserCtx.beginPath();
  laserCtx.moveTo(pts[0].x + ox, pts[0].y + oy);
  if (pts.length === 1) {
    laserCtx.lineTo(pts[0].x + ox + 0.01, pts[0].y + oy);
    return;
  }
  for (let i = 1; i < pts.length - 1; i++) {
    const midX = (pts[i].x + pts[i + 1].x) / 2 + ox;
    const midY = (pts[i].y + pts[i + 1].y) / 2 + oy;
    laserCtx.quadraticCurveTo(pts[i].x + ox, pts[i].y + oy, midX, midY);
  }
  const last = pts[pts.length - 1];
  laserCtx.lineTo(last.x + ox, last.y + oy);
}

function laserFrame(now) {
  laserRafId = 0;
  if (!laserCtx) return;
  sizeLaserCanvas();
  const dpr = window.devicePixelRatio || 1;
  laserCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  laserCtx.clearRect(0, 0, laserCanvasEl.width, laserCanvasEl.height);

  const idle = now - laserLastActivity;
  let alpha = 1;
  if (!laserActiveStroke && idle > LASER.holdMs) {
    alpha = 1 - (idle - LASER.holdMs) / LASER.fadeMs;
  }
  if (alpha <= 0 || laserStrokes.length === 0) {
    laserStrokes = [];
    return; // canvas already cleared; loop stops
  }

  // Content coords -> canvas coords (canvas is glued to the wrapper).
  const rect = viewerWrapperEl.getBoundingClientRect();
  const ox = -viewerContainerEl.scrollLeft - rect.left;
  const oy = -viewerContainerEl.scrollTop - rect.top;

  laserCtx.lineCap = "round";
  laserCtx.lineJoin = "round";
  for (const stroke of laserStrokes) {
    // Outer glow.
    laserCtx.globalAlpha = 0.9 * alpha;
    laserCtx.strokeStyle = LASER.color;
    laserCtx.lineWidth = LASER.width + 2.5;
    laserCtx.shadowColor = LASER.color;
    laserCtx.shadowBlur = 14;
    laserStrokePath(stroke.points, ox, oy);
    laserCtx.stroke();
    // Hot core.
    laserCtx.globalAlpha = alpha;
    laserCtx.strokeStyle = LASER.coreColor;
    laserCtx.lineWidth = Math.max(1.5, LASER.width - 2.5);
    laserCtx.shadowBlur = 0;
    laserStrokePath(stroke.points, ox, oy);
    laserCtx.stroke();
  }
  // Bright tip on the stroke being drawn right now.
  if (laserActiveStroke?.points.length) {
    const tip = laserActiveStroke.points[laserActiveStroke.points.length - 1];
    laserCtx.globalAlpha = 1;
    laserCtx.fillStyle = "#ffffff";
    laserCtx.shadowColor = LASER.color;
    laserCtx.shadowBlur = 18;
    laserCtx.beginPath();
    laserCtx.arc(tip.x + ox, tip.y + oy, LASER.width * 0.9, 0, Math.PI * 2);
    laserCtx.fill();
    laserCtx.shadowBlur = 0;
  }
  laserCtx.globalAlpha = 1;

  laserRafId = requestAnimationFrame(laserFrame);
}

function startLaserLoop() {
  if (!laserRafId && laserStrokes.length) {
    laserRafId = requestAnimationFrame(laserFrame);
  }
}

function clearLaser() {
  laserStrokes = [];
  laserActiveStroke = null;
  if (laserRafId) {
    cancelAnimationFrame(laserRafId);
    laserRafId = 0;
  }
  if (laserCtx) {
    laserCtx.setTransform(1, 0, 0, 1, 0, 0);
    laserCtx.clearRect(0, 0, laserCanvasEl.width, laserCanvasEl.height);
  }
}

// The stroke belongs to the pointer that started it. Windows parks the
// mouse while a stylus writes and stray mouse events arrive from there
// mid-stroke: without this guard a mouse click would restart the stroke at
// the mouse position, and a stray mouse button release would cut it short.
let laserPointerId = null;

viewerWrapperEl.addEventListener(
  "pointerdown",
  (e) => {
    if (pendingTool !== "laser") return;
    e.preventDefault();
    e.stopPropagation();
    if (laserActiveStroke && e.pointerId !== laserPointerId) return;
    laserPointerId = e.pointerId;
    laserActiveStroke = { points: [laserPoint(e)] };
    laserStrokes.push(laserActiveStroke);
    laserLastActivity = performance.now();
    startLaserLoop();
  },
  { capture: true }
);
viewerWrapperEl.addEventListener(
  "pointermove",
  (e) => {
    if (pendingTool !== "laser") return;
    e.stopPropagation();
    if (!laserActiveStroke || e.buttons === 0) return;
    if (e.pointerId !== laserPointerId) return;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events.length ? events : [e]) {
      laserActiveStroke.points.push(laserPoint(ev));
    }
    laserLastActivity = performance.now();
  },
  { capture: true }
);
// pointercancel covers a stylus leaving range mid-contact, which never
// sends a pointerup; without it the owner check would leave the stroke
// stuck open and block every new stroke.
for (const evName of ["pointerup", "pointercancel"]) {
  window.addEventListener(
    evName,
    (e) => {
      if (laserActiveStroke && e.pointerId === laserPointerId) {
        laserActiveStroke = null;
        laserLastActivity = performance.now();
      }
    },
    { capture: true }
  );
}

// Highlighter session control. Strokes inside one PDF.js drawing session
// merge into a single filled path, which CANNOT self-stack — overlapping
// swipes in one burst render as one uniform band even though the ink is
// translucent. So: keep the session open while the user is actively
// scribbling, and end it after a short idle pause (or when they move on),
// so each burst becomes its own editor and gets its own light/dark blend
// classification for the background it actually sits on.
const HL_SESSION_IDLE_MS = 1500;
let hlSessionTimer = 0;

function endHighlightSession() {
  clearTimeout(hlSessionTimer);
  hlSessionTimer = 0;
  uiManager?.currentLayer?.endDrawingSession?.(false);
  uiManager?.unselectAll();
}

window.addEventListener(
  "pointerup",
  () => {
    if (pendingTool !== "highlighter") return;
    clearTimeout(hlSessionTimer);
    hlSessionTimer = setTimeout(() => {
      if (pendingTool === "highlighter") endHighlightSession();
    }, HL_SESSION_IDLE_MS);
  },
  { capture: true }
);
window.addEventListener(
  "pointerdown",
  () => {
    // A new stroke arrived before the idle timeout: keep the session alive.
    if (pendingTool === "highlighter") clearTimeout(hlSessionTimer);
  },
  { capture: true }
);
// Swallow clicks so lasering over a hyperlink never navigates.
viewerWrapperEl.addEventListener(
  "click",
  (e) => {
    if (pendingTool !== "laser") return;
    e.preventDefault();
    e.stopPropagation();
  },
  { capture: true }
);

// --- Custom drawing cursor -------------------------------------------
// Windows hides the pointer while a stylus is touching the tablet, and
// screen recorders often show a stale system cursor. This overlay is drawn
// into the page itself, so it is always visible — including in recordings.

let drawCursorAnchor = "center";

function updateDrawCursorStyle() {
  if (!drawCursorEl) return;
  const tool = pendingTool;
  drawCursorEl.className = "draw-cursor";
  drawCursorEl.innerHTML = "";
  drawCursorEl.style.boxShadow = "";
  drawCursorAnchor = tool === "pen" ? "tip" : "center";
  if (tool === "pen") {
    // A pen glyph with its tip at the pointer, so viewers (and recordings)
    // can clearly see the tool while writing.
    drawCursorEl.style.width = "0";
    drawCursorEl.style.height = "0";
    drawCursorEl.style.background = "none";
    drawCursorEl.style.border = "none";
    drawCursorEl.style.opacity = "1";
    drawCursorEl.innerHTML = `
      <svg class="pen-glyph" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"
              fill="${tools.pen.color}" stroke="rgba(255,255,255,0.95)"
              stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span class="pen-tip-dot" style="background:${tools.pen.color}"></span>`;
  } else if (tool === "highlighter") {
    const d = Math.max(8, tools.highlighter.size * pdfViewer.currentScale);
    drawCursorEl.style.width = `${d}px`;
    drawCursorEl.style.height = `${d}px`;
    drawCursorEl.style.background = tools.highlighter.color;
    drawCursorEl.style.border = "1.5px solid rgba(255,255,255,0.9)";
    drawCursorEl.style.opacity = "0.6";
  } else if (tool === "eraser") {
    const d = tools.eraser.size;
    drawCursorEl.style.width = `${d}px`;
    drawCursorEl.style.height = `${d}px`;
    drawCursorEl.style.background = "rgba(255,255,255,0.15)";
    drawCursorEl.style.border = "1.5px solid rgba(120,120,120,0.95)";
    drawCursorEl.style.opacity = "1";
  } else if (tool === "laser") {
    const d = Math.max(8, LASER.width * 2);
    drawCursorEl.style.width = `${d}px`;
    drawCursorEl.style.height = `${d}px`;
    drawCursorEl.style.background = "#ff5148";
    drawCursorEl.style.border = "none";
    drawCursorEl.style.opacity = "1";
    drawCursorEl.style.boxShadow =
      "0 0 0 1.5px rgba(255,255,255,0.85), 0 0 8px 3px rgba(255,66,54,0.85), 0 0 18px 8px rgba(255,66,54,0.4)";
  } else {
    drawCursorEl.classList.add("hidden");
    return;
  }
}

// Pen -> mouse handoff guard. Windows Ink parks the mouse arrow at its old
// position while the stylus is in use, so the first mouse events after pen
// writing arrive from a stale, far-away location. Ignore the mouse until it
// is moved deliberately (or clicked), so merely brushing the mouse doesn't
// teleport the cursor away from where the pen was writing.
const MOUSE_TAKEOVER_PX = 14;
let lastDrawPointerType = "mouse";
let staleMouseOrigin = null;

// The cursor overlay must never slow the ink down: reading layout
// (getBoundingClientRect) inside pointermove forces a reflow on every
// sample while PDF.js is mutating the stroke SVG. Cache the wrapper rect
// and apply at most one transform per animation frame instead.
let wrapperRect = null;
const invalidateWrapperRect = () => {
  wrapperRect = null;
};
let cursorRafPending = false;
let cursorX = 0;
let cursorY = 0;

function renderDrawCursor() {
  cursorRafPending = false;
  if (!drawCursorEl || pendingTool === "none") return;
  const rect = (wrapperRect ||= viewerWrapperEl.getBoundingClientRect());
  const inside =
    cursorX >= rect.left &&
    cursorX <= rect.right &&
    cursorY >= rect.top &&
    cursorY <= rect.bottom;
  drawCursorEl.classList.toggle("hidden", !inside);
  if (inside) {
    drawCursorEl.style.transform =
      drawCursorAnchor === "tip"
        ? `translate(${cursorX}px, ${cursorY}px)`
        : `translate(${cursorX}px, ${cursorY}px) translate(-50%, -50%)`;
  }
}

function positionDrawCursor(e) {
  if (!drawCursorEl || pendingTool === "none") return;
  if (e.pointerType === "pen" || e.pointerType === "touch") {
    lastDrawPointerType = "pen";
    staleMouseOrigin = null;
  } else if (lastDrawPointerType === "pen") {
    if (e.type === "pointermove") {
      if (!staleMouseOrigin) {
        staleMouseOrigin = { x: e.clientX, y: e.clientY };
        return;
      }
      const moved = Math.hypot(
        e.clientX - staleMouseOrigin.x,
        e.clientY - staleMouseOrigin.y
      );
      if (moved < MOUSE_TAKEOVER_PX) return;
    }
    lastDrawPointerType = "mouse";
    staleMouseOrigin = null;
  }
  cursorX = e.clientX;
  cursorY = e.clientY;
  if (!cursorRafPending) {
    cursorRafPending = true;
    requestAnimationFrame(renderDrawCursor);
  }
}

window.addEventListener("resize", invalidateWrapperRect);
viewerWrapperEl.addEventListener("scroll", invalidateWrapperRect, {
  capture: true,
  passive: true,
});

window.addEventListener("pointermove", positionDrawCursor, {
  capture: true,
  passive: true,
});
window.addEventListener("pointerdown", positionDrawCursor, {
  capture: true,
  passive: true,
});
window.addEventListener(
  "blur",
  () => drawCursorEl && drawCursorEl.classList.add("hidden")
);

// --- Undo / Redo -----------------------------------------------------

btnUndo.addEventListener("click", () => {
  eventBus.dispatch("editingaction", { name: "undo" });
});
btnRedo.addEventListener("click", () => {
  eventBus.dispatch("editingaction", { name: "redo" });
});

eventBus.on("editingstateschanged", (evt) => {
  const { hasSomethingToUndo, hasSomethingToRedo, isEmpty } = evt.details;
  if (hasSomethingToUndo !== undefined) btnUndo.disabled = !hasSomethingToUndo;
  if (hasSomethingToRedo !== undefined) btnRedo.disabled = !hasSomethingToRedo;

  if (isEmpty === false && !dirtyNotified) {
    dirtyNotified = true;
    vscode.postMessage({ type: "dirty" });
  } else if (isEmpty === true) {
    dirtyNotified = false;
  }
});

// --- Clear annotations (current page / whole file) --------------------
// Two-part deletion: editors that exist as objects are removed through the
// normal undoable path. Existing annotations on pages whose editor layer
// never rendered (lazy virtual scrolling) have no editor object yet, so
// they are deleted by writing a {deleted: true} record straight into the
// annotation storage — the same shape editors serialize to — and marking
// the id deleted in the uiManager so a later page render keeps them hidden.

const EDITABLE_SUBTYPES = new Set([
  "Ink",
  "Highlight",
  "FreeText",
  "Stamp",
  "Underline",
  "StrikeOut",
  "Squiggly",
]);

async function collectPhantomDeletions(pageIndexes, knownIds) {
  const phantoms = [];
  await Promise.all(
    pageIndexes.map(async (p) => {
      let annots;
      try {
        const page = await currentPdfDocument.getPage(p + 1);
        annots = await page.getAnnotations();
      } catch {
        return;
      }
      for (const annot of annots) {
        if (!annot?.id || !EDITABLE_SUBTYPES.has(annot.subtype)) continue;
        if (knownIds.has(annot.id)) continue;
        if (uiManager.isDeletedAnnotationElement(annot.id)) continue;
        phantoms.push({
          // The worker's save path only processes storage entries whose key
          // starts with "pdfjs_internal_editor_" (getNewAnnotationsMap), so
          // the record must be keyed by a real editor id, not the
          // annotation id — that goes in the `id` field.
          key: uiManager.getId(),
          data: {
            id: annot.id,
            deleted: true,
            pageIndex: p,
            popupRef: annot.popupRef || "",
          },
          fake: { annotationElementId: annot.id, id: annot.id },
        });
      }
    })
  );
  return phantoms;
}

async function clearAnnotations(scope) {
  if (!uiManager || !currentPdfDocument) return;
  uiManager.commitOrRemove();
  uiManager.currentLayer?.endDrawingSession?.(true);
  uiManager.unselectAll();

  const pageIndexes =
    scope === "page"
      ? [pdfViewer.currentPageNumber - 1]
      : Array.from({ length: pdfViewer.pagesCount }, (_, i) => i);

  const editors = [];
  const knownIds = new Set();
  for (const p of pageIndexes) {
    for (const ed of uiManager.getEditors(p)) {
      if (ed.isEmpty()) continue;
      editors.push(ed);
      if (ed.annotationElementId) knownIds.add(ed.annotationElementId);
    }
  }

  const phantoms = await collectPhantomDeletions(pageIndexes, knownIds);
  if (!editors.length && !phantoms.length) return;

  const storage = currentPdfDocument.annotationStorage;
  const cmd = () => {
    for (const ed of editors) ed.remove();
    for (const ph of phantoms) {
      storage.setValue(ph.key, ph.data);
      uiManager.addDeletedAnnotationElement(ph.fake);
      // The phantom is plain data, not an editor: keep it out of the
      // changed-annotations map so uiManager.renderAnnotationElement never
      // tries to call editor methods on it during a later page render.
      uiManager.removeChangedExistingAnnotation(ph.fake);
    }
  };
  const undo = () => {
    for (const ed of editors) uiManager.rebuild(ed);
    for (const ph of phantoms) {
      storage.remove(ph.key);
      uiManager.removeDeletedAnnotationElement(ph.fake);
    }
  };
  uiManager.addCommands({ cmd, undo, mustExec: true });
  eraserCache.clear();
  markDirty();
}

btnClearPage.addEventListener("click", () => {
  clearAnnotations("page").catch((err) => report(err?.message ?? err));
});
btnClearAll.addEventListener("click", () => {
  clearAnnotations("file").catch((err) => report(err?.message ?? err));
});

// --- Search / Find Bar -----------------------------------------------

btnFind.addEventListener("click", () => {
  findBar.classList.toggle("hidden");
  if (!findBar.classList.contains("hidden")) {
    findInput.focus();
    findInput.select();
  }
});

function triggerFind(findPrevious = false) {
  const query = findInput.value.trim();
  if (!query) return;
  eventBus.dispatch("find", {
    query,
    phraseSearch: true,
    highlightAll: true,
    findPrevious,
  });
}

findInput.addEventListener("input", () => triggerFind(false));
findInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    triggerFind(e.shiftKey);
  } else if (e.key === "Escape") {
    findBar.classList.add("hidden");
  }
});

findPrev.addEventListener("click", () => triggerFind(true));
findNext.addEventListener("click", () => triggerFind(false));

eventBus.on("updatefindmatchescount", (evt) => {
  const { matchesCount } = evt;
  if (matchesCount && matchesCount.total > 0) {
    findMatchCount.textContent = `${matchesCount.current} of ${matchesCount.total}`;
  } else if (findInput.value) {
    findMatchCount.textContent = "No matches";
  } else {
    findMatchCount.textContent = "";
  }
});

// --- Keyboard Shortcuts ----------------------------------------------

window.addEventListener("keydown", (e) => {
  if (!currentPdfDocument) return;
  const mod = e.ctrlKey || e.metaKey;
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

  if (mod && e.key.toLowerCase() === "f") {
    e.preventDefault();
    findBar.classList.remove("hidden");
    findInput.focus();
    findInput.select();
  } else if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
    e.preventDefault();
    eventBus.dispatch("editingaction", { name: "undo" });
  } else if (
    (mod && e.key.toLowerCase() === "y") ||
    (mod && e.shiftKey && e.key.toLowerCase() === "z")
  ) {
    e.preventDefault();
    eventBus.dispatch("editingaction", { name: "redo" });
  }
});

// --- Dynamic viewer resize --------------------------------------------
// Covers window resizes, VS Code panel collapse/expand, and our own
// sidebar toggle — anything that changes the width available to the pages.

let resizeRafId = 0;
new ResizeObserver(() => {
  invalidateWrapperRect();
  if (!currentPdfDocument || pdfViewer.currentScaleValue !== "page-width") {
    return;
  }
  cancelAnimationFrame(resizeRafId);
  resizeRafId = requestAnimationFrame(() => {
    pdfViewer.currentScaleValue = "page-width";
  });
}).observe(viewerWrapperEl);

// --- Base64 conversion helpers ---------------------------------------

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function uint8ArrayToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x2000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// --- Messaging -------------------------------------------------------

window.addEventListener("message", async (event) => {
  const msg = event.data;
  try {
    if (msg.type === "load") {
      await loadPdf(base64ToUint8Array(msg.data));
    } else if (msg.type === "getFileData") {
      const bytes = currentPdfDocument
        ? await currentPdfDocument.saveDocument()
        : new Uint8Array();
      dirtyNotified = false;
      vscode.postMessage({
        type: "response",
        requestId: msg.requestId,
        data: uint8ArrayToBase64(bytes),
      });
    }
  } catch (err) {
    report(err?.message ?? err);
    if (msg.type === "getFileData") {
      vscode.postMessage({
        type: "response",
        requestId: msg.requestId,
        data: null,
      });
    }
  }
});

vscode.postMessage({ type: "ready" });
