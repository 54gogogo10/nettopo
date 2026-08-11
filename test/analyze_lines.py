# 像素分析：PDF 渲染图的线分布
from PIL import Image

im = Image.open('test/pdf_final.png').convert('RGB')
w, h = im.size
print('尺寸:', im.size)
px = im.load()

LINE = (0x8f, 0xa0, 0xb8)
line_xs, line_ys = [], []
for y in range(0, h, 3):
    for x in range(0, w, 3):
        r, g, b = px[x, y]
        if abs(r - LINE[0]) < 25 and abs(g - LINE[1]) < 25 and abs(b - LINE[2]) < 25:
            line_xs.append(x); line_ys.append(y)
print('线像素:', len(line_xs))
if line_xs:
    print('线 x 范围: %d-%d (画布宽 %d)' % (min(line_xs), max(line_xs), w))
    print('线 y 范围: %d-%d (画布高 %d)' % (min(line_ys), max(line_ys), h))
    import collections
    cols = collections.Counter(x // 100 for x in line_xs)
    print('线像素列分布（每 100px）:')
    for k in sorted(cols):
        print('  x=%d-%d: %d' % (k*100, k*100+100, cols[k]))
