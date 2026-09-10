/* NetTopo 网络服务管理器 —— 主进程纯 Node 模块（不依赖 Electron）
 * 汇聚 TFTP / FTP / Syslog 三个内置服务器：
 *   - 配置归一化（端口钳制、账号/开关校验）与应用（按需启动/停止/热更新，不无谓重启）
 *   - TFTP/FTP 收到的文件统一编目（listFiles/readFile/deleteFile，路径白名单校验）
 *   - 收到的配置文件一键导入设备配置备份库（ConfigBackupStore，进入备份中心/合规检查体系）
 *   - Syslog 环形缓冲增量拉取与跨文件检索转发；关键字/级别告警规则热更新并转发 syslog-alert 事件
 * 配置持久化由 electron-main.js 存 settings.json，本模块只负责运行态。
 * 可在 Node 测试中直接使用。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { TftpServer } = require('./svc-tftp.js');
const { FtpServer } = require('./svc-ftp.js');
const { SyslogServer, normalizeAlertRules } = require('./svc-syslog.js');
const { TrapServer } = require('./svc-trap.js');

const READ_CAP = 2 * 1024 * 1024;   // 单文件预览上限
const LIST_CAP = 300;               // 文件列表条数上限

/** 默认配置（端口 69/21/514/162 为协议标准端口；Linux 非 root 绑定失败时面板会提示改高位端口） */
function defaultConfig() {
  return {
    tftp: { enabled: false, port: 69 },
    ftp: { enabled: false, port: 21, username: 'nettopo', password: 'nettopo', pasvMin: 0, pasvMax: 0, overwrite: true },
    syslog: { enabled: false, port: 514, tcp: false, alert: { enabled: false, severity: 3, keywords: [], cooldownSec: 300 } },
    trap: { enabled: false, port: 162, community: '', v3: { user: '', authProto: 'sha', authPass: '', privProto: 'aes', privPass: '' } }
  };
}

function clampPort(v, dft) {
  const n = Math.floor(Number(v));
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : dft;
}
function clampB(v, dft) {
  return typeof v === 'boolean' ? v : dft;
}
function cleanCred(v, dft) {
  let s = String(v == null ? '' : v);
  // 控制字符一律剔除（防 CR/LF 注入协议行）
  s = s.replace(/[\u0000-\u001f\u007f]/g, '');
  s = s.trim().slice(0, 64);
  return s || dft;
}

const DEFAULT_FTP_PASSWORD = 'nettopo';
/** 随机 FTP 口令（16 位，排除易混字符；与面板自动生成同口径） */
function randomFtpPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const buf = crypto.randomBytes(16);
  let s = '';
  for (let i = 0; i < buf.length; i++) s += chars[buf[i] % chars.length];
  return s;
}

/** 配置归一化：非法值回退默认；返回新配置对象（不抛错，保证任何输入都得到可用配置） */
function normalizeConfig(cfg) {
  const dft = defaultConfig();
  const out = defaultConfig();
  cfg = cfg && typeof cfg === 'object' ? cfg : {};
  const t = cfg.tftp && typeof cfg.tftp === 'object' ? cfg.tftp : {};
  out.tftp.enabled = clampB(t.enabled, dft.tftp.enabled);
  out.tftp.port = clampPort(t.port, dft.tftp.port);
  const f = cfg.ftp && typeof cfg.ftp === 'object' ? cfg.ftp : {};
  out.ftp.enabled = clampB(f.enabled, dft.ftp.enabled);
  out.ftp.port = clampPort(f.port, dft.ftp.port);
  out.ftp.username = cleanCred(f.username, dft.ftp.username);
  // 服务端强制改弱口令：FTP 面向全网段监听且明文传输，默认口令 nettopo 等同无认证。
  // 面板保存路径已生成随机口令，但旧版本启用后未再打开面板的用户会带着默认口令运行——
  // 此处兜底：开启 FTP 且口令仍为默认值的，一律换成随机口令（_ftpPasswordChanged 标记供
  // electron-main 落盘新口令、渲染层回填表单）。
  out.ftp.password = cleanCred(f.password, dft.ftp.password);
  out._ftpPasswordChanged = false;
  if (out.ftp.enabled && out.ftp.password === DEFAULT_FTP_PASSWORD) {
    out.ftp.password = randomFtpPassword();
    out._ftpPasswordChanged = true;
  }
  let pmin = Math.floor(Number(f.pasvMin) || 0), pmax = Math.floor(Number(f.pasvMax) || 0);
  if (!(pmin >= 1024 && pmax >= pmin && pmax - pmin <= 2000)) { pmin = 0; pmax = 0; }
  out.ftp.pasvMin = pmin;
  out.ftp.pasvMax = pmax;
  out.ftp.overwrite = clampB(f.overwrite, true);
  const s = cfg.syslog && typeof cfg.syslog === 'object' ? cfg.syslog : {};
  out.syslog.enabled = clampB(s.enabled, dft.syslog.enabled);
  out.syslog.port = clampPort(s.port, dft.syslog.port);
  out.syslog.tcp = clampB(s.tcp, dft.syslog.tcp);
  out.syslog.alert = normalizeAlertRules(s.alert && typeof s.alert === 'object' ? s.alert : dft.syslog.alert);
  const tr = cfg.trap && typeof cfg.trap === 'object' ? cfg.trap : {};
  out.trap.enabled = clampB(tr.enabled, dft.trap.enabled);
  out.trap.port = clampPort(tr.port, dft.trap.port);
  // v1/v2c 团体字白名单（逗号分隔，最多 16 个）：控制字符已由 cleanCred 剔除
  out.trap.community = String(tr.community == null ? '' : tr.community).split(/[,，;；\n]+/)
    .map(x => cleanCred(x, '')).filter(Boolean).slice(0, 16).join(',');
  const tv = tr.v3 && typeof tr.v3 === 'object' ? tr.v3 : {};
  out.trap.v3 = {
    user: cleanCred(tv.user, ''),
    authProto: String(tv.authProto).toLowerCase() === 'md5' ? 'md5' : 'sha',
    authPass: cleanCred(tv.authPass, ''),
    privProto: String(tv.privProto).toLowerCase() === 'des' ? 'des' : 'aes',
    privPass: cleanCred(tv.privPass, '')
  };
  return out;
}

class NetServices extends EventEmitter {
  /** @param opts { baseDir, configBackup }（configBackup 可空：仅收文件不提供导入） */
  constructor(opts) {
    super();
    opts = opts || {};
    this.baseDir = opts.baseDir;
    this.configBackup = opts.configBackup || null;
    this.tftpDir = path.join(this.baseDir, 'tftp');
    this.ftpDir = path.join(this.baseDir, 'ftp');
    this.syslogDir = path.join(this.baseDir, 'syslog');
    this.trapDir = path.join(this.baseDir, 'trap');
    this.cfg = defaultConfig();
    this.applied = { tftp: null, ftp: null, syslog: null, trap: null }; // 各服务当前生效参数（判断是否需要重启）
    this.tftp = new TftpServer({ rootDir: this.tftpDir });
    this.ftp = new FtpServer({ rootDir: this.ftpDir });
    this.syslog = new SyslogServer({ baseDir: this.syslogDir });
    this.trap = new TrapServer({ baseDir: this.trapDir });
    this.tftp.on('file', (info) => this.emit('file', info));
    this.ftp.on('file', (info) => this.emit('file', info));
    this.syslog.on('alert', (a) => this.emit('syslog-alert', a));
    this.trap.on('trap', (t) => this.emit('trap', t));
  }

  getConfig() { return JSON.parse(JSON.stringify(this.cfg)); }

  /** 应用配置：仅重启参数真正变化的服务；认证类变化热更新不重启。
   *  串行化：并发 applyConfig（启动恢复 vs 面板保存、快速连续保存）会在 await stop 与
   *  new 替换实例之间交错——被甩掉的实例已 start 成功则监听端口永久泄漏，
   *  applied 标记又被后完成者覆盖为 null：面板显示未运行、后续重试恒 EADDRINUSE 直到重启 */
  applyConfig(cfg) {
    const run = (this._queue || Promise.resolve()).then(() => this._apply(cfg));
    this._queue = run.catch(() => { /* 队列不断链：失败已体现在各服务 status 里 */ });
    return run;
  }

  async _apply(cfg) {
    const n = normalizeConfig(cfg);
    this.cfg = n;
    // TFTP：端口变化或启停才动
    if (!n.tftp.enabled) {
      if (this.applied.tftp) { await this.tftp.stop(); this.applied.tftp = null; }
    } else if (!this.applied.tftp || this.applied.tftp.port !== n.tftp.port) {
      await this.tftp.stop();
      const r = await this.tftp.start(n.tftp.port);
      // 启动失败（端口被占等）不记录 applied：否则同端口配置被短路永不再尝试启动，错误粘滞到重启
      this.applied.tftp = (r && r.ok) ? { port: n.tftp.port } : null;
    }
    // FTP：端口/被动范围变化或启停才重启；账号/覆盖热更新
    if (!n.ftp.enabled) {
      if (this.applied.ftp) { await this.ftp.stop(); this.applied.ftp = null; }
    } else {
      const a = this.applied.ftp;
      const portChanged = !a || a.port !== n.ftp.port || a.pasvMin !== n.ftp.pasvMin || a.pasvMax !== n.ftp.pasvMax;
      if (portChanged) {
        await this.ftp.stop();
        this.ftp = new FtpServer({
          rootDir: this.ftpDir, username: n.ftp.username, password: n.ftp.password,
          pasvMin: n.ftp.pasvMin, pasvMax: n.ftp.pasvMax, overwrite: n.ftp.overwrite
        });
        this.ftp.on('file', (info) => this.emit('file', info));
        const r = await this.ftp.start(n.ftp.port);
        this.applied.ftp = (r && r.ok) ? { port: n.ftp.port, pasvMin: n.ftp.pasvMin, pasvMax: n.ftp.pasvMax } : null;
      } else {
        this.ftp.setAuth({ username: n.ftp.username, password: n.ftp.password, overwrite: n.ftp.overwrite });
      }
    }
    // Syslog：端口/TCP 开关变化或启停才重启；告警规则热更新（不重启，即刻生效）
    if (!n.syslog.enabled) {
      if (this.applied.syslog) { await this.syslog.stop(); this.applied.syslog = null; }
    } else {
      if (!this.applied.syslog || this.applied.syslog.port !== n.syslog.port || this.applied.syslog.tcp !== n.syslog.tcp) {
        await this.syslog.stop();
        const r = await this.syslog.start(n.syslog.port, n.syslog.tcp);
        this.applied.syslog = (r && r.ok) ? { port: n.syslog.port, tcp: n.syslog.tcp } : null;
      }
      this.syslog.setAlertRules(n.syslog.alert);
    }
    // Trap：端口变化或启停才重启
    if (!n.trap.enabled) {
      if (this.applied.trap) { await this.trap.stop(); this.applied.trap = null; }
    } else {
      const v3sig = JSON.stringify(n.trap.v3) + '|' + n.trap.community;
      if (!this.applied.trap || this.applied.trap.port !== n.trap.port || this.applied.trap.v3sig !== v3sig) {
        await this.trap.stop();
        this.trap = new TrapServer({ baseDir: this.trapDir, v3Users: n.trap.v3.user ? [n.trap.v3] : [], communities: n.trap.community ? n.trap.community.split(',') : [] });
        this.trap.on('trap', (t) => this.emit('trap', t));
        const r = await this.trap.start(n.trap.port);
        this.applied.trap = (r && r.ok) ? { port: n.trap.port, v3sig } : null;
      }
    }
    this.emit('status', this.status());
    return this.status();
  }

  status() {
    const ts = this.tftp.status(), fs2 = this.ftp.status(), ss = this.syslog.status(), trs = this.trap.status();
    return {
      tftp: Object.assign({ enabled: this.cfg.tftp.enabled, cfgPort: this.cfg.tftp.port }, ts),
      ftp: Object.assign({ enabled: this.cfg.ftp.enabled, cfgPort: this.cfg.ftp.port }, fs2),
      syslog: Object.assign({ enabled: this.cfg.syslog.enabled, cfgPort: this.cfg.syslog.port }, ss),
      trap: Object.assign({ enabled: this.cfg.trap.enabled, cfgPort: this.cfg.trap.port }, trs)
    };
  }

  async stopAll() {
    await Promise.all([this.tftp.stop(), this.ftp.stop(), this.syslog.stop(), this.trap.stop()]);
    this.applied = { tftp: null, ftp: null, syslog: null, trap: null };
    this.emit('status', this.status());
  }

  _svcDir(svc) {
    if (svc === 'tftp') return this.tftpDir;
    if (svc === 'ftp') return this.ftpDir;
    return null;
  }

  /** 收到的文件编目（TFTP 按来源 IP 分目录；FTP 根目录与一级子目录都计入），时间倒序 */
  listFiles() {
    const out = [];
    const walk = (svc, root) => {
      let names = [];
      try { names = fs.readdirSync(root); } catch (e) { return; }
      for (const n of names) {
        if (n.endsWith('.part') || n.includes('.part-')) continue;
        const full = path.join(root, n);
        let st;
        try { st = fs.lstatSync(full); } catch (e) { continue; }
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
          // 一级子目录（TFTP 的来源 IP 目录 / FTP 用户自建目录）：只收其中的直接文件
          let subs = [];
          try { subs = fs.readdirSync(full); } catch (e) { subs = []; }
          for (const f of subs) {
            if (f.endsWith('.part') || f.includes('.part-')) continue;
            const fp = path.join(full, f);
            let st2;
            try { st2 = fs.lstatSync(fp); } catch (e) { continue; }
            if (!st2.isFile() || st2.isSymbolicLink()) continue;
            out.push({ svc, ip: n, name: f, size: st2.size, time: st2.mtimeMs });
          }
        } else if (st.isFile()) {
          out.push({ svc, ip: '', name: n, size: st.size, time: st.mtimeMs });
        }
      }
    };
    walk('tftp', this.tftpDir);
    walk('ftp', this.ftpDir);
    out.sort((a, b) => b.time - a.time);
    return { ok: true, items: out.slice(0, LIST_CAP) };
  }

  /** 定位一个收到的文件（白名单校验 + 库内路径校验）。返回绝对路径或 null */
  _resolveFile(p) {
    const svc = p && p.svc;
    const root = this._svcDir(svc);
    if (!root) return null;
    const ip = String((p && p.ip) || '').trim();
    const name = String((p && p.name) || '').trim();
    // 冒号一并拒收：Windows 上 "file.txt:ads" 形态会命中 NTFS 交替数据流（与全库清洗口径一致）
    if (!name || name.indexOf('/') >= 0 || name.indexOf('\\') >= 0 || name.indexOf('..') >= 0 || name.indexOf(':') >= 0 || name.length > 200) return null;
    // ip 段同口径拒冒号（"c:" 跨盘相对形态）与单点（resolve 回库根绕过子目录语义）
    if (ip && (ip.indexOf('/') >= 0 || ip.indexOf('\\') >= 0 || ip.indexOf('..') >= 0 || ip.indexOf(':') >= 0 || ip === '.' || ip.length > 80)) return null;
    const base = path.resolve(root) + path.sep;
    const sub = ip || '.';                 // 来源 IP 子目录（已过分隔符/穿越白名单）或库根
    const dir = path.resolve(root, sub);
    const full = path.resolve(dir, name);  // name 已过白名单：两段 resolve 分步归一
    if ((dir !== path.resolve(root) && !dir.startsWith(base)) || !full.startsWith(base)) return null; // 双重边界终判（dir 允许为库根本身）
    return full;
  }

  readFile(p) {
    const full = this._resolveFile(p);
    if (!full) return { ok: false, error: '非法的文件路径' };
    try {
      const st = fs.lstatSync(full);
      if (!st.isFile() || st.isSymbolicLink()) return { ok: false, error: '文件不存在' };
      if (st.size > READ_CAP) return { ok: false, error: '文件过大（超过 2MB），请打开目录查看' };
      return { ok: true, content: fs.readFileSync(full, 'utf8'), size: st.size };
    } catch (e) {
      return { ok: false, error: '文件不存在或读取失败' };
    }
  }

  deleteFile(p) {
    const full = this._resolveFile(p);
    if (!full) return { ok: false, error: '非法的文件路径' };
    try {
      fs.unlinkSync(full);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e && e.code === 'ENOENT') ? '文件不存在' : '删除失败' };
    }
  }

  /** 把收到的配置文件导入设备配置备份库（进入备份中心 / 合规检查体系） */
  importBackup(p) {
    if (!this.configBackup) return { ok: false, error: '备份库不可用' };
    const device = String((p && p.device) || '').trim();
    const host = String((p && p.host) || (p && p.ip) || '').trim();
    if (!device) return { ok: false, error: '请选择设备' };
    if (!host) return { ok: false, error: '缺少来源地址' };
    const rf = this.readFile(p);
    if (!rf.ok) return rf;
    const r = this.configBackup.save(device, host, rf.content);
    if (r && r.ok) return { ok: true, name: r.name, device: device, host: host, size: rf.size };
    return r;
  }

  /** 目录句柄（electron-main 打开文件夹用） */
  dirOf(svc) {
    if (svc === 'syslog') return this.syslogDir;
    if (svc === 'trap') return this.trapDir;
    const d = this._svcDir(svc);
    if (!d) return null;
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* ignore */ }
    return d;
  }

  syslogTail(sinceSeq) { return this.syslog.tail(sinceSeq); }
  syslogSearch(q) { return this.syslog.search(q || {}); }
  trapTail(sinceSeq) { return this.trap.tail(sinceSeq); }
}

module.exports = { NetServices, defaultConfig, normalizeConfig };
