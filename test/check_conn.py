# 坐标对照：设备矩形 vs 线端点（test/sample_topology.vsdx）
import vsdx

NS = '{http://schemas.microsoft.com/office/visio/2012/main}'
vis = vsdx.VisioFile('test/sample_topology.vsdx')
page = vis.get_page(0)

devices = []
lines = []
for s in page.child_shapes:
    xml = s.xml
    cells = {}
    for c in xml.iter(NS + 'Cell'):
        try:
            cells[c.get('N')] = float(c.get('V') or 0)
        except ValueError:
            pass
    if 'BeginX' in cells:
        lines.append(cells)
    else:
        devices.append((s.shape_name or '?', cells))

print('设备:')
for name, d in devices:
    print('  %-20s PinX=%.2f PinY=%.2f W=%.2f H=%.2f' % (name, d['PinX'], d['PinY'], d['Width'], d['Height']))
print('线:')
for i, ln in enumerate(lines):
    print('  #%d Begin(%.2f,%.2f) End(%.2f,%.2f)' % (i, ln['BeginX'], ln['BeginY'], ln['EndX'], ln['EndY']))
    # 端点距离最近设备边框的距离
    for px, py, tag in [(ln['BeginX'], ln['BeginY'], 'B'), (ln['EndX'], ln['EndY'], 'E')]:
        best = None
        for name, d in devices:
            if 'PinX' not in d:
                continue
            hw, hh = d['Width'] / 2, d['Height'] / 2
            dx = max(abs(px - d['PinX']) - hw, 0)
            dy = max(abs(py - d['PinY']) - hh, 0)
            dist = (dx * dx + dy * dy) ** 0.5
            if best is None or dist < best[0]:
                best = (dist, name)
        print('     %s 端最近设备: %s 距离 %.3f in' % (tag, best[1], best[0]))
vis.close_vsdx()
