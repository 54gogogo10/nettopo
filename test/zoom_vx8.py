from PIL import Image

im = Image.open('test/visio_render.png').convert('RGB')
w, h = im.size
# R1↔Cloud 连线区域（右中部），放大 8 倍
crop = im.crop((int(w*0.42), int(h*0.12), int(w*0.75), int(h*0.38)))
crop = crop.resize((crop.width*8, crop.height*8), Image.LANCZOS)
crop.save(r'C:\Users\chen\AppData\Local\Programs\PixPin\Temp\_vx8.png', quality=92)
print('保存', crop.size)

# 像素检测：线色 #8fa0b8 与设备边框色的分布
px = im.load()
line_px = []
for y in range(0, h, 2):
    for x in range(0, w, 2):
        r, g, b = px[x, y]
        if abs(r-0x8f)<18 and abs(g-0xa0)<18 and abs(b-0xb8)<18:
            line_px.append((x, y))
print('线色像素数:', len(line_px))
if line_px:
    xs = [p[0] for p in line_px]; ys = [p[1] for p in line_px]
    print('线像素范围: x[%d,%d] y[%d,%d]' % (min(xs), max(xs), min(ys), max(ys)))
