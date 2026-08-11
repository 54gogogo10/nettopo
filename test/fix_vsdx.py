import io

lines = open('js/vsdx.js', encoding='utf-8').read().split('\n')
start = None
for i, ln in enumerate(lines):
    if '独立 2D 文本框（永远水平）' in ln:
        start = i
        break
assert start is not None, '未找到旧块起点'

# 从起点开始，找第一个 "    </Shape>`);" 行，之后跳过 "    }"，end = "  }" 之后
end = None
i = start
while i < len(lines):
    if lines[i].strip().startswith('</Shape>`);'):
        j = i + 1
        while j < len(lines) and lines[j].strip() not in ('}', '  }'):
            j += 1
        end = j + 1
        break
    i += 1
assert end is not None, '未找到旧块终点'

print('删除行', start + 1, '到', end)
del lines[start:end]
open('js/vsdx.js', 'w', encoding='utf-8').write('\n'.join(lines))
print('完成')
