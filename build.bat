@echo off
rem NetTopo 便携版构建：自动升级版本号 -> electron-builder 打包
cd /d "%~dp0"
call npm run build
