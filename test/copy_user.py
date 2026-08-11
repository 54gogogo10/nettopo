import glob, shutil, os

files = glob.glob(r'C:\Users\chen\Downloads\*.vsdx')
print('找到:', [os.path.basename(f) for f in files])
if files:
    files.sort(key=os.path.getmtime, reverse=True)
    shutil.copy(files[0], 'test/_user.vsdx')
    print('已复制最新:', os.path.basename(files[0]))
