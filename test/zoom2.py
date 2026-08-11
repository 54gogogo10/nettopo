# 裁剪放大截图：右下角节点 + 中央连线区域
from PIL import Image

src = r'C:\Users\chen\AppData\Local\Programs\PixPin\Temp\PixPin_2026-08-10_21-48-00.jpg'
im = Image.open(src).convert('RGB')
w, h = im.size
print('尺寸:', im.size)

# 右下角节点（核心路由器，蓝紫色）区域放大 4 倍
node = im.crop((int(w * 0.55), int(h * 0.55), w, h))
node = node.resize((node.width * 4, node.height * 4), Image.LANCZOS)
node.save(r'C:\Users\chen\AppData\Local\Programs\PixPin\Temp\_node_zoom.jpg', quality=92)

# 中央连线文字区域放大 4 倍
cx0, cy0, cx1, cy1 = int(w * 0.15), int(h * 0.2), int(w * 0.7), int(h * 0.6)
link = im.crop((cx0, cy0, cx1, cy1))
link = link.resize((link.width * 4, link.height * 4), Image.LANCZOS)
link.save(r'C:\Users\chen\AppData\Local\Programs\PixPin\Temp\_link_zoom.jpg', quality=92)

print('已保存 _node_zoom.jpg 和 _link_zoom.jpg')
