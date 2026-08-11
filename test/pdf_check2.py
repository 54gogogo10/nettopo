import pymupdf

doc = pymupdf.open('test/_test.pdf')
print('页数:', doc.page_count, '尺寸:', doc[0].rect)
print('图片数:', len(doc[0].get_images()))
imgs = doc[0].get_images()
if imgs:
    print('图片:', imgs[0][2], 'x', imgs[0][3])
pix = doc[0].get_pixmap(dpi=96)
print('渲染:', pix.width, 'x', pix.height)
pix.save('test/_test_render.png')
print('OK')
