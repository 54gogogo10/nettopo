# 分析用户 10:19 导出的 PDF：线端点是否连接节点
import pymupdf
from PIL import Image
import io

doc = pymupdf.open(r'C:\Users\chen\Downloads\网络拓扑图_20260811_1019.pdf')
page = doc[0]
imgs = page.get_images()
print('PDF 页数:', doc.page_count, '图片数:', len(imgs))
xref = imgs[0][0]
info = doc.extract_image(xref)
print('图片:', info['width'], 'x', info['height'], info['ext'])
im = Image.open(io.BytesIO(info['image'])).convert('RGB')
im.save('test/_user_pdf_img.png')
w, h = im.size
px = im.load()

# 线色 #8fa0b8
LINE = (0x8f, 0xa0, 0xb8)
line_pts = set()
for y in range(0, h, 1):
    for x in range(0, w, 1):
        r, g, b = px[x, y]
        if abs(r-LINE[0]) < 22 and abs(g-LINE[1]) < 22 and abs(b-LINE[2]) < 22:
            line_pts.add((x, y))
print('线像素:', len(line_pts))

# 线端点（邻域线像素 <= 1）
endpoints = []
for (x, y) in line_pts:
    n = sum(1 for dx in (-1,0,1) for dy in (-1,0,1) if (dx,dy)!=(0,0) and (x+dx,y+dy) in line_pts)
    if n <= 1:
        endpoints.append((x, y))
print('端点:', len(endpoints))

# 非白色非线色的彩色像素 = 节点/文字
def near_colored(x, y, rad=16):
    for dx in range(-rad, rad+1):
        for dy in range(-rad, rad+1):
            nx, ny = x+dx, y+dy
            if 0 <= nx < w and 0 <= ny < h:
                r, g, b = px[nx, ny]
                if max(r,g,b) > 60 and abs(r-LINE[0]) >= 28 and abs(g-LINE[1]) >= 28 and abs(b-LINE[2]) >= 28:
                    return True
    return False

floating = [p for p in endpoints if not near_colored(*p)]
print('悬空端点(16px内无彩色):', len(floating))
for p in floating[:8]:
    print('  悬空端:', p)
