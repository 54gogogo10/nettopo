# 检查 sample_topology.pdf 内部结构
import re

data = open('test/sample_topology.pdf', 'rb').read()
print('PDF 大小:', len(data))

# 找图片对象
m = re.search(rb'4 0 obj\n(.*?)endstream', data, re.S)
if m:
    head = m.group(1)
    # stream 后的 JPEG 数据 = 到 endstream
    stream_start = head.find(b'stream\n') + len(b'stream\n')
    jpeg = head[stream_start:]
    print('JPEG 数据长度:', len(jpeg))
    print('JPEG 头:', jpeg[:4].hex(), '(FFD8=JPEG)')
    print('JPEG 尾:', jpeg[-4:].hex(), '(FFD9=结束)')
    # 检查 Length 声明
    lm = re.search(rb'/Length (\d+)', head)
    if lm:
        print('声明 Length:', lm.group(1).decode(), '实际:', len(jpeg))
else:
    print('未找到图片对象')

import pymupdf
doc = pymupdf.open('test/sample_topology.pdf')
page = doc[0]
print('图片数:', len(page.get_images()))
imgs = page.get_images()
if imgs:
    xref = imgs[0][0]
    info = doc.extract_image(xref)
    print('提取图片:', info['width'], 'x', info['height'], '格式:', info['ext'], '大小:', len(info['image']))
    with open('test/_extracted.jpg', 'wb') as f:
        f.write(info['image'])
    print('已提取')
