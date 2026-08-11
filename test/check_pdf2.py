import pymupdf
from PIL import Image

doc = pymupdf.open('test/sample_topology.pdf')
page = doc[0]
imgs = page.get_images()
print('图片数:', len(imgs))
if imgs:
    xref = imgs[0][0]
    info = doc.extract_image(xref)
    print('图片:', info['width'], 'x', info['height'], info['ext'], len(info['image']), 'bytes')
    with open('test/_extracted2.jpg', 'wb') as f:
        f.write(info['image'])

im = Image.open('test/pdf_final.png').convert('RGB')
px = im.load()
w, h = im.size
colors = set()
for y in range(0, h, 25):
    for x in range(0, w, 25):
        colors.add(px[x, y])
print('渲染图采样颜色数:', len(colors))
print('样例:', list(colors)[:6])
