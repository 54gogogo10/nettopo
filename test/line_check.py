# 像素级检测：所有线的端点是否接触设备（检测线端点附近有无设备色）
from PIL import Image

im = Image.open('test/visio_render.png').convert('RGB')
w, h = im.size
px = im.load()

# 收集线色像素
LINE = (0x8f, 0xa0, 0xb8)
line_pts = set()
for y in range(0, h, 1):
    for x in range(0, w, 1):
        r, g, b = px[x, y]
        if abs(r-LINE[0]) < 20 and abs(g-LINE[1]) < 20 and abs(b-LINE[2]) < 20:
            line_pts.add((x, y))

print('线像素:', len(line_pts))

# 找线端点：线像素中 8 邻域线像素 <= 2 的点（粗略）
from collections import Counter
endpoints = []
for (x, y) in line_pts:
    n = 0
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            if (dx, dy) != (0, 0) and (x+dx, y+dy) in line_pts:
                n += 1
    if n <= 1:
        endpoints.append((x, y))

print('线端点候选:', len(endpoints))

# 每个端点附近(12px)是否有非白色、非线色的彩色像素（=设备）
def near_device(x, y):
    for dx in range(-12, 13):
        for dy in range(-12, 13):
            nx, ny = x+dx, y+dy
            if 0 <= nx < w and 0 <= ny < h:
                r, g, b = px[nx, ny]
                if max(r, g, b) > 60 and abs(r-LINE[0]) >= 25 and abs(g-LINE[1]) >= 25 and abs(b-LINE[2]) >= 25:
                    return True
    return False

floating = []
for (x, y) in endpoints:
    if not near_device(x, y):
        floating.append((x, y))

print('悬空端点(12px内无设备):', len(floating))
# 聚类打印
if floating:
    clusters = []
    used = set()
    for p in floating:
        if p in used: continue
        grp = [p]; used.add(p)
        for q in floating:
            if q not in used and abs(q[0]-p[0]) < 15 and abs(q[1]-p[1]) < 15:
                grp.append(q); used.add(q)
        clusters.append(grp)
    for g in clusters:
        xs = [p[0] for p in g]; ys = [p[1] for p in g]
        print('  悬空端集群: (%d,%d) 大小%d' % (sum(xs)//len(xs), sum(ys)//len(ys), len(g)))
