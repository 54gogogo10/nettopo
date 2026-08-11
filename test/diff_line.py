# 对比真实 Visio 连线 vs 我的连线：全部 Cell 与属性
import vsdx

NS = '{http://schemas.microsoft.com/office/visio/2012/main}'

def dump_line(path, tag):
    vis = vsdx.VisioFile(path)
    page = vis.get_page(0)
    for s in page.child_shapes:
        xml = s.xml
        cells = {}
        for c in xml.iter(NS + 'Cell'):
            cells[c.get('N')] = (c.get('V'), c.get('F'))
        if 'BeginX' in cells:
            print('===== %s 连线 Shape =====' % tag)
            print('Shape 属性:', {a: v for a, v in xml.attrib.items() if a != '{http://schemas.microsoft.com/office/visio/2012/main}xml:space'})
            for k in sorted(cells):
                v, f = cells[k]
                print('  %-14s V=%-24s F=%s' % (k, str(v)[:24], f))
            # 几何
            for sec in xml.iter(NS + 'Section'):
                if sec.get('N') == 'Geometry':
                    for row in sec.iter(NS + 'Row'):
                        rv = {}
                        for c in row.iter(NS + 'Cell'):
                            rv[c.get('N')] = (c.get('V'), c.get('F'))
                        print('  Geom %s %s' % (row.get('T'), rv))
            print()
            vis.close_vsdx()
            return
    vis.close_vsdx()

dump_line('test/_user2345.vsdx', '我的')
dump_line('test/_real.vsdx', '真实Visio')
