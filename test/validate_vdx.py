# 用官方 visio.xsd 校验 VDX 文件
import sys
from lxml import etree

xsd_path = 'test/visio2003.xsd'
vdx_path = sys.argv[1] if len(sys.argv) > 1 else 'test/sample_topology.vdx'

xsd = etree.XMLSchema(etree.parse(xsd_path))
doc = etree.parse(vdx_path)
ok = xsd.validate(doc)
print('RESULT:', 'PASS' if ok else 'FAIL')
if not ok:
    for err in xsd.error_log:
        print('  line %d: %s' % (err.line, err.message))
