"""Builds dev/demo.pdf: three tidy lecture-note pages used for the README screenshots and GIFs.

    python dev/make-demo-pdf.py

Landscape 16:9 pages (960 x 540 pt) so a whole page fits the editor at "Page Fit". Page 1 has light text, a
formula, a diagram and a dark "Key takeaways" panel (highlighter on dark backgrounds); page 2 a table and a chart;
page 3 is a dark summary slide. Only the standard PDF fonts are used (Helvetica, Times, Courier, Symbol), so the
text is searchable and nothing is embedded. Needs reportlab (pip install reportlab).
"""
import math
import os

from reportlab.lib.colors import HexColor
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "demo.pdf")
PW, PH = 960, 540
L = 56                                   # left margin
R = PW - 56                              # right margin

INK = HexColor("#1e293b")
GREY = HexColor("#64748b")
RULE = HexColor("#e2e8f0")
BLUE = HexColor("#1d4ed8")
NAVY = HexColor("#0f172a")
NAVY2 = HexColor("#1e293b")
PALE = HexColor("#e2e8f0")
AMBER = HexColor("#fbbf24")

SYMBOLS = set("θη∇←−≈→")              # drawn with the Symbol font


def rich(c, x, y, text, font="Helvetica", size=12.5, color=INK, sym_size=None):
    """Draws text, switching to the Symbol font for Greek letters and arrows. Returns the end x."""
    c.setFillColor(color)
    run, runfont = "", None
    for ch in text + "\0":
        f = "Symbol" if ch in SYMBOLS else font
        if ch == "\0" or (runfont and f != runfont):
            if run:
                sz = (sym_size or size) if runfont == "Symbol" else size
                c.setFont(runfont, sz)
                c.drawString(x, y, run)
                x += stringWidth(run, runfont, sz)
            run = ""
        if ch != "\0":
            run += ch
            runfont = f
    return x


def width(text, font="Helvetica", size=12.5):
    return sum(stringWidth(ch, "Symbol" if ch in SYMBOLS else font, size) for ch in text)


def header(c, page, title, subtitle, dark=False):
    c.setFillColor(GREY if not dark else HexColor("#94a3b8"))
    c.setFont("Helvetica-Bold", 9.5)
    c.drawString(L, 500, "M L   F O U N D A T I O N S     ·     L E C T U R E   4")
    c.setFont("Helvetica", 9.5)
    c.drawRightString(R, 24, f"{page} / 3")
    c.setFillColor(INK if not dark else HexColor("#f8fafc"))
    c.setFont("Helvetica-Bold", 34)
    c.drawString(L, 452, title)
    c.setFillColor(GREY if not dark else HexColor("#94a3b8"))
    c.setFont("Helvetica-Oblique", 15)
    c.drawString(L, 426, subtitle)
    c.setStrokeColor(RULE if not dark else HexColor("#334155"))
    c.setLineWidth(1)
    c.line(L, 408, R, 408)


def heading(c, x, y, text):
    c.setFillColor(BLUE)
    c.setFont("Helvetica-Bold", 17)
    c.drawString(x, y, text)


def para(c, x, y, lines, lead=19, size=12.5, color=INK, maxw=None):
    for i, ln in enumerate(lines):
        if maxw:
            assert width(ln, "Helvetica", size) <= maxw, (ln, width(ln, "Helvetica", size))
        rich(c, x, y - i * lead, ln, size=size, color=color)


def arrow(c, x1, y1, x2, y2, head=6):
    c.line(x1, y1, x2, y2)
    a = math.atan2(y2 - y1, x2 - x1)
    p = c.beginPath()
    p.moveTo(x2, y2)
    p.lineTo(x2 - head * math.cos(a - 0.45), y2 - head * math.sin(a - 0.45))
    p.lineTo(x2 - head * math.cos(a + 0.45), y2 - head * math.sin(a + 0.45))
    p.close()
    c.drawPath(p, stroke=0, fill=1)


def page1(c):
    header(c, 1, "Gradient Descent", "How a model learns by walking downhill")
    colw = 452

    heading(c, L, 374, "1.  The idea")
    para(c, L, 348, [
        "We want the weights w that make the loss L(w) as small as",
        "possible. The gradient ∇L(w) points uphill, so we take a small",
        "step the other way and repeat until the loss stops falling.",
    ], maxw=colw)

    # Formula box
    c.setFillColor(HexColor("#eff6ff"))
    c.setStrokeColor(HexColor("#bfdbfe"))
    c.roundRect(L, 226, colw, 64, 10, stroke=1, fill=1)
    segs = [("Times-Italic", "w"), ("Symbol", "  ←  "), ("Times-Italic", "w"), ("Symbol", "  −  "),
            ("Symbol", "η"), ("Times-Roman", " "), ("Times-Roman", "·"), ("Times-Roman", " "), ("Symbol", "∇"),
            ("Times-Italic", "L"), ("Times-Roman", "("), ("Times-Italic", "w"), ("Times-Roman", ")")]
    fs = 26
    total = sum(stringWidth(t, f, fs) for f, t in segs)
    x = L + (colw - total) / 2
    c.setFillColor(INK)
    for f, t in segs:
        c.setFont(f, fs)
        c.drawString(x, 249, t)
        x += stringWidth(t, f, fs)
    rich(c, L + 2, 206, "η is the learning rate: how big each step is.", size=11.5, color=GREY)

    heading(c, L, 168, "2.  The loop")
    steps = [
        "Start from a random guess for w.",
        "Compute the gradient ∇L(w) on a batch of data.",
        "Update the weights:  w ← w − η · ∇L(w).",
        "Repeat until the loss stops falling.",
    ]
    for i, s in enumerate(steps):
        y = 142 - i * 23
        c.setFillColor(BLUE)
        c.circle(L + 9, y + 4, 9, stroke=0, fill=1)
        c.setFillColor(HexColor("#ffffff"))
        c.setFont("Helvetica-Bold", 10.5)
        c.drawCentredString(L + 9, y + 0.5, str(i + 1))
        rich(c, L + 28, y, s)

    # Diagram: a loss curve with the steps walking down it
    ox, oy, dw, dh = 584, 262, 300, 122
    c.setStrokeColor(HexColor("#94a3b8"))
    c.setFillColor(HexColor("#94a3b8"))
    c.setLineWidth(1.2)
    arrow(c, ox, oy, ox + dw + 8, oy)
    arrow(c, ox, oy, ox, oy + dh + 10)
    c.setFillColor(GREY)
    c.setFont("Helvetica-Oblique", 11)
    c.drawString(ox + dw + 2, oy - 16, "w")
    c.drawString(ox + 8, oy + dh + 2, "loss L(w)")

    def curve_y(t):                       # t in 0..1 across the axis
        return oy + 12 + dh * 0.82 * ((t - 0.62) / 0.62) ** 2

    c.setStrokeColor(BLUE)
    c.setLineWidth(2.2)
    p = c.beginPath()
    for i in range(101):
        t = 0.04 + i / 100 * 0.94
        (p.moveTo if i == 0 else p.lineTo)(ox + t * dw, curve_y(t))
    c.drawPath(p, stroke=1, fill=0)
    pts = [0.10, 0.30, 0.44, 0.53, 0.58]
    c.setStrokeColor(HexColor("#f97316"))
    c.setFillColor(HexColor("#f97316"))
    c.setLineWidth(1.3)
    for a, b in zip(pts, pts[1:]):
        x1, y1, x2, y2 = ox + a * dw, curve_y(a), ox + b * dw, curve_y(b)
        arrow(c, x1 + 4, y1 + 6, x2 - 3, y2 + 7, head=5)
    for t in pts:
        c.setFillColor(HexColor("#f97316"))
        c.circle(ox + t * dw, curve_y(t), 4.2, stroke=0, fill=1)
    c.setFillColor(GREY)
    c.setFont("Helvetica", 10.5)
    mx = ox + 0.62 * dw
    c.drawCentredString(mx, oy + 1 - 15, "minimum")
    c.setStrokeColor(HexColor("#94a3b8"))
    c.setDash(2, 2)
    c.line(mx, oy, mx, curve_y(0.62) - 2)
    c.setDash()
    c.setFont("Helvetica", 10.5)
    c.drawString(ox + 0.10 * dw + 4, curve_y(0.10) + 12, "start")

    # Dark panel
    px, py, pw, ph = 560, 52, R - 560, 172
    c.setFillColor(NAVY)
    c.roundRect(px, py, pw, ph, 12, stroke=0, fill=1)
    c.setFillColor(AMBER)
    c.setFont("Helvetica-Bold", 10.5)
    c.drawString(px + 22, py + ph - 30, "K E Y   T A K E A W A Y S")
    bullets = [
        "Step against the gradient, not along it.",
        "Too large η: the loss bounces or explodes.",
        "Too small η: training crawls.",
        "Scale your features first.",
    ]
    for i, b in enumerate(bullets):
        y = py + ph - 62 - i * 28
        c.setFillColor(AMBER)
        c.circle(px + 27, y + 4.5, 2.6, stroke=0, fill=1)
        assert width(b, "Helvetica", 14) < pw - 60, b
        rich(c, px + 40, y, b, size=14, color=PALE)


def page2(c):
    header(c, 2, "Choosing the Learning Rate", "One number decides whether training works")
    colw = 452
    heading(c, L, 374, "3.  Too small, just right, too large")
    para(c, L, 348, [
        "Each step moves the weights by η times the gradient. Small",
        "steps are safe but slow; large steps overshoot the minimum.",
    ], maxw=colw)

    # Table
    tx, ty, rh = L, 296, 34
    cols = [0, 118, 330, colw]
    head = ["Learning rate η", "What you see", "Verdict"]
    rows = [("0.001", "Loss falls very slowly", "Too small", HexColor("#b45309")),
            ("0.1", "Loss falls fast and smoothly", "Good start", HexColor("#15803d")),
            ("1.5", "Loss jumps around and grows", "Too large", HexColor("#b91c1c"))]
    c.setFillColor(HexColor("#f1f5f9"))
    c.rect(tx, ty - rh, colw, rh, stroke=0, fill=1)
    for i, h in enumerate(head):
        rich(c, tx + cols[i] + 12, ty - 22, h, font="Helvetica-Bold", size=12)
    c.setStrokeColor(RULE)
    c.setLineWidth(1)
    for r in range(len(rows) + 2):
        c.line(tx, ty - r * rh, tx + colw, ty - r * rh)
    for r, (lr, what, verdict, col) in enumerate(rows, start=1):
        y = ty - r * rh - 22
        c.setFillColor(INK)
        c.setFont("Courier-Bold", 13)
        c.drawString(tx + 12, y, lr)
        rich(c, tx + cols[1] + 12, y, what, size=12.5)
        rich(c, tx + cols[2] + 12, y, verdict, font="Helvetica-Bold", size=12.5, color=col)

    # Tip box
    c.setFillColor(HexColor("#fffbeb"))
    c.setStrokeColor(HexColor("#fde68a"))
    c.roundRect(L, 56, colw, 74, 10, stroke=1, fill=1)
    rich(c, L + 18, 104, "Tip", font="Helvetica-Bold", size=12.5, color=HexColor("#b45309"))
    para(c, L + 18, 84, [
        "Start at 0.1. If the loss bounces, divide by 10. If it",
        "barely moves after a few epochs, multiply by 3.",
    ], lead=18, size=12, maxw=colw - 36)

    # Chart: loss against epochs for the three rates
    ox, oy, cw, ch = 584, 90, 300, 250
    c.setStrokeColor(HexColor("#94a3b8"))
    c.setFillColor(HexColor("#94a3b8"))
    c.setLineWidth(1.2)
    arrow(c, ox, oy, ox + cw + 8, oy)
    arrow(c, ox, oy, ox, oy + ch + 8)
    c.setStrokeColor(RULE)
    c.setLineWidth(0.8)
    for k in range(1, 5):
        c.line(ox + 1, oy + k * ch / 5, ox + cw, oy + k * ch / 5)
    c.setFillColor(GREY)
    c.setFont("Helvetica-Oblique", 11)
    c.drawString(ox + cw - 30, oy - 16, "epoch")
    c.drawString(ox + 8, oy + ch + 2, "loss")
    series = [
        (HexColor("#b45309"), lambda t: 0.86 - 0.22 * t),
        (HexColor("#15803d"), lambda t: 0.08 + 0.78 * math.exp(-5 * t)),
        (HexColor("#b91c1c"), lambda t: 0.66 + 0.10 * t + 0.15 * math.sin(11 * t + 0.4) * (0.4 + 0.7 * t)),
    ]
    for col, f in series:
        c.setStrokeColor(col)
        c.setLineWidth(2.4)
        p = c.beginPath()
        for i in range(81):
            t = i / 80
            (p.moveTo if i == 0 else p.lineTo)(ox + 6 + t * (cw - 12), oy + f(t) * ch)
        c.drawPath(p, stroke=1, fill=0)
    for i, (lab, col) in enumerate([("η = 0.001", "#b45309"), ("η = 0.1", "#15803d"), ("η = 1.5", "#b91c1c")]):
        x = ox + 18 + i * 96
        c.setFillColor(HexColor(col))
        c.rect(x, oy - 42, 14, 4, stroke=0, fill=1)
        rich(c, x + 20, oy - 45, lab, size=11, color=INK)


def page3(c):
    c.setFillColor(NAVY)
    c.rect(0, 0, PW, PH, stroke=0, fill=1)
    header(c, 3, "Summary", "Gradient descent in four lines", dark=True)
    points = [
        "Compute the gradient of the loss with respect to the weights.",
        "Move the weights a small step against the gradient.",
        "Pick η with care: too large bounces, too small crawls.",
        "Repeat over many batches until the loss levels off.",
    ]
    for i, s in enumerate(points):
        y = 360 - i * 40
        c.setFillColor(AMBER)
        c.setFont("Helvetica-Bold", 16)
        c.drawString(L, y, f"{i + 1}")
        rich(c, L + 30, y, s, size=16, color=HexColor("#e2e8f0"))
    # Code card
    cx, cy, cw, chh = L, 92, 520, 96
    c.setFillColor(NAVY2)
    c.setStrokeColor(HexColor("#334155"))
    c.roundRect(cx, cy, cw, chh, 10, stroke=1, fill=1)
    code = [
        [("#c084fc", "for "), ("#e2e8f0", "epoch "), ("#c084fc", "in "), ("#7dd3fc", "range"), ("#e2e8f0", "("),
         ("#fbbf24", "100"), ("#e2e8f0", "):")],
        [("#e2e8f0", "    grad = "), ("#7dd3fc", "gradient"), ("#e2e8f0", "(loss, w)")],
        [("#e2e8f0", "    w = w - lr * grad")],
    ]
    for i, line in enumerate(code):
        x, y = cx + 22, cy + chh - 30 - i * 22
        for col, t in line:
            c.setFillColor(HexColor(col))
            c.setFont("Courier", 14)
            c.drawString(x, y, t)
            x += stringWidth(t, "Courier", 14)
    c.setFillColor(AMBER)
    c.setFont("Helvetica-Bold", 14)
    c.drawRightString(R, 120, "Next lecture:")
    c.setFillColor(HexColor("#f8fafc"))
    c.setFont("Helvetica", 14)
    c.drawRightString(R, 100, "Momentum and Adam")


def main():
    c = canvas.Canvas(OUT, pagesize=(PW, PH))
    c.setTitle("Gradient Descent - Lecture 4")
    c.setAuthor("ML Foundations")
    c.setCreator("dev/make-demo-pdf.py")
    for fn in (page1, page2, page3):
        fn(c)
        c.showPage()
    c.save()
    print("wrote", OUT, os.path.getsize(OUT), "bytes")


if __name__ == "__main__":
    main()
