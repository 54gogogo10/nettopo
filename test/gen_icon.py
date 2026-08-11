# 生成 NetTopo 图标（PNG + ICO）
from PIL import Image, ImageDraw

S = 256
im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(im)

# 圆角背景（indigo 渐变近似：垂直渐变）
for y in range(S):
    t = y / S
    r = int(79 + (99 - 79) * t)
    g = int(70 + (102 - 70) * t)
    b = int(229 + (241 - 229) * t)
    d.line([(0, y), (S, y)], fill=(r, g, b, 255))

# 圆角裁剪：画白色圆角遮罩（简单：四角画透明）
mask = Image.new('L', (S, S), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle([0, 0, S - 1, S - 1], radius=56, fill=255)
im.putalpha(mask)

# 中心节点 + 网络连线（白色）
cx, cy = S // 2, S // 2
R = 52
d = ImageDraw.Draw(im)
# 中心圆
d.ellipse([cx - R, cy - R, cx + R, cy + R], fill=(255, 255, 255, 255))
# 四个卫星点
pts = [(S * 0.22, S * 0.22), (S * 0.78, S * 0.22), (S * 0.22, S * 0.78), (S * 0.78, S * 0.78)]
sr = 26
for px, py in pts:
    d.ellipse([px - sr, py - sr, px + sr, py + sr], fill=(255, 255, 255, 255))
# 连线（粗线条）
d.line([(S * 0.22, S * 0.22), (cx, cy)], fill=(255, 255, 255, 235), width=16)
d.line([(S * 0.78, S * 0.22), (cx, cy)], fill=(255, 255, 255, 235), width=16)
d.line([(S * 0.22, S * 0.78), (cx, cy)], fill=(255, 255, 255, 235), width=16)
d.line([(S * 0.78, S * 0.78), (cx, cy)], fill=(255, 255, 255, 235), width=16)

im.save('icon.png')
# ICO（多尺寸）
im.save('icon.ico', sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('图标已生成: icon.png + icon.ico')
