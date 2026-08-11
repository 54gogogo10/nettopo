import pymupdf

doc = pymupdf.open('test/sample_topology.pdf')
print('页数:', doc.page_count, '页面尺寸:', doc[0].rect)
pix = doc[0].get_pixmap(dpi=120)
pix.save('test/pdf_render.png')
print('渲染:', pix.width, 'x', pix.height)
txt = doc[0].get_text()
print('文本提取:', txt[:120].replace('\n', ' / '))
