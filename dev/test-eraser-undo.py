"""Checks that Undo and Redo fully reverse the eraser, in the browser test harness.

    python dev/test-eraser-undo.py            (starts dev/server.js itself if port 8765 is free)

Draws pen strokes with real (trusted) mouse input, erases them in Whole-stroke and Partial mode, and compares the
ink on page 1 before and after Undo / Redo. One eraser swipe must be exactly one undo step.
"""
import json
import os
import socket
import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
URL = "http://localhost:8765/"

INK = """() => {
  const ui = window.__pdfAnnotator.uiManager;
  const out = [];
  for (const ed of ui.getEditors(0)) {
    if (ed.deleted || ed.isEmpty?.()) continue;
    let d; try { d = ed.serialize(true); } catch { continue; }
    if (!d?.paths?.points) continue;
    for (const p of d.paths.points) out.push(p.length / 2 + '@' + Math.round(p[0]) + ',' + Math.round(p[1]));
  }
  return out.sort();
}"""


def port_open(port):
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) == 0


def main():
    server = None
    if not port_open(8765):
        server = subprocess.Popen(["node", os.path.join(HERE, "server.js")], cwd=REPO,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):
            if port_open(8765):
                break
            time.sleep(0.1)
    failures = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            page = browser.new_page(viewport={"width": 1200, "height": 1700})
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(URL)
            # polling by time: the harness replaces requestAnimationFrame, which Playwright's default polling uses
            page.wait_for_function("() => !!(window.__pdfAnnotator?.uiManager && "
                                   "document.querySelector('.page[data-page-number=\"1\"] canvas'))",
                                   polling=200, timeout=20000)
            time.sleep(1.0)
            box = page.locator('.page[data-page-number="1"]').bounding_box()
            assert box["y"] + box["height"] <= 1700, "page 1 must fit in the window so every stroke point is on screen"
            X = lambda fx: box["x"] + box["width"] * fx
            Y = lambda fy: box["y"] + box["height"] * fy

            def ink():
                return page.evaluate(INK)

            def drag(points, steps=6):
                page.mouse.move(*points[0])
                page.mouse.down()
                for p in points[1:]:
                    page.mouse.move(*p, steps=steps)
                page.mouse.up()
                time.sleep(0.15)

            def settle():
                time.sleep(0.6)

            def undo():
                page.click("#btnUndo")
                settle()

            def redo():
                page.click("#btnRedo")
                settle()

            def check(label, got, want):
                ok = got == want
                print(("PASS " if ok else "FAIL ") + label + ("" if ok else f"\n   got  {got}\n   want {want}"))
                if not ok:
                    failures.append(label)

            # Three horizontal pen strokes in one drawing session (one editor), one more in a later session.
            page.click("#toolPen")
            for fy in (0.30, 0.36, 0.42):
                drag([(X(0.20), Y(fy)), (X(0.45), Y(fy + 0.01)), (X(0.70), Y(fy))])
            page.click("#toolNone")
            settle()
            page.click("#toolPen")
            drag([(X(0.20), Y(0.55)), (X(0.70), Y(0.56))])
            page.click("#toolNone")
            settle()
            drawn = ink()
            print("drawn strokes:", len(drawn))
            if len(drawn) != 4:
                failures.append("setup: expected 4 strokes")

            # 1. Whole-stroke: one vertical swipe through all four strokes, then Undo, Redo, Undo.
            page.click("#toolEraser")
            page.evaluate("document.querySelector('#eraserModes [data-mode=stroke]').click()")
            drag([(X(0.45), Y(0.25)), (X(0.45), Y(0.60))], steps=20)
            settle()
            erased = ink()
            check("whole-stroke swipe removes all 4 strokes", len(erased), 0)
            undo()
            check("one Undo restores every stroke of the swipe", ink(), drawn)
            redo()
            check("Redo erases them again", ink(), erased)
            undo()
            check("Undo after Redo restores them", ink(), drawn)

            # 2. Two separate swipes are two undo steps.
            page.click("#toolEraser")
            drag([(X(0.30), Y(0.28)), (X(0.30), Y(0.32))], steps=8)       # first stroke only
            settle()
            after1 = ink()
            check("first short swipe removed one stroke", len(after1), 3)
            drag([(X(0.60), Y(0.53)), (X(0.60), Y(0.58))], steps=8)       # the separate stroke
            settle()
            check("two swipes removed two strokes", len(ink()), 2)
            undo()
            check("first Undo restores only the second swipe", ink(), after1)
            undo()
            check("second Undo restores the first swipe", ink(), drawn)

            # 2b. Consecutive swipes on ONE multi-stroke drawing: every swipe creates a replacement editor. PDF.js
            #     records its own "editor added" undo step whenever an ink editor is placed on the page; those
            #     hidden steps must not land on the undo stack, or the second Undo does nothing.
            drag([(X(0.30), Y(0.28)), (X(0.30), Y(0.32))], steps=8)       # top stroke of the 3-stroke drawing
            settle()
            s1 = ink()
            drag([(X(0.35), Y(0.34)), (X(0.35), Y(0.38))], steps=8)       # middle stroke
            settle()
            s2 = ink()
            drag([(X(0.40), Y(0.40)), (X(0.40), Y(0.44))], steps=8)       # bottom stroke
            settle()
            check("three swipes on one drawing removed three strokes", len(ink()), 1)
            undo()
            check("Undo 1 of 3 restores the last swipe", ink(), s2)
            undo()
            check("Undo 2 of 3 restores the middle swipe", ink(), s1)
            undo()
            check("Undo 3 of 3 restores the first swipe", ink(), drawn)

            # 3. Partial: cut through the middle of all strokes, then one Undo.
            page.evaluate("document.querySelector('#eraserModes [data-mode=partial]').click()")
            drag([(X(0.45), Y(0.25)), (X(0.45), Y(0.60))], steps=20)
            settle()
            cut = ink()
            check("partial swipe splits strokes (more, shorter pieces)", len(cut) > len(drawn), True)
            undo()
            check("one Undo restores the partial swipe", ink(), drawn)
            redo()
            check("Redo re-applies the partial swipe", ink(), cut)
            undo()

            # 4. Partial erase of a single stroke twice in one swipe (zig-zag), then Undo.
            drag([(X(0.30), Y(0.53)), (X(0.30), Y(0.58)), (X(0.50), Y(0.53)), (X(0.50), Y(0.58))], steps=10)
            settle()
            undo()
            check("one Undo restores a zig-zag partial swipe", ink(), drawn)

            # 5. Ink saved in the PDF earlier (existing annotations): erase, Undo, save, reload.
            def save():
                n = page.evaluate("() => window.__harnessLog.length")
                page.evaluate("() => window.postMessage({type: 'getFileData', requestId: 't'}, '*')")
                page.wait_for_function(f"() => window.__harnessLog.slice({n}).some(m => m.type === 'response')",
                                       polling=200, timeout=20000)
                return page.evaluate(f"() => window.__harnessLog.slice({n}).find(m => m.type === 'response').data")

            def load(b64):
                page.click("#toolNone")
                page.evaluate("(d) => window.postMessage({type: 'load', data: d}, '*')", b64)
                time.sleep(2.5)

            def saved_ink_count():
                return page.evaluate("""async () => {
                  const doc = window.__pdfAnnotator.pdfViewer.pdfDocument;
                  const annots = await (await doc.getPage(1)).getAnnotations();
                  return annots.filter(a => a.subtype === 'Ink').length; }""")

            page.click("#toolEraser")
            page.evaluate("document.querySelector('#eraserModes [data-mode=stroke]').click()")
            drag([(X(0.45), Y(0.25)), (X(0.45), Y(0.60))], steps=20)       # clear the page
            settle()
            page.click("#toolPen")
            drag([(X(0.20), Y(0.30)), (X(0.70), Y(0.31))])
            page.click("#toolNone")
            settle()
            page.click("#toolPen")
            drag([(X(0.20), Y(0.40)), (X(0.70), Y(0.41))])
            page.click("#toolNone")
            settle()
            b1 = save()
            load(b1)
            check("saved PDF holds 2 ink annotations", saved_ink_count(), 2)

            page.click("#toolEraser")
            settle()
            drag([(X(0.45), Y(0.27)), (X(0.45), Y(0.34))], steps=10)        # erase the saved top stroke
            settle()
            load(save())
            check("erasing saved ink removes it from the PDF", saved_ink_count(), 1)

            load(b1)
            page.click("#toolEraser")
            settle()
            drag([(X(0.45), Y(0.27)), (X(0.45), Y(0.34))], steps=10)
            settle()
            undo()
            load(save())
            check("Undo of an erase of saved ink keeps it in the PDF", saved_ink_count(), 2)

            if errors:
                print("page errors:", errors)
                failures.append("page errors")
            browser.close()
    finally:
        if server:
            server.terminate()
    print("\nALL PASS" if not failures else f"\n{len(failures)} FAILED: " + "; ".join(failures))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
