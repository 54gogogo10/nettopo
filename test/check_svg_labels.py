# 检查 export.svg 中标注文字的坐标重叠
import re

svg = open('test/export.svg', encoding='utf-8').read()
texts = re.findall(r'<text x="([\d.]+)" y="([\d.]+)"[^>]*font-size="13"[^>]*>([^<]+)</text>', svg)
print('13px 标注数:', len(texts))

# 按标注分组（同一块的 3 行 y 接近）
blocks = []
for x, y, t in texts:
    x, y = float(x), float(y)
    for b in blocks:
        if abs(b['x'] - x) < 1 and abs(b['y'] - y) < 25:
            b['lines'].append((y, t))
            break
    else:
        blocks.append({'x': x, 'y': y, 'lines': [(y, t)]})

print('标注块数:', len(blocks))
for i, b in enumerate(blocks):
    print('  块%d: x=%.0f y=%.0f %s' % (i, b['x'], b['y'], [t for _, t in b['lines']]))

# 块间重叠检查（宽=最长行*13*0.56+12 ≈ 简化：按 x 范围 40px 估算太粗，直接看中心距）
print('\n中心距 < 60px 的块对:')
for i in range(len(blocks)):
    for j in range(i + 1, len(blocks)):
        dx = abs(blocks[i]['x'] - blocks[j]['x'])
        dy = abs(blocks[i]['y'] - blocks[j]['y'])
        if dx < 80 and dy < 45:
            print('  块%d↔块%d: dx=%.0f dy=%.0f' % (i, j, dx, dy))
