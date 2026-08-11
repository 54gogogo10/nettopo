# 用 python-vsdx 生成最小 VSDX 参考文件，解包分析结构
import vsdx
from vsdx import VisioFile
import os, zipfile, shutil

out = 'test/ref_minimal.vsdx'
if os.path.exists(out):
    os.remove(out)

vis = VisioFile.new_blank_file(out)
vis.save_vsdx(out)
vis.close()

print('生成:', out, os.path.getsize(out), 'bytes')

# 解包查看结构
extract = 'test/ref_vsdx_unpacked'
shutil.rmtree(extract, ignore_errors=True)
os.makedirs(extract)
with zipfile.ZipFile(out) as z:
    for n in z.namelist():
        print('  ', n)
        z.extract(n, extract)
