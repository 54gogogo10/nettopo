import os, glob

p = r'C:\Users\chen\Downloads'
print('存在:', os.path.exists(p))
try:
    names = os.listdir(p)
    print('文件数:', len(names))
    for n in names:
        if n.endswith('.vsdx') or n.endswith('.vdx'):
            print('  ', n, os.path.getmtime(os.path.join(p, n)))
except Exception as e:
    print('listdir 失败:', e)
