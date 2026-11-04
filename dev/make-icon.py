"""Draws the PDF Pen Annotator logo.

A dark slate tile (same family as SQL Notebook Studio and Modern MySQL Workbench), a white PDF page with
text lines, a yellow highlight over one line, an orange ink swoosh, a red PDF tag, and a stylus finishing the
stroke. Drawn at 4096 px and scaled down, so the edges stay smooth.

    python dev/make-icon.py

Writes media/icon.png (256 px, the extension icon) and media/readme/logo.png (512 px, for the README).
"""
import math
import os

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
S = 4096                      # drawing size; coordinates below are in 1024 units times K
K = S / 1024
CLEAR = (0, 0, 0, 0)


def k(*v):
    return tuple(round(x * K) for x in v)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


def vgrad(top, bottom, size=(S, S)):
    w, h = size
    g = Image.new("RGBA", (1, h))
    for y in range(h):
        g.putpixel((0, y), lerp(top, bottom, y / max(1, h - 1)))
    return g.resize((w, h))


def mask_of(draw_fn, size=(S, S)):
    m = Image.new("L", size, 0)
    draw_fn(ImageDraw.Draw(m))
    return m


def paste(base, fill, m):
    if not isinstance(fill, Image.Image):
        fill = Image.new("RGBA", base.size, fill)
    base.alpha_composite(Image.composite(fill, Image.new("RGBA", base.size, CLEAR), m))


def shadow(base, m, offset, blur, alpha):
    sh = m.filter(ImageFilter.GaussianBlur(blur * K))
    sh = ImageChops.offset(sh, round(offset[0] * K), round(offset[1] * K))
    paste(base, (0, 0, 0, alpha), sh)


def bezier(p0, p1, p2, p3, n=200):
    pts = []
    for i in range(n + 1):
        t = i / n
        a, b, c, d = (1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t ** 2, t ** 3
        pts.append((a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]))
    return pts


def stroke(d, pts, width, fill=255):
    """A smooth round-capped stroke: stamp a disc at every sample (PIL's wide lines get ragged joins)."""
    r = width * K / 2
    for i in range(len(pts) - 1):
        (x0, y0), (x1, y1) = pts[i], pts[i + 1]
        steps = max(1, int(math.hypot(x1 - x0, y1 - y0) * K / 4))
        for j in range(steps + 1):
            x, y = (x0 + (x1 - x0) * j / steps) * K, (y0 + (y1 - y0) * j / steps) * K
            d.ellipse((x - r, y - r, x + r, y + r), fill=fill)


img = Image.new("RGBA", (S, S), CLEAR)

# 1. tile: dark slate with a soft top highlight and a thin rim
tile = mask_of(lambda d: d.rounded_rectangle(k(40, 40, 984, 984), radius=round(220 * K), fill=255))
paste(img, vgrad((39, 50, 66, 255), (15, 21, 32, 255)), tile)
rim = mask_of(lambda d: d.rounded_rectangle(k(40, 40, 984, 984), radius=round(220 * K), outline=255, width=round(6 * K)))
paste(img, vgrad((255, 255, 255, 46), (255, 255, 255, 8)), ImageChops.multiply(rim, tile))

# 2. the page, with a folded top-right corner
PX0, PY0, PX1, PY1, FOLD = 214, 150, 714, 800, 120
page_poly = [(PX0, PY0), (PX1 - FOLD, PY0), (PX1, PY0 + FOLD), (PX1, PY1), (PX0, PY1)]


def page_shape(d):
    d.rounded_rectangle(k(PX0, PY0, PX1, PY1), radius=round(34 * K), fill=255)
    d.polygon([k(PX1 - FOLD - 2, PY0 - 2)[0:2], k(PX1 + 2, PY0 - 2)[0:2], k(PX1 + 2, PY0 + FOLD + 2)[0:2]], fill=0)


page = mask_of(page_shape)
shadow(img, page, (0, 22), 30, 110)
paste(img, vgrad((255, 255, 255, 255), (232, 237, 244, 255)), page)
fold = mask_of(lambda d: d.polygon([k(PX1 - FOLD, PY0)[0:2], k(PX1 - FOLD, PY0 + FOLD - 18)[0:2],
                                    k(PX1 - FOLD + 18, PY0 + FOLD)[0:2], k(PX1, PY0 + FOLD)[0:2]], fill=255))
shadow(img, fold, (-6, 10), 10, 70)
paste(img, vgrad((214, 222, 233, 255), (186, 197, 212, 255)), fold)

# 3. text: a heading bar and body lines; the second body line carries a yellow highlight under it
LX = 284
heading = mask_of(lambda d: d.rounded_rectangle(k(LX, 236, 520, 270), radius=round(17 * K), fill=255))
paste(img, (52, 64, 84, 255), heading)
lines = [(320, 560), (382, 616), (444, 590), (506, 470)]
hl = mask_of(lambda d: d.polygon([k(LX - 26, 352)[0:2], k(648, 346)[0:2], k(652, 414)[0:2], k(LX - 22, 420)[0:2]], fill=255))
hl = hl.filter(ImageFilter.GaussianBlur(2 * K))
paste(img, (255, 210, 0, 200), hl)
for y, x1 in lines:
    m = mask_of(lambda d, y=y, x1=x1: d.rounded_rectangle(k(LX, y - 11, x1, y + 11), radius=round(11 * K), fill=255))
    paste(img, (92, 84, 60, 255) if y == 382 else (128, 140, 160, 255), m)

# 4. orange ink: a hand-drawn underline swoosh that loops back, ending where the pen tip is
ink_pts = bezier((LX - 6, 590), (380, 548), (520, 610), (600, 562))
ink = mask_of(lambda d: stroke(d, ink_pts, 26))
paste(img, (242, 120, 17, 255), ink)
TIP = ink_pts[-1]

# 5. red PDF tag hanging off the lower-left edge of the page
tag = mask_of(lambda d: d.rounded_rectangle(k(150, 650, 430, 760), radius=round(26 * K), fill=255))
shadow(img, tag, (0, 12), 16, 120)
paste(img, vgrad((240, 84, 79, 255), (204, 46, 52, 255)), tag)
try:
    font = ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", round(78 * K))
except OSError:
    font = ImageFont.load_default()
d = ImageDraw.Draw(img)
cx, cy = 290 * K, 705 * K
d.text((cx, cy), "PDF", font=font, fill=(255, 255, 255, 255), anchor="mm")

# 6. the stylus: built pointing left on its own layer, rotated, tip placed at the end of the ink
L, Wd = 470, 92               # body length and width (1024 units)
layer = Image.new("RGBA", k(L + 40, Wd + 40), CLEAR)
lw, lh = layer.size
cy = lh / 2
cone = 150                    # length of the tapered front
nib = 46


def body_shape(dd):
    x0 = 20 * K + cone * K
    dd.rounded_rectangle((x0, cy - Wd * K / 2, lw - 20 * K, cy + Wd * K / 2), radius=round(Wd * K / 2), fill=255)


def cone_shape(dd):
    x0 = 20 * K
    dd.polygon([(x0 + nib * K, cy - 14 * K), (x0 + cone * K + 8 * K, cy - Wd * K / 2),
                (x0 + cone * K + 8 * K, cy + Wd * K / 2), (x0 + nib * K, cy + 14 * K)], fill=255)


def nib_shape(dd):
    x0 = 20 * K
    dd.polygon([(x0, cy), (x0 + nib * K + 2 * K, cy - 15 * K), (x0 + nib * K + 2 * K, cy + 15 * K)], fill=255)


grad_body = vgrad((96, 196, 255, 255), (22, 108, 214, 255), layer.size)
paste(layer, grad_body, mask_of(body_shape, layer.size))
paste(layer, vgrad((236, 241, 247, 255), (176, 188, 204, 255), layer.size), mask_of(cone_shape, layer.size))
paste(layer, (242, 120, 17, 255), mask_of(nib_shape, layer.size))
# a grip band and a soft highlight along the top of the body
band = mask_of(lambda dd: dd.rectangle((20 * K + (cone + 70) * K, cy - Wd * K / 2, 20 * K + (cone + 110) * K, cy + Wd * K / 2), fill=255), layer.size)
paste(layer, (14, 74, 160, 255), ImageChops.multiply(band, mask_of(body_shape, layer.size)))
gloss = mask_of(lambda dd: dd.rounded_rectangle((20 * K + (cone + 140) * K, cy - Wd * K / 2 + 14 * K, lw - 60 * K, cy - Wd * K / 2 + 30 * K), radius=round(8 * K), fill=255), layer.size)
paste(layer, (255, 255, 255, 120), gloss)

ANGLE = -40                   # PIL turns counter-clockwise, so negative tips the pen down to the right
rot = layer.rotate(ANGLE, resample=Image.BICUBIC, expand=True)
# find where the nib point lands by rotating a one-dot marker the same way
marker = Image.new("L", layer.size, 0)
ImageDraw.Draw(marker).ellipse((20 * K - 6, cy - 6, 20 * K + 6, cy + 6), fill=255)
tx, ty = marker.rotate(ANGLE, resample=Image.BICUBIC, expand=True).getbbox()[0:2]
pos = (round(TIP[0] * K - tx - 6), round(TIP[1] * K - ty - 6))
pen = Image.new("RGBA", (S, S), CLEAR)
pen.alpha_composite(rot, dest=(max(0, pos[0]), max(0, pos[1])), source=(max(0, -pos[0]), max(0, -pos[1])))
pen_mask = ImageChops.multiply(pen.getchannel("A"), tile)
shadow(img, pen_mask, (10, 26), 22, 120)
img.alpha_composite(Image.composite(pen, Image.new("RGBA", (S, S), CLEAR), pen_mask))

os.makedirs(os.path.join(REPO, "media", "readme"), exist_ok=True)
img.resize((256, 256), Image.LANCZOS).save(os.path.join(REPO, "media", "icon.png"))
img.resize((512, 512), Image.LANCZOS).save(os.path.join(REPO, "media", "readme", "logo.png"))
print("wrote media/icon.png and media/readme/logo.png")
