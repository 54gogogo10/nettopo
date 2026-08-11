# 像素级分析：检测连线标注文字的方向（水平 vs 竖直）
# 连线文字颜色 #334155（深蓝），节点文字为白色
from PIL import Image
import collections

src = r'C:\Users\chen\AppData\Local\Programs\PixPin\Temp\PixPin_2026-08-10_22-00-09.jpg'
im = Image.open(src).convert('RGB')
w, h = im.size
print('尺寸:', im.size)
px = im.load()

# 找深蓝文字像素 (#334155) —— 容差匹配
def is_link_text(r, g, b):
    return abs(r - 0x33) < 30 and abs(g - 0x41) < 30 and abs(b - 0x55) < 30

# 收集深蓝像素连通区域（简化：按 8 邻域 BFS）
pts = []
for y in range(0, h, 2):
    for x in range(0, w, 2):
        r, g, b = px[x, y]
        if is_link_text(r, g, b):
            pts.append((x, y))
print('深蓝文字采样点:', len(pts))
if not pts:
    print('未找到 #334155 像素，可能颜色不同')
    raise SystemExit

# 聚类：简单网格分桶，分析每桶的长宽比
bucket = 40
buckets = collections.defaultdict(list)
for x, y in pts:
    buckets[(x // bucket, y // bucket)].append((x, y))

horiz = vert = square = 0
for (bx, by), pl in buckets.items():
    if len(pl) < 15:
        continue
    xs = [p[0] for p in pl]; ys = [p[1] for p in pl]
    ww = max(xs) - min(xs); hh = max(ys) - min(ys)
    if ww > hh * 1.5:
        horiz += 1
    elif hh > ww * 1.5:
        vert += 1
    else:
        square += 1

print(f'横向文字块: {horiz}, 纵向文字块: {vert}, 方块状: {square}')

# 整图每个文字区域的宽高比（找最大深蓝聚簇的 bbox）
if pts:
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    print(f'深蓝像素总范围: x[{min(xs)},{max(xs)}] y[{min(ys)},{max(ys)}]')
