const vscode = require("vscode");

class PdfDocument {
  constructor(uri, data) {
    this.uri = uri;
    this.documentData = data;
  }
  dispose() {}
}

class PdfAnnotatorProvider {
  static viewType = "pdfAnnotator.editor";

  constructor(context, output) {
    this.context = context;
    this.output = output;
    this.panelsByDoc = new Map();
    this._onDidChangeCustomDocument = new vscode.EventEmitter();
    this.onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;
  }

  async openCustomDocument(uri) {
    const data = await vscode.workspace.fs.readFile(uri);
    return new PdfDocument(uri, data);
  }

  async resolveCustomEditor(document, webviewPanel) {
    const webview = webviewPanel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
      ],
    };
    const pending = new Map();
    this.panelsByDoc.set(document.uri.toString(), { webviewPanel, pending });

    webview.onDidReceiveMessage((msg) => {
      switch (msg.type) {
        case "ready":
          webview.postMessage({
            type: "load",
            data: uint8ArrayToBase64(document.documentData),
          });
          break;
        case "dirty":
          this._onDidChangeCustomDocument.fire({ document });
          break;
        case "error":
          this.output.appendLine(`[webview] ${msg.message}`);
          break;
        case "response": {
          const resolve = pending.get(msg.requestId);
          if (resolve) {
            pending.delete(msg.requestId);
            resolve(msg.data);
          }
          break;
        }
      }
    });

    webviewPanel.onDidDispose(() => {
      for (const resolve of pending.values()) {
        resolve(null);
      }
      pending.clear();
      this.panelsByDoc.delete(document.uri.toString());
    });

    webview.html = this.getHtml(webview);
  }

  async requestFileData(document) {
    const entry = this.panelsByDoc.get(document.uri.toString());
    if (!entry) return document.documentData;
    const requestId = Math.random().toString(36).slice(2);

    let timeoutId;
    const dataPromise = new Promise((resolve) => {
      entry.pending.set(requestId, resolve);
      timeoutId = setTimeout(() => {
        entry.pending.delete(requestId);
        resolve(null);
      }, 10000);
    });

    try {
      entry.webviewPanel.webview.postMessage({
        type: "getFileData",
        requestId,
      });
      const base64 = await dataPromise;
      clearTimeout(timeoutId);
      const bytes = base64 ? base64ToUint8Array(base64) : null;
      if (!bytes?.length) {
        throw new Error(
          "PDF Pen Annotator: could not read annotated data from the editor; file left unchanged."
        );
      }
      return bytes;
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  }

  async saveCustomDocument(document, cancellation) {
    document.documentData = await this.requestFileData(document);
    await vscode.workspace.fs.writeFile(document.uri, document.documentData);
  }

  async saveCustomDocumentAs(document, destination, cancellation) {
    const data = await this.requestFileData(document);
    await vscode.workspace.fs.writeFile(destination, data);
  }

  async revertCustomDocument(document) {
    document.documentData = await vscode.workspace.fs.readFile(document.uri);
    const entry = this.panelsByDoc.get(document.uri.toString());
    if (entry) {
      entry.webviewPanel.webview.postMessage({
        type: "load",
        data: uint8ArrayToBase64(document.documentData),
      });
    }
  }

  async backupCustomDocument(document, context) {
    let data;
    try {
      data = await this.requestFileData(document);
    } catch {
      data = document.documentData;
    }
    await vscode.workspace.fs.writeFile(context.destination, data);
    return {
      id: context.destination.toString(),
      delete: () =>
        vscode.workspace.fs.delete(context.destination).then(
          () => {},
          () => {}
        ),
    };
  }

  getHtml(webview) {
    const mediaUri = (...parts) =>
      webview.asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, "media", ...parts)
      );

    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource} blob:`,
      `worker-src ${webview.cspSource} blob:`,
      `child-src blob:`,
      `font-src ${webview.cspSource} data:`,
      `connect-src ${webview.cspSource} blob:`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${mediaUri("pdf_viewer.css")}">
<link rel="stylesheet" href="${mediaUri("style.css")}">
</head>
<body>
<div id="app">
  <div id="toolbar">
    <button id="sidebarToggle" class="tb-btn" title="Toggle Sidebar" aria-label="Toggle Sidebar">
      <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/></svg>
    </button>
    <button id="btnFind" class="tb-btn" title="Find in document" aria-label="Find in document">
      <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
    </button>

    <div class="tb-sep"></div>

    <button id="btnPrev" class="tb-btn" title="Previous Page" aria-label="Previous page">
      <svg viewBox="0 0 24 24"><path d="m18 15-6-6-6 6"/></svg>
    </button>
    <button id="btnNext" class="tb-btn" title="Next Page" aria-label="Next page">
      <svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
    </button>
    <input type="number" id="pageNumber" value="1" min="1" class="page-input" aria-label="Page number">
    <span class="page-of">of <span id="numPages">1</span></span>

    <div class="tb-sep"></div>

    <button id="zoomOut" class="tb-btn" title="Zoom Out" aria-label="Zoom out">
      <svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>
    </button>
    <button id="zoomIn" class="tb-btn" title="Zoom In" aria-label="Zoom in">
      <svg viewBox="0 0 24 24"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
    </button>
    <select id="scaleSelect" class="scale-select" aria-label="Zoom level">
      <option value="auto">Automatic Zoom</option>
      <option value="page-actual">Actual Size</option>
      <option value="page-fit">Page Fit</option>
      <option value="page-width">Page Width</option>
      <option value="0.5">50%</option>
      <option value="0.75">75%</option>
      <option value="1.0">100%</option>
      <option value="1.25">125%</option>
      <option value="1.5">150%</option>
      <option value="2.0">200%</option>
      <option value="3.0">300%</option>
      <option value="4.0">400%</option>
    </select>

    <div class="tb-sep"></div>

    <div class="tool-group">
      <button id="toolNone" class="tb-btn tool-btn active" title="Select / Pan" aria-label="Select or pan">
        <svg viewBox="0 0 24 24"><path d="m4 4 7.07 17 2.51-7.39L21 11.07z"/></svg>
      </button>
      <button id="toolPen" class="tb-btn tool-btn" title="Pen Tool" aria-label="Pen tool">
        <svg viewBox="0 0 24 24"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
      </button>
      <button id="toolHighlighter" class="tb-btn tool-btn" title="Highlighter" aria-label="Highlighter">
        <svg viewBox="0 0 24 24"><path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/></svg>
      </button>
      <button id="toolEraser" class="tb-btn tool-btn" title="Eraser" aria-label="Eraser">
        <svg viewBox="0 0 24 24"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg>
      </button>
      <button id="toolLaser" class="tb-btn tool-btn" title="Laser pointer — strokes fade a few seconds after you stop" aria-label="Laser pointer">
        <svg viewBox="0 0 24 24"><circle cx="7" cy="17" r="2.2"/><path d="m9.2 14.8 11-11"/><path d="M7 12.2V9.5"/><path d="M11.8 17h2.7"/><path d="m3.6 13.6-1.9-1.9"/><path d="m10.4 20.4 1.9 1.9"/></svg>
      </button>
    </div>

    <div class="pen-anchor">
      <button id="penToggle" class="tb-btn pen-toggle hidden" title="Pen colour and size" aria-haspopup="true" aria-expanded="false">
        <span id="penSwatch" class="pen-swatch"></span>
        <span id="penSizeVal">2 px</span>
        <svg class="caret" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
      </button>

      <div class="params hidden" id="penParams" role="dialog" aria-label="Pen settings">
        <div class="param-title">Pen</div>
        <div class="swatch-row" id="penSwatches">
          <button class="swatch selected" data-color="#e03131" style="background:#e03131" aria-label="Red"></button>
          <button class="swatch" data-color="#f76707" style="background:#f76707" aria-label="Orange"></button>
          <button class="swatch" data-color="#f59f00" style="background:#f59f00" aria-label="Amber"></button>
          <button class="swatch" data-color="#2f9e44" style="background:#2f9e44" aria-label="Green"></button>
          <button class="swatch" data-color="#1971c2" style="background:#1971c2" aria-label="Blue"></button>
          <button class="swatch" data-color="#ae3ec9" style="background:#ae3ec9" aria-label="Purple"></button>
        </div>
        <input type="color" id="penColor" value="#e03131" class="visually-hidden">
        <div class="param-row">
          <span class="param-label">Size</span>
          <input type="range" id="penSize" min="1" max="20" value="2">
          <span id="penSizeReadout">2 px</span>
        </div>
      </div>
    </div>

    <div class="pen-anchor">
      <button id="hlToggle" class="tb-btn pen-toggle hidden" title="Highlighter colour and size" aria-haspopup="true" aria-expanded="false">
        <span id="hlSwatch" class="pen-swatch" style="background:#ffd43b"></span>
        <span id="hlSizeVal">14 px</span>
        <svg class="caret" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
      </button>

      <div class="params hidden" id="hlParams" role="dialog" aria-label="Highlighter settings">
        <div class="param-title">Highlighter</div>
        <div class="swatch-row" id="hlSwatches">
          <button class="swatch selected" data-color="#ffd43b" style="background:#ffd43b" aria-label="Yellow"></button>
          <button class="swatch" data-color="#69db7c" style="background:#69db7c" aria-label="Green"></button>
          <button class="swatch" data-color="#4dabf7" style="background:#4dabf7" aria-label="Blue"></button>
          <button class="swatch" data-color="#f783ac" style="background:#f783ac" aria-label="Pink"></button>
          <button class="swatch" data-color="#ff922b" style="background:#ff922b" aria-label="Orange"></button>
        </div>
        <input type="color" id="hlColor" value="#ffd43b" class="visually-hidden">
        <div class="param-row">
          <span class="param-label">Size</span>
          <input type="range" id="hlSize" min="6" max="40" value="14">
          <span id="hlSizeReadout">14 px</span>
        </div>
      </div>
    </div>

    <div class="pen-anchor">
      <button id="eraserToggle" class="tb-btn pen-toggle hidden" title="Eraser options" aria-haspopup="true" aria-expanded="false">
        <span id="eraserModeLabel">Stroke</span>
        <span id="eraserSizeVal">24 px</span>
        <svg class="caret" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
      </button>

      <div class="params hidden" id="eraserParams" role="dialog" aria-label="Eraser settings">
        <div class="param-title">Eraser</div>
        <div class="param-row eraser-modes" id="eraserModes">
          <button class="mode-btn active" data-mode="stroke">Whole stroke</button>
          <button class="mode-btn" data-mode="partial">Partial</button>
        </div>
        <div class="param-row">
          <span class="param-label">Size</span>
          <input type="range" id="eraserSize" min="6" max="80" value="24">
          <span id="eraserSizeReadout">24 px</span>
        </div>
      </div>
    </div>

    <div class="pen-anchor">
      <button id="laserToggle" class="tb-btn pen-toggle hidden" title="Laser options" aria-haspopup="true" aria-expanded="false">
        <span class="pen-swatch" style="background:#ff3b30"></span>
        <span id="laserVal">2 px &middot; 3 s</span>
        <svg class="caret" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
      </button>

      <div class="params hidden" id="laserParams" role="dialog" aria-label="Laser settings">
        <div class="param-title">Laser pointer</div>
        <div class="param-row">
          <span class="param-label">Width</span>
          <input type="range" id="laserWidth" min="2" max="14" value="2">
          <span id="laserWidthReadout">2 px</span>
        </div>
        <div class="param-row">
          <span class="param-label">Fade after</span>
          <input type="range" id="laserFade" min="1" max="15" value="3">
          <span id="laserFadeReadout">3 s</span>
        </div>
      </div>
    </div>

    <div class="tb-spacer"></div>

    <button id="btnUndo" class="tb-btn" title="Undo (Ctrl+Z)" aria-label="Undo" disabled>
      <svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>
    </button>
    <button id="btnRedo" class="tb-btn" title="Redo (Ctrl+Y)" aria-label="Redo" disabled>
      <svg viewBox="0 0 24 24"><path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/></svg>
    </button>

    <button id="btnClearPage" class="tb-btn" title="Clear annotations on this page" aria-label="Clear annotations on this page">
      <svg viewBox="0 0 24 24"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M15 2v5h5"/><path d="m9.5 12.5 5 5"/><path d="m14.5 12.5-5 5"/></svg>
    </button>
    <button id="btnClearAll" class="tb-btn" title="Clear annotations in whole file" aria-label="Clear annotations in whole file">
      <svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
    </button>
  </div>

  <div id="findBar" class="find-bar hidden">
    <input type="text" id="findInput" placeholder="Find in document…">
    <button id="findPrev" class="tb-btn" title="Previous match" aria-label="Previous match">
      <svg viewBox="0 0 24 24"><path d="m18 15-6-6-6 6"/></svg>
    </button>
    <button id="findNext" class="tb-btn" title="Next match" aria-label="Next match">
      <svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
    </button>
    <span id="findMatchCount" class="find-count"></span>
  </div>

  <div id="error" class="hidden" role="alert">
    <svg class="error-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>
    <span id="errorText"></span>
    <button id="errorDismiss" class="tb-btn error-dismiss" title="Dismiss" aria-label="Dismiss error">
      <svg viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
    </button>
  </div>

  <div id="mainContainer">
    <aside id="sidebar" class="sidebar hidden">
      <div class="sidebar-header">
        <button id="sidebarOutlineBtn" class="sidebar-tab active">Chapters</button>
        <button id="sidebarThumbnailBtn" class="sidebar-tab">Thumbnails</button>
      </div>
      <div id="sidebarContent" class="sidebar-content">
        <div id="outlineView" class="sidebar-view"></div>
        <div id="thumbnailView" class="sidebar-view hidden"></div>
      </div>
    </aside>
    <main id="viewerWrapper">
      <div id="viewerContainer">
        <div id="viewer" class="pdfViewer"></div>
      </div>
      <canvas id="laserCanvas" aria-hidden="true"></canvas>
    </main>
  </div>
  <div id="drawCursor" class="draw-cursor hidden"></div>
</div>
<script type="module" src="${mediaUri("main.js")}"></script>
</body>
</html>`;
  }
}

function uint8ArrayToBase64(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function base64ToUint8Array(base64) {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

function activate(context) {
  const output = vscode.window.createOutputChannel("PDF Pen Annotator");
  context.subscriptions.push(output);
  output.appendLine("PDF Pen Annotator activated");
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      PdfAnnotatorProvider.viewType,
      new PdfAnnotatorProvider(context, output),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    )
  );
}

function deactivate() {}

module.exports = { activate, deactivate };

