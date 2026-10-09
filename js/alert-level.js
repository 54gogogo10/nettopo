/* NetTopo 告警等级与分级提示音 —— 纯逻辑（主进程 / 渲染层共用，不依赖 Electron）
 *
 * 解决什么问题：此前所有告警只有「弹 / 不弹」一个维度——设备离线、证书还剩 3 天、配置有一行变化，
 * 提示方式完全一样。值班时要么被无关紧要的提示音牵着走，要么干脆把通知全关掉（连真正的离线一起关）。
 *
 * 本模块给出三件事：
 *  1) 等级：提示(info) < 警告(warning) < 严重(critical) < 紧急(emergency)；
 *     每种事件类型有默认等级（EVENT_LEVELS），用户可在「告警等级与提示音…」里逐项改写（覆盖存 settings.json）。
 *  2) 分级音效：每个等级一段可合成的音型（频率/时长/波形，见 SOUNDS）——渲染层用 WebAudio 现场合成，
 *     不引入任何音频文件（离线可用、CSP 无外链）。
 *  3) 声音开关：总开关 + 最低发声等级 + 音量；关闭后连系统通知提示音一并静音（主进程通知发 silent=true）。
 *
 * 诚实标注：等级是「提醒优先级」而不是「故障严重性排名」——例如「设备恢复」是 info，
 * 不代表故障不严重，只代表不需要半夜为它响铃。
 */
/* 现场加载方式与 util/pdf 一致：IIFE 包裹（渲染层是普通 <script>，顶层 const 会与其它脚本共享
 * 全局词法作用域——顶层声明重名会让整个脚本 SyntaxError 直接不执行，例如 l2-topo.js 也有一个 API） */
(function (global) {
'use strict';

/* ---------- 等级 ---------- */
const LEVELS = ['info', 'warning', 'critical', 'emergency'];
const LEVEL_NAMES = { info: '提示', warning: '警告', critical: '严重', emergency: '紧急' };
/** 等级次序（比较用）：数值越大越紧急 */
const LEVEL_RANK = { info: 0, warning: 1, critical: 2, emergency: 3 };
const DEFAULT_LEVEL = 'warning';
const DEFAULT_MIN_LEVEL = 'warning';
const DEFAULT_VOLUME = 0.6;

/** 事件类型 → 默认等级。键与主进程 recordMonitorEvent 的 type 同名（事件时间线同一套口径）。
 *  只列「会产生通知或需要值班关注」的类型；未列出的类型一律回退 DEFAULT_LEVEL。 */
const EVENT_LEVELS = {
  offline: 'emergency',        // 设备离线：值班第一优先
  recovery: 'info',
  alert: 'critical',           // 输出关键字命中
  'alert-clear': 'info',
  'if-down': 'critical',       // 接口离线（SNMP linkDown/ifOperStatus）
  'if-up': 'info',
  'if-error': 'warning',       // 接口错包速率超阈值（链路质量劣化早期信号，未中断）
  'if-error-clear': 'info',
  'alert-escalate': 'critical', // 告警升级重发（未确认超时；自身永不参与升级，见 pickEscalations）
  metric: 'warning',           // 磁盘/内存/负载超阈值
  'metric-clear': 'info',
  'http-fail': 'critical',     // HTTP 健康探测失败
  'http-ok': 'info',
  cert: 'warning',             // 证书剩余天数低于阈值
  'cert-clear': 'info',
  compliance: 'critical',      // 配置合规违规
  reboot: 'warning',           // sysUpTime 骤减
  'backup-error': 'warning',
  'backup-change': 'info',     // 配置有变化：需要知道，但不值得半夜响铃
  backup: 'info',
  trap: 'warning',             // 标准 Trap（linkDown/认证失败按 levelFromTrap 上调）
  'syslog-alert': 'warning',   // 按日志级别由 levelFromSyslogSeverity 细调
  'deploy-error': 'critical',
  deploy: 'info',
  proto: 'warning',            // BGP/OSPF 邻居异常（持续监控去抖后的状态沿）
  'proto-clear': 'info',
  'link-down': 'critical',     // 端到端链路/路径中断（连通性监测）
  'link-up': 'info',           // 链路恢复
  trust: 'warning',            // 首次信任主机指纹（安全敏感）
  file: 'info',                // 内置网络服务收到设备推送的文件
  'ai-daily': 'info',          // AI 巡检日报已生成
  'ai-daily-error': 'warning',
  'cred-degraded': 'critical'  // 凭据保护降级（无系统密钥环）——安全事件
};

/** 设置界面用的事件清单（顺序即展示顺序，label 与时间线中文名一致） */
const EVENT_TYPES = [
  { type: 'offline', label: '设备离线' },
  { type: 'recovery', label: '设备恢复' },
  { type: 'alert', label: '输出关键字告警' },
  { type: 'alert-clear', label: '关键字告警解除' },
  { type: 'if-down', label: '接口离线' },
  { type: 'if-up', label: '接口恢复' },
  { type: 'if-error', label: '接口错包超阈值' },
  { type: 'if-error-clear', label: '接口错包恢复' },
  { type: 'metric', label: '指标超阈值' },
  { type: 'metric-clear', label: '指标恢复' },
  { type: 'http-fail', label: 'HTTP 探测失败' },
  { type: 'http-ok', label: 'HTTP 探测恢复' },
  { type: 'cert', label: '证书即将到期' },
  { type: 'cert-clear', label: '证书恢复' },
  { type: 'compliance', label: '配置合规违规' },
  { type: 'reboot', label: '设备重启' },
  { type: 'backup-error', label: '配置备份失败' },
  { type: 'backup-change', label: '配置有变化' },
  { type: 'trap', label: 'SNMP Trap' },
  { type: 'syslog-alert', label: 'Syslog 告警' },
  { type: 'deploy-error', label: '配置下发失败' },
  { type: 'proto', label: '三层邻居异常' },
  { type: 'proto-clear', label: '三层邻居恢复' },
  { type: 'link-down', label: '链路中断' },
  { type: 'link-up', label: '链路恢复' },
  { type: 'trust', label: '首次信任主机指纹' },
  { type: 'file', label: '收到设备推送文件' },
  { type: 'ai-daily', label: 'AI 巡检日报已生成' },
  { type: 'ai-daily-error', label: 'AI 巡检日报失败' },
  { type: 'cred-degraded', label: '凭据保护降级' }
];

/* ---------- 分级音效（渲染层 WebAudio 合成规格，无音频文件） ----------
 * waves：依次播放的音（f 频率 Hz，d 时长秒，after 之后的静默秒数，type 波形）
 * gain：该等级音量系数（再乘用户音量） */
const SOUNDS = {
  info: { gain: 0.5, waves: [{ f: 880, d: 0.09, after: 0, type: 'sine' }] },
  warning: { gain: 0.7, waves: [{ f: 760, d: 0.11, after: 0.06, type: 'sine' }, { f: 760, d: 0.11, after: 0, type: 'sine' }] },
  critical: { gain: 0.85, waves: [{ f: 1046, d: 0.11, after: 0.05, type: 'triangle' }, { f: 784, d: 0.11, after: 0.05, type: 'triangle' }, { f: 1046, d: 0.15, after: 0, type: 'triangle' }] },
  emergency: { gain: 1, waves: [{ f: 1200, d: 0.16, after: 0.04, type: 'triangle' }, { f: 600, d: 0.16, after: 0.04, type: 'triangle' }, { f: 1200, d: 0.16, after: 0.04, type: 'triangle' }, { f: 600, d: 0.24, after: 0, type: 'triangle' }] }
};
/** 最短发声间隔（毫秒）：多台设备同时掉线时不至于糊成一片，渲染层按最高等级合并播放 */
const MIN_GAP_MS = 900;

const isLevel = (v) => LEVELS.indexOf(v) >= 0;
const rankOf = (v) => (isLevel(v) ? LEVEL_RANK[v] : -1);
const levelName = (v) => LEVEL_NAMES[v] || String(v == null ? '' : v);
/** 归一化等级：非法值回退 dft（默认 DEFAULT_LEVEL） */
function normalizeLevel(v, dft) {
  if (isLevel(v)) return v;
  return isLevel(dft) ? dft : DEFAULT_LEVEL;
}
/** 等级是否达到最低门槛（门槛非法时按默认门槛） */
function meetsMin(level, minLevel) {
  return rankOf(level) >= rankOf(isLevel(minLevel) ? minLevel : DEFAULT_MIN_LEVEL);
}

/** 事件等级：用户覆盖 > 默认表 > DEFAULT_LEVEL */
function levelFor(type, overrides) {
  const t = String(type == null ? '' : type);
  const ov = (overrides && typeof overrides === 'object') ? overrides : null;
  if (ov && isLevel(ov[t])) return ov[t];
  if (isLevel(EVENT_LEVELS[t])) return EVENT_LEVELS[t];
  return DEFAULT_LEVEL;
}
/** 归一化用户的等级覆盖表：只保留已知事件类型与合法等级（恶意/损坏设置不得影响其它类型） */
function normalizeOverrides(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const k of Object.keys(EVENT_LEVELS)) {
    const v = raw[k];
    if (isLevel(v)) out[k] = v;
  }
  return out;
}

/** 归一化声音设置：任何输入都返回可用的 {enabled, minLevel, volume, escalateMin}
 *  escalateMin：未确认告警升级重发的分钟数（0 = 关闭，默认关闭不改变既有行为） */
function normalizeSoundSettings(raw) {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  let vol = Number(r.volume);
  if (!Number.isFinite(vol)) vol = DEFAULT_VOLUME;
  vol = Math.max(0, Math.min(1, vol));
  let esc = parseInt(r.escalateMin, 10);
  if (!Number.isFinite(esc)) esc = 0;
  esc = Math.max(0, Math.min(1440, esc));
  return {
    enabled: r.enabled !== false,
    minLevel: isLevel(r.minLevel) ? r.minLevel : DEFAULT_MIN_LEVEL,
    volume: vol,
    escalateMin: esc
  };
}
/** 该等级此刻是否应当发声（总开关 + 最低等级门槛） */
function shouldPlay(level, sound) {
  const st = normalizeSoundSettings(sound);
  if (!st.enabled) return false;
  return meetsMin(normalizeLevel(level), st.minLevel);
}
/** 等级升一档（emergency 封顶）：告警升级重发用 */
function bumpLevel(level) {
  const v = normalizeLevel(level);
  return LEVELS[Math.min(LEVELS.length - 1, LEVELS.indexOf(v) + 1)];
}
/** 告警升级挑选（纯函数，主进程扫描器与单测共用）：
 *  未确认 + 未升级过 + 等级达门槛 + 超时未确认 → 升一级重发。
 *  opts: { now, minMinutes(>0 才启用), minLevel(默认 warning), maxPerRun(默认 5) }
 *  返回 [{ts, type, level, newLevel, name, detail, deviceId, host, key, ageMin}]；
 *  升级产生的时间线条目（type='alert-escalate'）自身永不入选——防自我连锁。 */
function pickEscalations(events, opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const minMs = (Math.max(0, Number(o.minMinutes) || 0)) * 60000;
  if (!(minMs > 0)) return [];
  const minRank = rankOf(isLevel(o.minLevel) ? o.minLevel : 'warning');
  const cap = Math.max(1, Number(o.maxPerRun) || 5);
  const out = [];
  for (const e of (Array.isArray(events) ? events : [])) {
    if (out.length >= cap) break;
    if (!e || !Number.isFinite(e.ts) || e.ackAt || e.escalatedAt) continue;
    if (e.type === 'alert-escalate') continue;
    if ((rankOf(normalizeLevel(e.level)) || 0) < minRank) continue;
    const age = now - e.ts;
    if (age < minMs) continue;
    out.push({
      ts: e.ts, type: String(e.type || ''), level: normalizeLevel(e.level), newLevel: bumpLevel(e.level),
      name: e.name || '', detail: e.detail || '', deviceId: e.deviceId || '', host: e.host || '', key: e.key || '',
      ageMin: Math.floor(age / 60000)
    });
  }
  return out;
}
/** 某等级的音效规格（未知等级按 DEFAULT_LEVEL） */
function soundSpec(level) {
  return SOUNDS[normalizeLevel(level)] || SOUNDS[DEFAULT_LEVEL];
}
/** 某等级音效总时长（毫秒，含各音之间的静默；渲染层的排程与节流都以此为准） */
function soundDurationMs(level) {
  const spec = soundSpec(level);
  let sum = 0;
  for (const w of spec.waves) sum += (Number(w.d) || 0) + (Number(w.after) || 0);
  return Math.round(sum * 1000);
}

/** Syslog 级别（0 emerg … 7 debug）→ 告警等级：设备自己标的严重度，比统一按「命中即告警」更贴近现场 */
function levelFromSyslogSeverity(sev) {
  const n = Number(sev);
  if (!Number.isFinite(n)) return DEFAULT_LEVEL;
  if (n <= 1) return 'emergency';
  if (n <= 3) return 'critical';
  if (n === 4) return 'warning';
  return 'info';
}
/** 标准 Trap → 等级：链路断开与认证失败按严重，链路恢复为提示，冷/热启动与其它为警告 */
function levelFromTrap(name) {
  const s = String(name == null ? '' : name).toLowerCase();
  if (s.indexOf('linkdown') >= 0) return 'critical';
  if (s.indexOf('authenticationfailure') >= 0) return 'critical';
  if (s.indexOf('linkup') >= 0) return 'info';
  if (s.indexOf('coldstart') >= 0 || s.indexOf('warmstart') >= 0) return 'warning';
  if (s.indexOf('neighborloss') >= 0) return 'warning';
  return 'warning';
}

/* 双形态导出：主进程/测试用 module.exports，渲染层（无打包器、无 ES modules）挂 globalThis.TopoAlertLevel */
const API = {
  LEVELS: LEVELS, LEVEL_NAMES: LEVEL_NAMES, LEVEL_RANK: LEVEL_RANK,
  EVENT_LEVELS: EVENT_LEVELS, EVENT_TYPES: EVENT_TYPES, SOUNDS: SOUNDS, MIN_GAP_MS: MIN_GAP_MS,
  DEFAULT_LEVEL: DEFAULT_LEVEL, DEFAULT_MIN_LEVEL: DEFAULT_MIN_LEVEL, DEFAULT_VOLUME: DEFAULT_VOLUME,
  isLevel: isLevel, rankOf: rankOf, levelName: levelName, normalizeLevel: normalizeLevel, meetsMin: meetsMin,
  levelFor: levelFor, normalizeOverrides: normalizeOverrides,
  normalizeSoundSettings: normalizeSoundSettings, shouldPlay: shouldPlay,
  bumpLevel: bumpLevel, pickEscalations: pickEscalations,
  soundSpec: soundSpec, soundDurationMs: soundDurationMs,
  levelFromSyslogSeverity: levelFromSyslogSeverity, levelFromTrap: levelFromTrap
};
if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof globalThis !== 'undefined') globalThis.TopoAlertLevel = API; // 浏览器无 `global` 标识符，裸引用会 ReferenceError 致挂载失败
})(typeof globalThis !== 'undefined' ? globalThis : this);
