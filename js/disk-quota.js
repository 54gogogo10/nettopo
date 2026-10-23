/* NetTopo 全库字节配额 —— 纯 Node（主进程使用，可单测；不依赖 Electron）
 *
 * 要解决的问题：数据保留策略碎片化——Syslog/Trap 有全库字节配额（超限丢档计数），
 * 而同样持续写入的**监控日志**（含 Web Shell 审计）只按 90 天日期删、**设备配置备份库**
 * 只按「每主机 50 份」滚动：7×24 高输出设备可以把 userData 所在磁盘写满且毫无防线。
 * 本模块把「记账 + 实扫校准 + 写前检查」的口径收敛到一处，供上述两处补上配额闸门。
 *
 * 语义：
 * - check(addBytes) 写入前检查：配额内记账返回 true，超限返回 false（调用方自行决定
 *   丢新（日志类）还是先淘汰最旧再写（备份库类））；
 * - scan(rootDir) 实扫目录树校准（跳过符号链接；文件数封顶防异常目录拖死调用方，
 *   截断时如实置 truncated——配额是粗防线，统计不完整时不假装精确）；
 * - release(bytes) 删除后的负记账。 */
'use strict';

const fs = require('fs');
const path = require('path');

const MIN_QUOTA_BYTES = 1024 * 1024;        // 配额下限 1MB（写成 0/负数毫无意义）
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024; // 默认 1GB（与 Syslog/Trap 全库配额同口径）
const MAX_SCAN_FILES = 50000;               // 实扫文件数上限

class DiskQuota {
  /** @param {object} [opts] { maxBytes } */
  constructor(opts) {
    opts = opts || {};
    const raw = Math.floor(Number(opts.maxBytes) || 0);
    this.maxBytes = raw >= MIN_QUOTA_BYTES ? raw : DEFAULT_MAX_BYTES;
    this.usedBytes = 0;
    this.scannedFiles = 0;
    this.truncated = false;
  }

  /** 实扫目录树求和（跳过符号链接与非常规文件），重置并返回 usedBytes */
  scan(rootDir) {
    this.usedBytes = 0;
    this.scannedFiles = 0;
    this.truncated = false;
    const walk = (dir) => {
      let names = [];
      try { names = fs.readdirSync(dir); } catch (e) { return; }
      for (const nm of names) {
        if (this.scannedFiles >= MAX_SCAN_FILES) { this.truncated = true; return; }
        const p = path.join(dir, nm);
        let st;
        try { st = fs.lstatSync(p); } catch (e) { continue; }
        if (st.isSymbolicLink()) continue;      // 纵深：符号链接不计入也不跟随（防穿越重复计数）
        if (st.isDirectory()) { walk(p); continue; }
        if (st.isFile()) { this.scannedFiles++; this.usedBytes += st.size; }
      }
    };
    walk(String(rootDir || ''));
    return this.usedBytes;
  }

  /** 写入前检查：配额内记账返回 true；超限返回 false（不记账） */
  check(addBytes) {
    const n = Math.max(0, Math.floor(Number(addBytes) || 0));
    if (this.usedBytes + n > this.maxBytes) return false;
    this.usedBytes += n;
    return true;
  }

  /** 删除/释放后的负记账（不会减到负数） */
  release(bytes) {
    this.usedBytes = Math.max(0, this.usedBytes - Math.max(0, Math.floor(Number(bytes) || 0)));
  }

  /** 当前是否在配额内 */
  ok() { return this.usedBytes <= this.maxBytes; }
}

// 双形态导出：Node 走 CommonJS，渲染层直接以 <script> 加载时挂 globalThis（裸 module 引用在浏览器抛 ReferenceError）
if (typeof module !== 'undefined' && module.exports) module.exports = { DiskQuota, DEFAULT_MAX_BYTES, MIN_QUOTA_BYTES, MAX_SCAN_FILES };
if (typeof globalThis !== 'undefined') globalThis.TopoDiskQuota = { DiskQuota, DEFAULT_MAX_BYTES, MIN_QUOTA_BYTES, MAX_SCAN_FILES };
