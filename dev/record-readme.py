"""README screenshots and GIFs for PDF Pen Annotator, filmed in a real VS Code window (light theme).

    python dev/record-readme.py                 list the scenes
    python dev/record-readme.py pen find        record some scenes
    python dev/record-readme.py all             record everything into media/readme/

Scenes (output in media/readme/):
    pen            pen.gif           pick the pen, underline and circle, change colour in the popover, draw again
    highlighter    highlighter.gif   highlight lines in two colours, then on the dark panel
    eraser         eraser.gif        erase whole strokes, then Undo brings them back
    laser          laser.gif         laser pointer strokes that fade on their own
    annotated      annotated.png     a page with pen and highlighter notes
    pen-options    pen-options.png   the pen colour and size popover
    sidebar        sidebar.png       the thumbnails sidebar
    find           find.png          the find bar with matches
    dark-highlight dark-highlight.png  highlighter on the dark panel, zoomed in

How it works: every scene starts a fresh VS Code with a throwaway profile (user data, extensions and a "demo"
folder under %TEMP%/pdf-pen-annotator-readme, never your real profile), loads this extension with
--extensionDevelopmentPath, opens demo/demo.pdf (a copy of dev/demo.pdf; rebuild it with
python dev/make-demo-pdf.py) and drives it over the Chrome DevTools Protocol with Playwright. Mouse input is real
(trusted) input, so strokes land exactly where the script aims. Screenshots do not include the OS cursor, so a drawn
arrow (with a ring on clicks) shows where the mouse is; in drawing modes the extension's own cursor shows instead.
GIFs are filmed frame by frame on a virtual clock (12 fps) and built with ffmpeg (palette). Only the VS Code process
started here is closed afterwards.

Needs: Python 3 with playwright, VS Code (CODE env var or the default per-user install), ffmpeg on PATH (or FFMPEG).
"""
import json
import math
import os
import random
import shutil
import socket
import subprocess
import sys
import tempfile
import time

from playwright.sync_api import sync_playwright

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(REPO, "media", "readme")
DEMO_PDF = os.path.join(REPO, "dev", "demo.pdf")
CODE = os.environ.get("CODE") or os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "Microsoft VS Code",
                                               "Code.exe")
FFMPEG = os.environ.get("FFMPEG") or shutil.which("ffmpeg")
BASE = os.path.join(tempfile.gettempdir(), "pdf-pen-annotator-readme")
WIN_W, WIN_H = 1280, 780          # CSS px of the VS Code window
SCALE = 2                         # device scale factor (PNGs are 2560 x 1560)
FPS = 12
GIF_W = 960
PAGE_W, PAGE_H = 960, 540         # demo.pdf page size in PDF points

SETTINGS = {
    "workbench.colorTheme": "Default Light Modern",
    "workbench.startupEditor": "none",
    "workbench.tips.enabled": False,
    "workbench.enableExperiments": False,
    "workbench.welcomePage.walkthroughs.openOnInstall": False,
    "workbench.secondarySideBar.defaultVisibility": "hidden",
    "workbench.layoutControl.enabled": False,
    "workbench.editor.empty.hint": "hidden",
    "window.titleBarStyle": "custom",
    "window.restoreWindows": "none",
    "window.commandCenter": True,
    "editor.minimap.enabled": False,
    "breadcrumbs.enabled": False,
    "security.workspace.trust.enabled": False,
    "update.mode": "none",
    "update.showReleaseNotes": False,
    "telemetry.telemetryLevel": "off",
    "extensions.ignoreRecommendations": True,
    "extensions.autoCheckUpdates": False,
    "extensions.autoUpdate": False,
    "git.enabled": False,
    "files.hotExit": "off",
    "chat.disableAIFeatures": True,
    "chat.commandCenter.enabled": False,
}

# ---- overlays drawn in the VS Code window (not in the extension) --------------------------------------------------

OVERLAY = """(() => {
  if (document.getElementById('recCursor')) return 1;
  // Plain DOM calls: the workbench enforces Trusted Types, so no innerHTML.
  const c = document.createElement('div'); c.id = 'recCursor';
  c.style.cssText = 'position:fixed;left:-60px;top:-60px;width:0;height:0;z-index:2147483647;pointer-events:none';
  const ring = document.createElement('div'); ring.className = 'ring';
  ring.style.cssText = 'position:absolute;left:-15px;top:-15px;width:30px;height:30px;border-radius:50%;'
    + 'border:3px solid rgba(0,120,212,.9);background:rgba(0,120,212,.16);opacity:0';
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'arrow');
  svg.setAttribute('width', '22'); svg.setAttribute('height', '30'); svg.setAttribute('viewBox', '0 0 22 30');
  svg.style.cssText = 'position:absolute;left:-2px;top:-1px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))';
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'M2 2 L2 24 L8 18.5 L12.2 27.5 L16 25.8 L11.9 17 L19.5 17 Z');
  path.setAttribute('fill', '#111'); path.setAttribute('stroke', '#fff'); path.setAttribute('stroke-width', '1.8');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path); c.appendChild(ring); c.appendChild(svg);
  document.body.appendChild(c);
  const cap = document.createElement('div'); cap.id = 'recCaption';
  cap.style.cssText = 'position:fixed;left:50%;bottom:44px;transform:translateX(-50%);z-index:2147483646;pointer-events:none;'
    + 'background:rgba(17,24,39,.9);color:#fff;font:600 16px/1.2 "Segoe UI",sans-serif;padding:9px 18px;border-radius:8px;'
    + 'box-shadow:0 4px 14px rgba(0,0,0,.25);white-space:nowrap;display:none';
  document.body.appendChild(cap);
  return 1; })()"""


def set_window_size(pid, w, h, dw, dh):
    """Resizes the VS Code window of process pid (physical px). dw/dh: inner size still missing (first call: 0)."""
    import ctypes
    from ctypes import wintypes
    user32 = ctypes.windll.user32
    try:
        user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    except Exception:
        pass
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _):
        p = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(p))
        if p.value == pid and user32.IsWindowVisible(hwnd):
            n = user32.GetWindowTextLengthW(hwnd)
            buf = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, buf, n + 1)
            if "Visual Studio Code" in buf.value:
                found.append(hwnd)
        return True

    user32.EnumWindows(cb, 0)
    if not found:
        print("  window not found for resize")
        return
    hwnd = found[0]
    user32.ShowWindow(hwnd, 9)                      # SW_RESTORE (not maximised)
    r = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    if dw or dh:
        w, h = r.right - r.left + int(dw), r.bottom - r.top + int(dh)
    user32.SetWindowPos(hwnd, 0, 16, 8, int(w), int(h), 0x0004 | 0x0010)   # NOZORDER | NOACTIVATE


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


# ---- film -----------------------------------------------------------------------------------------------------------

class Film:
    """Frames on a virtual clock: each snap() is one frame shown for a given time."""

    def __init__(self, page):
        self.page = page
        self.frames = []           # (png bytes, seconds shown)
        self.on = False

    def snap(self, dur=1 / FPS):
        if not self.on:
            return
        self.frames.append([self.page.screenshot(type="png", scale="css"), dur])

    def gif(self, name, hold=1.5):
        if not FFMPEG:
            raise SystemExit("ffmpeg not found. Put it on PATH or set FFMPEG.")
        if self.frames:
            self.frames[-1][1] += hold
        tmp = tempfile.mkdtemp(prefix="pdfpen-gif-")
        try:
            # Resample to a constant 12 fps sequence (each shot repeated for as many ticks as it is shown); the
            # GIF encoder then merges repeats into one long frame.
            n, t = 0, 0.0
            for data, dur in self.frames:
                t += dur
                while n < round(t * FPS) or (n == 0):
                    with open(os.path.join(tmp, f"f{n:05d}.png"), "wb") as fh:
                        fh.write(data)
                    n += 1
            out = os.path.join(OUT, name)
            vf = (f"scale={GIF_W}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];"
                  "[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle")
            subprocess.run([FFMPEG, "-v", "error", "-y", "-framerate", str(FPS), "-i", "f%05d.png", "-vf", vf,
                            "-loop", "0", out], cwd=tmp, check=True)
            print(f"  saved {name}: {n / FPS:.1f} s, {len(self.frames)} shots, {size_str(os.path.getsize(out))}")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


def size_str(n):
    kb = n / 1024
    return f"{kb / 1024:.2f} MB" if kb >= 1024 else f"{kb:.0f} KB"


# ---- VS Code session ------------------------------------------------------------------------------------------------

class Session:
    def __init__(self, pw):
        self.pw = pw
        self.proc = None

    def launch(self):
        if not os.path.exists(CODE):
            raise SystemExit("VS Code not found at " + CODE + " (set CODE)")
        if not os.path.exists(DEMO_PDF):
            raise SystemExit("dev/demo.pdf is missing: run python dev/make-demo-pdf.py")
        ud, ext, demo = (os.path.join(BASE, d) for d in ("user-data", "extensions", "demo"))
        shutil.rmtree(ud, ignore_errors=True)             # a fresh throwaway profile every time
        for d in (ud, ext, demo, os.path.join(ud, "User")):
            os.makedirs(d, exist_ok=True)
        with open(os.path.join(ud, "User", "settings.json"), "w") as fh:
            json.dump(SETTINGS, fh, indent=1)
        shutil.copy(DEMO_PDF, os.path.join(demo, "demo.pdf"))
        self.port = free_port()
        args = [CODE, "--user-data-dir", ud, "--extensions-dir", ext, "--extensionDevelopmentPath=" + REPO,
                f"--remote-debugging-port={self.port}", f"--force-device-scale-factor={SCALE}",
                "--disable-features=CalculateNativeWinOcclusion", "--disable-renderer-backgrounding",
                "--disable-backgrounding-occluded-windows", "--new-window", "--skip-release-notes",
                "--disable-workspace-trust", demo]
        self.proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(60):
            try:
                self.browser = self.pw.chromium.connect_over_cdp(f"http://127.0.0.1:{self.port}")
                break
            except Exception:
                time.sleep(0.5)
        else:
            raise SystemExit("Could not connect to VS Code over CDP")
        self.page = None
        for _ in range(60):
            pages = [p for c in self.browser.contexts for p in c.pages if "workbench" in p.url]
            if pages:
                self.page = pages[0]
                break
            time.sleep(0.5)
        if not self.page:
            raise SystemExit("No VS Code window found")
        page = self.page
        page.wait_for_selector(".monaco-workbench", timeout=30000)
        # A fixed window size (Win32: Electron has no Browser.setWindowBounds)
        for _ in range(3):
            w, h = page.evaluate("[innerWidth, innerHeight]")
            if abs(w - WIN_W) <= 1 and abs(h - WIN_H) <= 1:
                break
            set_window_size(self.proc.pid, WIN_W * SCALE, WIN_H * SCALE, (WIN_W - w) * SCALE, (WIN_H - h) * SCALE)
            time.sleep(0.8)
        print("  window", page.evaluate("[innerWidth, innerHeight, devicePixelRatio]"))
        time.sleep(2.5)                                   # let the workbench settle
        # Close the side bar (Explorer)
        if page.evaluate("(() => { const s = document.querySelector('.part.sidebar'); return !!s && s.offsetWidth > 0 })()"):
            page.keyboard.press("Control+B")
            time.sleep(0.5)
        # Open demo.pdf with Quick Open (after the extension has registered its editor)
        frame = None
        for attempt in range(3):
            page.keyboard.press("Control+P")
            time.sleep(0.8)
            page.keyboard.type("demo.pdf", delay=20)
            time.sleep(1.0)
            page.keyboard.press("Enter")
            frame = self.find_frame(20)
            if frame:
                break
            # Opened as text? Close it and try again.
            page.keyboard.press("Control+W")
            time.sleep(2)
        if not frame:
            raise SystemExit("The PDF did not open in the PDF Annotator editor")
        self.f = frame
        frame.wait_for_function("() => window.__pdfAnnotator && window.__pdfAnnotator.state.editorReady"
                                " && document.querySelectorAll('.page canvas').length > 0", timeout=30000)
        time.sleep(0.6)
        frame.select_option("#scaleSelect", "page-fit")
        time.sleep(1.2)
        page.evaluate(OVERLAY)
        self.dismiss_toasts()
        page.mouse.move(WIN_W * 0.62, WIN_H * 0.62)

    def find_frame(self, secs):
        end = time.time() + secs
        while time.time() < end:
            for fr in self.page.frames:
                try:
                    if fr.evaluate("!!document.getElementById('viewerWrapper')"):
                        return fr
                except Exception:
                    pass
            time.sleep(0.4)
        return None

    def dismiss_toasts(self):
        n = self.page.evaluate("document.querySelectorAll('.notification-toast').length")
        if n:
            print("  closing", n, "notification(s)")
            self.page.evaluate("""document.querySelectorAll('.notification-toast .codicon-notifications-clear,
              .notification-toast .codicon-close').forEach(b => b.click())""")
            time.sleep(0.5)

    def close(self):
        try:
            self.browser.close()
        except Exception:
            pass
        if self.proc:
            subprocess.run(["taskkill", "/PID", str(self.proc.pid), "/T", "/F"], capture_output=True)
            self.proc = None


# ---- input and pointer ----------------------------------------------------------------------------------------------

class Scene:
    def __init__(self, sess, film):
        self.s = sess
        self.page = sess.page
        self.f = sess.f
        self.film = film
        self.x, self.y = WIN_W * 0.62, WIN_H * 0.62
        self.rng = random.Random(7)
        self.box = None
        self.arrow(True)

    # pointer overlay
    def arrow(self, show):
        self.page.evaluate(f"document.querySelector('#recCursor .arrow').style.display = '{'' if show else 'none'}'")

    def _pointer(self):
        self.page.evaluate(f"(() => {{ const c = document.getElementById('recCursor'); c.style.left = '{self.x:.1f}px';"
                           f" c.style.top = '{self.y:.1f}px'; return 1 }})()")

    def caption(self, text):
        self.page.evaluate("t => { const c = document.getElementById('recCaption'); c.textContent = t;"
                           " c.style.display = t ? '' : 'none'; }", text or "")

    def hold(self, secs):
        """Show the current state for secs (one frame)."""
        self.film.snap(secs)

    def hold_real(self, secs):
        """Film in real time (for things that animate on their own, like the laser fade)."""
        end = time.time() + secs
        last = time.time()
        while time.time() < end:
            data = self.page.screenshot(type="png", scale="css")
            now = time.time()
            if self.film.on:
                self.film.frames.append([data, now - last])
            last = now

    def move(self, x, y, secs=0.6, snap=True):
        n = max(2, int(secs * FPS))
        x0, y0 = self.x, self.y
        for i in range(1, n + 1):
            t = i / n
            e = t * t * (3 - 2 * t)
            self.x, self.y = x0 + (x - x0) * e, y0 + (y - y0) * e
            self.page.mouse.move(self.x, self.y)
            self._pointer()
            if snap:
                self.film.snap()

    def ring(self):
        for s, o in ((0.6, 1), (1.0, 0.85), (1.4, 0.55), (1.8, 0.25), (2.1, 0)):
            self.page.evaluate(f"(() => {{ const r = document.querySelector('#recCursor .ring'); r.style.transform = 'scale({s})';"
                               f" r.style.opacity = '{o}'; return 1 }})()")
            if o in (0.85, 0.25):
                self.film.snap()

    def el_center(self, sel):
        b = self.f.locator(sel).first.bounding_box()
        if not b:
            raise SystemExit("not on screen: " + sel)
        return b["x"] + b["width"] / 2, b["y"] + b["height"] / 2

    def click(self, sel, secs=0.45, after=0.15):
        x, y = self.el_center(sel)
        self.arrow(True)
        self.move(x, y, secs)
        self.page.mouse.down()
        self.page.mouse.up()
        self.ring()
        self.hold(after)

    # PDF coordinates (points, y up) on page 1 -> window CSS px
    def page_box(self, n=1):
        b = self.f.locator(f'#viewer .page[data-page-number="{n}"]').bounding_box()
        self.box = b
        return b

    def pt(self, x, y):
        b = self.box or self.page_box()
        return b["x"] + x * b["width"] / PAGE_W, b["y"] + (PAGE_H - y) * b["height"] / PAGE_H

    def stroke(self, pts_pt, speed=520, wobble=0.6, glide=0.4, smooth=True):
        """One pen-down stroke through control points (PDF pt), smoothed, with a little tremor and a human speed
        profile (slow at the ends). speed in CSS px per second of film time."""
        ctrl = [self.pt(*p) for p in pts_pt]
        dense = catmull(ctrl) if smooth and len(ctrl) > 2 else lerp_path(ctrl)
        dense = tremor(dense, wobble, self.rng)
        dense = resample(dense, 2.5)
        if glide:
            self.arrow(False)
            self.move(dense[0][0], dense[0][1], glide)
        L = max(1.0, path_len(dense))
        self.page.mouse.move(*dense[0])
        self.page.mouse.down()
        clock, s = 0.0, 0.0
        for (x0, y0), (x1, y1) in zip(dense, dense[1:]):
            d = math.hypot(x1 - x0, y1 - y0)
            s += d
            v = speed * (0.35 + 0.65 * math.sin(math.pi * min(1, s / L)))
            clock += d / v
            self.x, self.y = x1, y1
            self.page.mouse.move(x1, y1)
            if clock >= 1 / FPS:
                clock -= 1 / FPS
                self.film.snap()
        self.page.mouse.up()
        self._pointer()
        self.film.snap()


# ---- path helpers ---------------------------------------------------------------------------------------------------

def catmull(pts, per=14):
    p = [pts[0]] + pts + [pts[-1]]
    out = []
    for i in range(1, len(p) - 2):
        p0, p1, p2, p3 = p[i - 1], p[i], p[i + 1], p[i + 2]
        n = max(4, int(math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 3))
        for k in range(n):
            t = k / n
            t2, t3 = t * t, t * t * t
            out.append(tuple(0.5 * ((2 * p1[j]) + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2
                                    + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3) for j in (0, 1)))
    out.append(pts[-1])
    return out


def lerp_path(pts):
    out = []
    for a, b in zip(pts, pts[1:]):
        n = max(2, int(math.hypot(b[0] - a[0], b[1] - a[1]) / 3))
        out += [(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n) for k in range(n)]
    out.append(pts[-1])
    return out


def tremor(pts, amp, rng):
    if amp <= 0 or len(pts) < 3:
        return pts
    ph1, ph2 = rng.uniform(0, 6.28), rng.uniform(0, 6.28)
    out, s = [], 0.0
    for i, (x, y) in enumerate(pts):
        if i:
            s += math.hypot(x - pts[i - 1][0], y - pts[i - 1][1])
        a, b = pts[max(0, i - 1)], pts[min(len(pts) - 1, i + 1)]
        dx, dy = b[0] - a[0], b[1] - a[1]
        d = math.hypot(dx, dy) or 1
        nx, ny = -dy / d, dx / d
        o = amp * (math.sin(s / 23 + ph1) * 0.7 + math.sin(s / 9 + ph2) * 0.3)
        out.append((x + nx * o, y + ny * o))
    return out


def resample(pts, step):
    out = [pts[0]]
    acc = 0.0
    for a, b in zip(pts, pts[1:]):
        d = math.hypot(b[0] - a[0], b[1] - a[1])
        acc += d
        if acc >= step:
            out.append(b)
            acc = 0.0
    if out[-1] != pts[-1]:
        out.append(pts[-1])
    return out


def path_len(pts):
    return sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:]))


# ---- shapes on page 1 of demo.pdf (PDF points, y up) ----------------------------------------------------------------

def underline(x1, x2, y, rise=1.5, sag=1.2):
    w = x2 - x1
    return [(x1, y + 0.5), (x1 + w * 0.3, y - sag * 0.4), (x1 + w * 0.65, y - sag), (x2, y + rise)]


def ellipse(cx, cy, rx, ry, start=200, sweep=395, tilt=-3, n=16):
    pts = []
    r = random.Random(int(cx * 7 + cy))
    for k in range(n + 1):
        a = math.radians(start - sweep * k / n)
        f = 1 + r.uniform(-0.035, 0.035) + 0.05 * k / n          # spirals out a little at the end
        x, y = rx * f * math.cos(a), ry * f * math.sin(a)
        t = math.radians(tilt)
        pts.append((cx + x * math.cos(t) - y * math.sin(t), cy + x * math.sin(t) + y * math.cos(t)))
    return pts


def curved_arrow(x1, y1, x2, y2, bend=0.25, head=10):
    mx, my = (x1 + x2) / 2, (y1 + y2) / 2
    dx, dy = x2 - x1, y2 - y1
    cx, cy = mx - dy * bend, my + dx * bend
    shaft = [(x1, y1), ((x1 + cx) / 2 + 0.0, (y1 + cy) / 2), (cx * 0.5 + (cx + x2) / 4, cy * 0.5 + (cy + y2) / 4),
             (x2, y2)]
    shaft = [(x1, y1)] + [quad((x1, y1), (cx, cy), (x2, y2), t) for t in (0.3, 0.55, 0.8)] + [(x2, y2)]
    tx, ty = x2 - quad((x1, y1), (cx, cy), (x2, y2), 0.9)[0], y2 - quad((x1, y1), (cx, cy), (x2, y2), 0.9)[1]
    a = math.atan2(ty, tx)
    h1 = (x2 - head * math.cos(a - 0.5), y2 - head * math.sin(a - 0.5))
    h2 = (x2 - head * math.cos(a + 0.5), y2 - head * math.sin(a + 0.5))
    return [shaft, [h1, (x2, y2), h2]]


def quad(p0, p1, p2, t):
    return ((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0],
            (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1])


def check(x, y, s=9):
    return [(x, y + s * 0.45), (x + s * 0.35, y), (x + s * 1.1, y + s * 1.25)]


# "key!" in casual print. Units: x-height 5, ascender 10, descender -4. Each letter: (advance, [strokes]).
LETTERS = {
    "k": (4.6, [[(0, 10.2), (-0.1, 4), (0, 0)], [(3.6, 5.4), (0.4, 2.4), (4.1, -0.1)]]),
    "e": (4.4, [[(0.3, 2.7), (3.7, 2.9), (3.4, 4.5), (1.9, 5.1), (0.4, 3.9), (0.3, 1.3), (1.8, 0), (3.8, 0.8)]]),
    "y": (4.6, [[(0, 5), (1.9, 0.9)], [(4.1, 5.1), (2.6, 0.6), (1.2, -3.4), (-0.2, -4.0)]]),
    "!": (2.4, [[(1.0, 10.2), (0.75, 3.2)], [(0.6, 0.5), (0.75, 0.0)]]),
}


def word_strokes(text, x, y, u=2.3, slant=0.2):
    strokes = []
    for ch in text:
        adv, ss = LETTERS[ch]
        for st in ss:
            strokes.append([(x + (px + py * slant) * u, y + py * u) for px, py in st])
        x += (adv + 1.3) * u
    return strokes


# Page 1 layout (from dev/make-demo-pdf.py)
TITLE = (56, 338, 452)              # x1, x2, baseline
FORMULA = (282, 258)                # centre of the formula
PARA2 = (134, 285, 329)             # "The gradient ∇L(w) points uphill"
PARA3 = (251, 367, 310)             # "the loss stops falling."
STEP3 = (84, 307, 96)               # "Update the weights: w ← w − η · ∇L(w)."
DARK = [(600, 836, 162), (600, 864, 134), (600, 774, 106), (600, 751, 78)]   # dark panel bullets
START_DOT = (614, 344)
MIN_DOT = (770, 275)


def pen_notes(sc, speed=560):
    """The red notes of the pen scene."""
    x1, x2, y = TITLE
    sc.stroke(underline(x1 - 2, x2 + 4, y - 10), speed=speed + 140)
    sc.stroke(ellipse(FORMULA[0], FORMULA[1] + 1, 128, 30), speed=speed + 60, wobble=0.8)


def blue_notes(sc, speed=480):
    shaft, head = curved_arrow(414, 296, 586, 352, bend=-0.22)
    sc.stroke(shaft, speed=speed + 120)
    sc.stroke(head, speed=speed - 120, smooth=False, glide=0.12)
    for i, st in enumerate(word_strokes("key!", 176, 372)):
        sc.stroke(st, speed=max(260, speed // 2), wobble=0.25, glide=0.1 if i else 0.35, smooth=len(st) > 2)
    sc.stroke(check(318, 92), speed=330, wobble=0.3, smooth=False)


def highlight(sc, x1, x2, y, size=12.5, speed=640, glide=0.4):
    yc = y + size * 0.33
    sc.stroke([(x1 - 2, yc), ((x1 + x2) / 2, yc + 0.6), (x2 + 2, yc + 0.2)], speed=speed, wobble=0.35, glide=glide)


def open_popover(sc, toggle):
    sc.click(toggle)
    sc.hold(0.3)


def pick(sc, sel):
    sc.click(sel, secs=0.45)


def close_popover(sc, toggle):
    # Clicked shut, not Escape: a key press puts Chromium in keyboard-focus mode and the page layer then shows
    # an orange :focus-visible outline.
    sc.click(toggle, secs=0.4, after=0.15)


def set_slider(sc, sel, lo, hi, value, secs=0.5):
    """Drags a range input's thumb to value."""
    b = sc.f.locator(sel).bounding_box()
    pad = 8                                           # thumb radius
    cur = float(sc.f.locator(sel).input_value())
    xs = lambda v: b["x"] + pad + (b["width"] - 2 * pad) * (v - lo) / (hi - lo)
    y = b["y"] + b["height"] / 2
    sc.arrow(True)
    sc.move(xs(cur), y, secs)
    sc.page.mouse.down()
    sc.ring()
    sc.move(xs(value), y, 0.35)
    sc.page.mouse.up()
    sc.film.snap()


def preset(sc, sel, value):
    """Sets a size slider before filming (as a returning user would have it)."""
    sc.f.evaluate("([s, v]) => { const e = document.querySelector(s); e.value = v;"
                  " e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }",
                  [sel, str(value)])


def tool(sc, name):
    sc.click({"pen": "#toolPen", "hl": "#toolHighlighter", "eraser": "#toolEraser", "laser": "#toolLaser",
              "none": "#toolNone"}[name])


def park(sc, secs=0.5):
    """Move the arrow off the page, to the toolbar's empty area."""
    x, y = sc.el_center("#btnUndo")
    sc.arrow(True)
    sc.move(x - 120, y + 2, secs)


# ---- scenes ---------------------------------------------------------------------------------------------------------

def scene_pen(sc):
    sc.hold(0.4)
    sc.caption("Pick the pen and write on the page")
    tool(sc, "pen")
    pen_notes(sc)
    sc.caption("Colour and size live in the pen popover")
    open_popover(sc, "#penToggle")
    pick(sc, '#penSwatches .swatch[data-color="#1971c2"]')
    set_slider(sc, "#penSize", 1, 20, 4)
    sc.hold(0.3)
    close_popover(sc, "#penToggle")
    sc.caption("Mouse or stylus, both work")
    blue_notes(sc)
    park(sc, 0.4)
    sc.caption("Ctrl+S saves the ink into the PDF")
    sc.hold(0.9)


def scene_highlighter(sc):
    sc.hold(0.5)
    sc.caption("The highlighter keeps text readable")
    tool(sc, "hl")
    highlight(sc, *PARA2)
    highlight(sc, *PARA3, glide=0.3)
    sc.caption("It works on dark backgrounds too")
    time.sleep(1.6)                       # (not filmed) let the light-page burst end: blend is chosen per burst
    highlight(sc, *DARK[1], size=14, glide=0.6)
    sc.hold(0.5)
    sc.caption("Pick another colour")
    open_popover(sc, "#hlToggle")
    pick(sc, '#hlSwatches .swatch[data-color="#69db7c"]')
    close_popover(sc, "#hlToggle")
    highlight(sc, *STEP3)
    park(sc, 0.4)
    sc.caption("")
    time.sleep(0.8)
    sc.hold(1.0)


def scene_eraser(sc):
    # Notes drawn before filming starts
    sc.film.on = False
    tool(sc, "pen")
    pen_notes(sc, speed=4000)
    open_popover(sc, "#penToggle")
    pick(sc, '#penSwatches .swatch[data-color="#1971c2"]')
    close_popover(sc, "#penToggle")
    blue_notes(sc, speed=4000)
    tool(sc, "none")
    park(sc, 0.1)
    time.sleep(0.8)
    sc.film.on = True
    sc.hold(0.8)
    sc.caption("The eraser removes whole strokes")
    tool(sc, "eraser")
    x1, x2, y = TITLE
    sc.stroke([(x1 + 30, y - 26), (x1 + 60, y - 4)], speed=380, wobble=0)          # through the underline
    sc.stroke([(160, 222), (210, 300), (380, 228)], speed=520, wobble=0)            # through the circle
    sc.stroke([(168, 386), (200, 379), (236, 388)], speed=300, wobble=0, glide=0.5)  # through "key!"
    sc.hold(0.6)
    sc.caption("Undo (Ctrl+Z) brings them back")
    for _ in range(3):                    # one Undo per eraser swipe
        sc.click("#btnUndo", secs=0.4, after=0.45)
    park(sc, 0.4)
    sc.hold(1.0)


def scene_laser(sc):
    sc.hold(0.8)
    sc.caption("Laser pointer: point things out without touching the PDF")
    tool(sc, "laser")
    sx, sy = START_DOT
    sc.stroke(ellipse(sx, sy, 22, 18, start=150, sweep=380, tilt=0, n=12), speed=520, wobble=0.6)
    mx, my = MIN_DOT
    shaft, head = curved_arrow(sx + 26, sy - 6, mx - 4, my + 14, bend=0.18, head=12)
    sc.stroke(shaft, speed=520, glide=0.25)
    sc.stroke(head, speed=380, smooth=False, glide=0.1)
    x1, x2, y = DARK[1]
    sc.stroke(underline(x1 - 4, x2 + 4, y - 7), speed=560, glide=0.35)
    sc.caption("The strokes fade a few seconds after you stop")
    sc.hold_real(4.6)
    sc.hold(0.6)


def shot_annotated(sc):
    tool(sc, "pen")
    pen_notes(sc, speed=4000)
    open_popover(sc, "#penToggle")
    pick(sc, '#penSwatches .swatch[data-color="#1971c2"]')
    close_popover(sc, "#penToggle")
    blue_notes(sc, speed=4000)
    tool(sc, "hl")
    highlight(sc, *PARA2, speed=4000)
    highlight(sc, *PARA3, speed=4000)
    open_popover(sc, "#hlToggle")
    pick(sc, '#hlSwatches .swatch[data-color="#69db7c"]')
    close_popover(sc, "#hlToggle")
    highlight(sc, *STEP3, speed=4000)
    time.sleep(1.7)
    open_popover(sc, "#hlToggle")
    pick(sc, '#hlSwatches .swatch[data-color="#ffd43b"]')
    close_popover(sc, "#hlToggle")
    highlight(sc, *DARK[1], size=14, speed=4000)
    tool(sc, "none")
    park(sc, 0.1)
    time.sleep(2.0)


def shot_pen_options(sc):
    tool(sc, "pen")
    pen_notes(sc, speed=4000)
    open_popover(sc, "#penToggle")
    pick(sc, '#penSwatches .swatch[data-color="#1971c2"]')
    sc.arrow(False)
    time.sleep(0.8)


def shot_sidebar(sc):
    shot_annotated(sc)
    sc.click("#sidebarToggle")
    time.sleep(0.6)
    sc.click("#sidebarThumbnailBtn")
    park(sc, 0.1)
    sc.arrow(False)
    time.sleep(2.5)


def shot_find(sc):
    sc.click("#btnFind")
    sc.f.locator("#findInput").press_sequentially("gradient", delay=60)
    time.sleep(1.0)
    sc.f.select_option("#scaleSelect", "page-fit")        # refit: the find bar took some height
    sc.f.locator("#findInput").focus()
    sc.page.keyboard.press("Enter")
    sc.arrow(False)
    time.sleep(1.5)


def shot_dark(sc):
    tool(sc, "hl")
    time.sleep(0.3)
    for i, (x1, x2, y) in enumerate(DARK[:3]):
        if i:
            open_popover(sc, "#hlToggle")
            pick(sc, ['', '#hlSwatches .swatch[data-color="#f783ac"]', '#hlSwatches .swatch[data-color="#69db7c"]'][i])
            close_popover(sc, "#hlToggle")
        time.sleep(1.7)
        highlight(sc, x1, x2, y, size=14, speed=4000)
    time.sleep(1.7)
    tool(sc, "none")
    park(sc, 0.1)
    sc.arrow(False)
    # Zoom to 150% (as if picked from the zoom list) and centre the dark panel
    sc.f.select_option("#scaleSelect", "1.5")
    time.sleep(1.5)
    sc.f.evaluate("""() => { const c = document.getElementById('viewerContainer');
      const p = document.querySelector('#viewer .page[data-page-number="1"]');
      const k = p.clientWidth / 960, cx = 732 * k, cy = (540 - 138) * k;
      c.scrollLeft = p.offsetLeft + cx - c.clientWidth / 2; c.scrollTop = p.offsetTop + cy - c.clientHeight / 2; }""")
    time.sleep(2.0)


SCENES = {
    "pen": ("pen.gif", scene_pen),
    "highlighter": ("highlighter.gif", scene_highlighter),
    "eraser": ("eraser.gif", scene_eraser),
    "laser": ("laser.gif", scene_laser),
    "annotated": ("annotated.png", shot_annotated),
    "pen-options": ("pen-options.png", shot_pen_options),
    "sidebar": ("sidebar.png", shot_sidebar),
    "find": ("find.png", shot_find),
    "dark-highlight": ("dark-highlight.png", shot_dark),
}


def record(pw, name):
    out, fn = SCENES[name]
    print(name)
    sess = Session(pw)
    try:
        sess.launch()
        film = Film(sess.page)
        sc = Scene(sess, film)
        sc.page_box()
        preset(sc, "#penSize", 3)                          # a slightly bolder pen than the 2 px default
        film.on = out.endswith(".gif")
        t0 = time.time()
        fn(sc)
        sc.caption("")
        err = sess.f.evaluate("(() => { const e = document.getElementById('error'); "
                              "return e && !e.classList.contains('hidden') ? e.textContent.trim() : null })()")
        if err:
            print("  extension error banner:", err)
        sess.dismiss_toasts()
        if out.endswith(".gif"):
            film.gif(out)
        else:
            path = os.path.join(OUT, out)
            sess.page.evaluate("document.getElementById('recCursor').style.display = 'none'")
            sess.page.screenshot(path=path, type="png")
            print(f"  saved {out}: {size_str(os.path.getsize(path))}")
        print(f"  took {time.time() - t0:.0f} s")
    finally:
        sess.close()


def main():
    want = sys.argv[1:]
    if not want:
        print(__doc__)
        print("Scenes:", ", ".join(SCENES))
        return
    if want == ["all"]:
        want = list(SCENES)
    bad = [w for w in want if w not in SCENES]
    if bad:
        raise SystemExit("Unknown scene: " + ", ".join(bad))
    os.makedirs(OUT, exist_ok=True)
    with sync_playwright() as pw:
        for name in want:
            record(pw, name)


if __name__ == "__main__":
    main()
