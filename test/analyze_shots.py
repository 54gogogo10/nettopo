# 截图内容分析：检查页面是否正常渲染（非空白、有彩色元素、明暗主题生效）
import os
try:
    from PIL import Image
except ImportError:
    print('NO_PIL'); raise SystemExit(0)

for f in ['shot_empty.png', 'shot_light.png', 'shot_selected.png', 'shot_linkmode.png', 'shot_dark.png', 'shot_modal.png']:
    if not os.path.exists(f):
        continue
    im = Image.open(f).convert('RGB')
    w, h = im.size
    small = im.resize((100, 56))
    colors = small.getcolors(100 * 56)
    # 统计：整体亮度、彩色像素比例
    px = list(small.getdata())
    bright = sum((r + g + b) / 3 for r, g, b in px) / len(px)
    colorful = sum(1 for r, g, b in px if max(r, g, b) - min(r, g, b) > 40) / len(px)
    print(f'{f}: {w}x{h} 亮度={bright:.0f}/255 彩色像素={colorful*100:.1f}% 颜色数≈{len(colors)}')
