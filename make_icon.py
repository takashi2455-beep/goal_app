from PIL import Image, ImageDraw
import math

SIZE = 180
img  = Image.new('RGBA', (SIZE, SIZE), (255, 255, 255, 255))
draw = ImageDraw.Draw(img)

C = (61, 61, 61, 255)   # #3D3D3D
W = 9                    # stroke width
WH = W // 2

def line(x1, y1, x2, y2, w=W):
    draw.line([(x1, y1), (x2, y2)], fill=C, width=w)

def circle_outline(cx, cy, r, w=W):
    draw.ellipse([cx-r, cy-r, cx+r, cy+r], outline=C, width=w)

# ── Sparkle (✦) upper-left ───────────────────────────────────────────────
sx, sy = 46, 36
sl, sd = 13, 9   # spoke length long / diagonal
line(sx, sy - sl, sx, sy + sl)           # vertical
line(sx - sl, sy, sx + sl, sy)           # horizontal
line(sx - sd, sy - sd, sx + sd, sy + sd) # diagonal ↘
line(sx + sd, sy - sd, sx - sd, sy + sd) # diagonal ↙

# ── Head (outline circle) ────────────────────────────────────────────────
circle_outline(108, 42, 14)

# ── Body (torso) ─────────────────────────────────────────────────────────
line(108, 56, 103, 108)

# ── Left arm (raised up-left) ────────────────────────────────────────────
line(106, 73, 70, 48)

# ── Right arm (raised up-right) ──────────────────────────────────────────
line(106, 73, 138, 55)

# ── Right leg: thigh raised (knee up), lower leg forward ─────────────────
line(103, 108, 124, 84)    # thigh
line(124, 84, 130, 113)    # lower leg

# ── Left leg (extended back/down) ────────────────────────────────────────
line(103, 108, 78, 150)

# ── Stairs (bottom-right) ────────────────────────────────────────────────
# step tread 1 (top step)
line(114, 148, 158, 148)
# riser 1
line(158, 148, 158, 159)
# step tread 2
line( 97, 159, 158, 159)
# riser 2
line( 97, 159,  97, 170)
# step tread 3 / ground
line( 58, 170,  97, 170)

# ── Save ─────────────────────────────────────────────────────────────────
img.save('static/apple-touch-icon.png', 'PNG')
print('apple-touch-icon.png saved (180x180)')
