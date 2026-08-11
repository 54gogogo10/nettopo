from PIL import Image

im = Image.open('test/visio_render.png').convert('RGB')
w, h = im.size
# 右上区域（PC1 附近标注）
crop = im.crop((int(w * 0.55), int(h * 0.05), int(w * 0.95), int(h * 0.45)))
crop = crop.resize((crop.width * 4, crop.height * 4), Image.LANCZOS)
crop.save(r'C:\Users\chen\AppData\Local\Programs\PixPin\Temp\_zoom_text.png', quality=92)
print('已保存', crop.size)
