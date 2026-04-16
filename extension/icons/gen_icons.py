#!/usr/bin/env python3
"""
Generate PREPT AI extension icons faithful to the real logo:
  • very dark navy background  (#110f1a)
  • off-white / cream solid P  (#f5f2ea)
  • small dark play-arrow cut out of the solid bowl
Uses only stdlib (struct + zlib).
"""
import struct, zlib, os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SIZES = [16, 32, 48, 128]

# ── Brand colours ─────────────────────────────────────────────────────────────
BG = (17,  15,  26)    # #110f1a  very dark navy (logo background)
FG = (245, 242, 234)   # #f5f2ea  off-white cream (P letterform)

# ── All coordinates on a virtual 512 × 512 canvas ────────────────────────────
#
#  The P = solid stem (rectangle) ∪ solid bowl (circle)
#          minus  a small right-pointing triangle (play-arrow cutout).
#
#  The bowl circle is tangent to the stem right edge AND the stem top edge,
#  matching the smooth junction visible in the logo.
#
#  Proportions measured from the actual logo image (1080 × 1080 px):
#    • P spans ~26% to ~78% horizontally, ~8% to ~89% vertically
#    • Bowl radius ≈ 18.5% of image width  →  95 px on 512 canvas
#    • Arrow fills ~15% of the bowl area; positioned upper-left of bowl

# Stem
STEM_L, STEM_R = 126, 197     # x  left / right
STEM_T, STEM_B = 50,  462     # y  top  / bottom

# Solid bowl circle — tangent to stem right edge (BOWL_CX = STEM_R + R)
BOWL_R  = 95
BOWL_CX = STEM_R + BOWL_R     # = 292
BOWL_CY = STEM_T + BOWL_R     # = 145

# Play-arrow: right-pointing triangle cutout from the solid bowl
# Positioned in the upper portion of the bowl, matching the logo.
ARR_LX  = 252     # left-edge x  (both base vertices)
ARR_TY  = 97      # top-left vertex y
ARR_BY  = 155     # bottom-left vertex y
ARR_APX = 310     # apex (right point) x
ARR_APY = (ARR_TY + ARR_BY) // 2   # = 126  (vertically centred)


# ── Geometry helpers ──────────────────────────────────────────────────────────

def _sign(ax, ay, bx, by, cx, cy):
    return (ax - cx) * (by - cy) - (bx - cx) * (ay - cy)


def _in_arrow(px, py):
    """True if (px, py) is inside the play-arrow triangle."""
    d1 = _sign(px, py, ARR_LX, ARR_TY,  ARR_APX, ARR_APY)
    d2 = _sign(px, py, ARR_APX, ARR_APY, ARR_LX,  ARR_BY)
    d3 = _sign(px, py, ARR_LX, ARR_BY,  ARR_LX,  ARR_TY)
    neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (neg and pos)


def coverage(px, py):
    """0.0 = background (dark), 1.0 = cream P."""
    in_stem = (STEM_L <= px <= STEM_R) and (STEM_T <= py <= STEM_B)
    in_bowl = (px - BOWL_CX) ** 2 + (py - BOWL_CY) ** 2 <= BOWL_R ** 2

    if not (in_stem or in_bowl):
        return 0.0   # outside P entirely

    # Arrow cutout sits inside the bowl, to the right of the stem
    if px > STEM_R and _in_arrow(px, py):
        return 0.0   # dark arrow cut from solid cream bowl

    return 1.0   # cream P


# ── PNG writer (stdlib only) ──────────────────────────────────────────────────

def _chunk(tag, body):
    crc = zlib.crc32(tag + body) & 0xFFFFFFFF
    return struct.pack('>I', len(body)) + tag + body + struct.pack('>I', crc)


def write_png(path, w, h, rgba):
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw.extend(rgba[y * w * 4: (y + 1) * w * 4])
    data = (b'\x89PNG\r\n\x1a\n'
            + _chunk(b'IHDR', ihdr)
            + _chunk(b'IDAT', zlib.compress(bytes(raw), 9))
            + _chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(data)
    print(f'  {path}  ({len(data):,} bytes)')


# ── Render with 4 × 4 supersampling ──────────────────────────────────────────

SS = 4

def render(size):
    scale = 512.0 / size
    out = []
    for y in range(size):
        for x in range(size):
            acc = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    vx = (x + (sx + 0.5) / SS) * scale
                    vy = (y + (sy + 0.5) / SS) * scale
                    acc += coverage(vx, vy)
            t = acc / (SS * SS)
            r = int(BG[0] + (FG[0] - BG[0]) * t + 0.5)
            g = int(BG[1] + (FG[1] - BG[1]) * t + 0.5)
            b = int(BG[2] + (FG[2] - BG[2]) * t + 0.5)
            out.extend([r, g, b, 255])
    return out


# ── Main ──────────────────────────────────────────────────────────────────────

print('Generating PREPT AI extension icons …')
for size in SIZES:
    pix  = render(size)
    path = os.path.join(SCRIPT_DIR, f'icon{size}.png')
    write_png(path, size, size, pix)
print('Done.')
