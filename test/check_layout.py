# 检查 export.svg 节点矩形是否重叠或超出画布
import re

svg = open('test/export.svg', encoding='utf-8').read()
m = re.search(r'<svg[^>]*width="(\d+)" height="(\d+)"', svg)
W, H = int(m.group(1)), int(m.group(2))
print('画布:', W, 'x', H)

rects = re.findall(r'<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="12"', svg)
print('节点数:', len(rects))
overlap = 0
for i in range(len(rects)):
    a = [float(v) for v in rects[i]]
    if a[0] < 0 or a[1] < 0 or a[0] + a[2] > W or a[1] + a[3] > H:
        print('  越界节点:', a)
    for j in range(i + 1, len(rects)):
        b = [float(v) for v in rects[j]]
        if a[0] < b[0] + b[2] and b[0] < a[0] + a[2] and a[1] < b[1] + b[3] and b[1] < a[1] + a[3]:
            overlap += 1
            print('  重叠:', a, b)
print('节点重叠对数:', overlap)

# 标注框与节点重叠？
texts = re.findall(r'<text x="([\d.]+)" y="([\d.]+)"[^>]*font-size="13"[^>]*>([^<]+)</text>', svg)
print('标注行数:', len(texts))
