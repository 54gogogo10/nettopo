from PIL import Image

im = Image.open('test/_extracted.jpg').convert('RGB')
print('尺寸:', im.size)
px = im.load()
w, h = im.size
colors = set()
for y in range(0, h, 20):
    for x in range(0, w, 20):
        colors.add(px[x, y])
print('采样颜色数:', len(colors))
print('样例:', list(colors)[:8])
