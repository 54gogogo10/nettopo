/* NetTopo electron-builder afterPack 钩子：给打包产物烧录 Electron fuses（安全加固）。
 *  - RunAsNode / EnableNodeOptionsEnvironmentVariable / EnableNodeCliInspectArguments 关闭：
 *    便携版 exe 不再能被 ELECTRON_RUN_AS_NODE=1 / NODE_OPTIONS / --inspect 当纯 Node 运行，
 *    杜绝同机用户借环境变量注入绕过渲染层全部防线（CSP / contextIsolation / IPC 校验）；
 *  - OnlyLoadAppFromAsar + EnableEmbeddedAsarIntegrityValidation：应用只能从 app.asar 加载，
 *    且校验 electron-builder 写入 exe 资源段的 asar 完整性（防篡改应用代码）；
 *  - GrantFileProtocolExtraPrivileges 关闭：file:// 不获得额外的特权读取。
 * Linux 交叉打包（electron-builder-linux.yml）复用同一钩子（ELF 同样支持烧录）。 */
const path = require('path');
const { flipFuses, FuseV1Options, FuseVersion } = require('@electron/fuses');

exports.default = async function afterPack(context) {
  const name = context.packager.appInfo.productFilename;
  const exeName = context.electronPlatformName === 'win32' ? name + '.exe' : name;
  const exePath = path.join(context.appOutDir, exeName);
  console.log('  • afterPack: 烧录 Electron fuses →', exeName);
  await flipFuses(exePath, {
    version: FuseVersion.v1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false
  });
};
