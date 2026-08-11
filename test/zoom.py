# 放大截图局部，便于 VLM 精确辨认文字
from PIL import Image

src = r'C:\Users\chen\AppData\Local\Programs\PixPin\Temp\PixPin_2026-08-10_21-37-19.jpg'
im = Image.open(src).convert('RGB')
print('原始尺寸:', im.size)

# 整图放大 2 倍
big = im.resize((im.width * 2, im.height * 2), Image.LANCZOS)
big.save(r'C:\Users\chen\AppData\Local\Programs\PixPin\Temp\_zoom_full.jpg', quality=92)

w, h = im.size
# 中心区域（连线文字集中处）放大 3 倍
cx, cy = w // 2, h // 2
crop = im.crop((max(0, cx - w // 4), max(0, cy - h // 4), min(w, cx + w // 4), min(h, cy + h // 4)))
crop = crop.resize((crop.width * 3, crop.height * 3), Image.LANCZOS)
crop.save(r'C:\Users\chen\AppData\Local\Programs\PixPin\Temp\_zoom_center.jpg', quality=92)

print('已保存 _zoom_full.jpg 和 _zoom_center.jpg')
