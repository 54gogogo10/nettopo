from PIL import Image
for f in ['test/visio_render.png', 'test/visio_render_hi.png']:
    im = Image.open(f)
    print(f, im.size)
