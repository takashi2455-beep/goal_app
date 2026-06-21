from PIL import Image, ImageDraw

SIZE  = 180
WHITE = (255, 255, 255, 255)
BLACK = (20,  20,  20,  255)
BLUE  = (74,  144, 217, 255)   # アプリのメインカラーと統一
W     = 9

img  = Image.new('RGBA', (SIZE, SIZE), WHITE)
draw = ImageDraw.Draw(img)

def line(x1, y1, x2, y2, color=BLACK, w=W):
    draw.line([(x1, y1), (x2, y2)], fill=color, width=w)

def circle_outline(cx, cy, r, color=BLACK, w=W):
    draw.ellipse([cx-r, cy-r, cx+r, cy+r], outline=color, width=w)

# ── Sparkle (✦) 青 ──────────────────────────────────────────────────────
sx, sy = 46, 36
sl, sd = 13, 9
line(sx, sy-sl, sx, sy+sl,          BLUE)
line(sx-sl, sy, sx+sl, sy,          BLUE)
line(sx-sd, sy-sd, sx+sd, sy+sd,    BLUE)
line(sx+sd, sy-sd, sx-sd, sy+sd,    BLUE)

# ── 頭（黒・アウトライン円）────────────────────────────────────────────
circle_outline(108, 42, 14, BLACK)

# ── 胴体（黒）──────────────────────────────────────────────────────────
line(108, 56, 103, 108, BLACK)

# ── 左腕・上げ（黒）────────────────────────────────────────────────────
line(106, 73, 70, 48, BLACK)

# ── 右腕・上げ（黒）────────────────────────────────────────────────────
line(106, 73, 138, 55, BLACK)

# ── 右足：膝上げ（黒）──────────────────────────────────────────────────
line(103, 108, 124, 84,  BLACK)
line(124, 84,  130, 113, BLACK)

# ── 左足：後ろへ伸ばす（黒）────────────────────────────────────────────
line(103, 108, 78, 150, BLACK)

# ── 階段（青）──────────────────────────────────────────────────────────
line(114, 148, 158, 148, BLUE)   # 踏み面1
line(158, 148, 158, 159, BLUE)   # 蹴上げ1
line( 97, 159, 158, 159, BLUE)   # 踏み面2
line( 97, 159,  97, 170, BLUE)   # 蹴上げ2
line( 58, 170,  97, 170, BLUE)   # 踏み面3

img.save('static/apple-touch-icon.png', 'PNG')
print('apple-touch-icon.png saved (180x180)')
