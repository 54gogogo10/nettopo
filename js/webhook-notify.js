/* NetTopo 告警外发（Webhook）—— 纯逻辑（主进程专用，不依赖 Electron，Node 测试可调用）
 *
 * 解决什么问题：全部告警此前只能在本机感知（系统通知 + 分级提示音），人离开电脑就瞎了。
 * 本模块把告警按用户配置转发到 Webhook 接收端——企业微信 / 钉钉 / 飞书群机器人或自建接收服务，
 * 手机上即可收到。与 AI 外呼同一安全口径：地址与密钥由用户显式配置，secret 经 safeStorage
 * 密文落盘（electron-main 侧），不配置则零外发流量；发送失败尽力而为（事件时间线仍有全量记录）。
 *
 * 消息格式差异在这里收敛（各家机器人协议不同）：
 *   generic  通用 JSON   POST {source, ts, level, title, body}（自建接收端最省事）
 *   wecom    企业微信    {"msgtype":"text","text":{"content": ...}}
 *   dingtalk 钉钉        {"msgtype":"text","text":{"content": ...}}；加签时 URL 拼 timestamp+sign
 *                        （sign = urlencode(base64(hmac_sha256(secret, ts + "\n" + secret)))）
 *   feishu   飞书        {"msg_type":"text","content":{"text": ...}}；加签时 body 带 timestamp+sign
 *                        （sign = base64(hmac_sha256(ts + "\n" + secret, ""))）
 */
'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');

const FORMATS = ['generic', 'wecom', 'dingtalk', 'feishu'];
const FORMAT_LABELS = { generic: '通用 JSON', wecom: '企业微信机器人', dingtalk: '钉钉机器人', feishu: '飞书机器人' };
const LEVEL_RANK = { info: 0, warning: 1, critical: 2, emergency: 3 };
const LEVEL_NAMES = { info: '提示', warning: '警告', critical: '严重', emergency: '紧急' };
/** 标题统一前缀（electron-main 的系统通知用），外发前剥掉让手机推送更干净 */
var TITLE_PREFIX = '网络拓扑管理软件 · ';

function normLevel(v) { return LEVEL_RANK[v] != null ? v : 'warning'; }

/** 配置归一化（脏数据逐字段回默认，绝不整包失效）：损坏或手改的设置只影响其自身字段 */
function normalizeWebhookCfg(raw) {
  raw = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  let url = String(raw.url == null ? '' : raw.url).trim();
  if (!/^https?:\/\/./i.test(url) || url.length > 2048) url = '';
  let cooldownSec = parseInt(raw.cooldownSec, 10);
  if (!Number.isFinite(cooldownSec)) cooldownSec = 10;
  cooldownSec = Math.max(0, Math.min(3600, cooldownSec));
  let timeoutSec = parseInt(raw.timeoutSec, 10);
  if (!Number.isFinite(timeoutSec)) timeoutSec = 5;
  timeoutSec = Math.max(1, Math.min(30, timeoutSec));
  return {
    enabled: !!raw.enabled && !!url,
    url: url,
    format: FORMATS.indexOf(raw.format) >= 0 ? raw.format : 'generic',
    secret: (typeof raw.secret === 'string') ? raw.secret.slice(0, 256) : '',
    minLevel: normLevel(raw.minLevel),
    cooldownSec: cooldownSec,
    timeoutSec: timeoutSec
  };
}

/** HMAC-SHA256 → base64（钉钉/飞书加签共用） */
function hmacSign(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest('base64');
}
/** 钉钉加签：sign = urlencode(base64(hmac(secret, ts + "\n" + secret)))，拼在 URL 查询串上 */
function dingtalkSign(secret, tsMs) {
  return encodeURIComponent(hmacSign(String(secret), tsMs + '\n' + String(secret)));
}
/** 飞书加签：sign = base64(hmac(ts + "\n" + secret, ""))，随 body 提交 */
function feishuSign(secret, tsSec) {
  return hmacSign(tsSec + '\n' + String(secret), '');
}

/** 构造一条外发消息（纯函数可单测）：{url, payload}。
 *  文本 = 剥前缀后的标题 + 换行 + 正文，正文已含设备名/地址与详情；等级名附在文本尾部。 */
function buildDispatch(cfg, msg) {
  const c = normalizeWebhookCfg(cfg);
  const title = String((msg && msg.title) || '').replace(TITLE_PREFIX, '');
  const body = String((msg && msg.body) || '');
  const level = normLevel(msg && msg.level);
  const tsMs = Number.isFinite(msg && msg.ts) ? msg.ts : Date.now();
  const text = title + '\n' + body + '\n[' + LEVEL_NAMES[level] + ']';
  let url = c.url, payload;
  if (c.format === 'wecom') {
    payload = { msgtype: 'text', text: { content: text } };
  } else if (c.format === 'dingtalk') {
    payload = { msgtype: 'text', text: { content: text } };
    if (c.secret) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'timestamp=' + tsMs + '&sign=' + dingtalkSign(c.secret, tsMs);
  } else if (c.format === 'feishu') {
    payload = { msg_type: 'text', content: { text: text } };
    if (c.secret) {
      const tsSec = Math.floor(tsMs / 1000);
      payload.timestamp = String(tsSec);
      payload.sign = feishuSign(c.secret, tsSec);
    }
  } else {
    payload = { source: 'NetTopo', ts: tsMs, level: level, title: title, body: body };
  }
  return { url: url, payload: payload };
}

/** POST JSON（http/https 手写，零依赖）：2xx 即成功；超时/网络错误如实返回 {ok:false, error} */
function postJson(url, payload, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(String(url)); } catch (e) { return resolve({ ok: false, error: '地址无法解析' }); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return resolve({ ok: false, error: '仅支持 http/https' });
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
      // 响应体只留 512 字节（错误信息足够定位，机器人成功回执不需要完整保留）
      let n = 0; const chunks = [];
      res.on('data', (c) => { if (n < 512) { chunks.push(c); n += c.length; } });
      res.on('end', () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        error: (res.statusCode >= 200 && res.statusCode < 300) ? null : ('HTTP ' + res.statusCode + ' ' + Buffer.concat(chunks).toString('utf8').slice(0, 200))
      }));
    });
    req.on('error', (e) => resolve({ ok: false, error: String((e && e.message) || e) }));
    req.setTimeout(Math.max(1000, timeoutMs | 0), () => { req.destroy(new Error('请求超时')); });
    req.end(data);
  });
}

/** 外发调度器：等级过滤 + 冷却节流 + 尽力发送。
 *  冷却按「全局最小发送间隔」实现——依赖抑制已把下游离线归并到根因，这里只防极端刷屏；
 *  冷却期间丢弃的外发在事件时间线里仍有全量记录，不丢信号。 */
class WebhookSender {
  /** loadCfg: () => 归一化配置（settings.json 热读取，改配置即时生效） */
  constructor(opts) {
    opts = opts || {};
    this._loadCfg = typeof opts.loadCfg === 'function' ? opts.loadCfg : () => normalizeWebhookCfg(null);
    this._log = typeof opts.log === 'function' ? opts.log : (() => {});
    this._lastAt = 0;
    this._dropped = 0; // 冷却期间丢弃条数（下一轮成功发送时随日志带出）
  }
  cfg() { return normalizeWebhookCfg(this._loadCfg()); }
  /** 过滤判定（纯）：等级达标且已启用 */
  shouldSend(cfg, level) {
    return !!(cfg && cfg.enabled && LEVEL_RANK[normLevel(level)] >= LEVEL_RANK[cfg.minLevel]);
  }
  /** 告警入口（notifyUser 统一挂钩）：不 await，发送失败只记日志 */
  notify(title, body, level) {
    let cfg;
    try { cfg = this.cfg(); } catch (e) { return; }
    if (!this.shouldSend(cfg, level)) return;
    const now = Date.now();
    if (now - this._lastAt < cfg.cooldownSec * 1000) { this._dropped++; return; }
    this._lastAt = now;
    const disp = buildDispatch(cfg, { title: title, body: body, level: level, ts: now });
    const dropped = this._dropped; this._dropped = 0;
    postJson(disp.url, disp.payload, cfg.timeoutSec * 1000).then((r) => {
      if (!r.ok) this._log('告警外发失败：' + (r.error || '未知错误'));
      else if (dropped > 0) this._log('告警外发成功（冷却期间另有 ' + dropped + ' 条未外发，事件时间线已记录）');
    }).catch(() => { /* postJson 不 reject，兜底 */ });
  }
  /** 测试发送（设置界面「发送测试」按钮）：绕过冷却与等级过滤，返回结果给 UI */
  async test() {
    const cfg = this.cfg();
    if (!cfg.url) return { ok: false, error: '未配置有效地址' };
    const disp = buildDispatch(cfg, { title: TITLE_PREFIX + '告警外发测试', body: '这是一条测试消息：收到说明 Webhook 配置有效。', level: 'info' });
    const r = await postJson(disp.url, disp.payload, cfg.timeoutSec * 1000);
    return r;
  }
}

module.exports = {
  WebhookSender: WebhookSender, normalizeWebhookCfg: normalizeWebhookCfg, buildDispatch: buildDispatch,
  postJson: postJson, dingtalkSign: dingtalkSign, feishuSign: feishuSign,
  FORMATS: FORMATS, FORMAT_LABELS: FORMAT_LABELS, LEVEL_RANK: LEVEL_RANK, TITLE_PREFIX: TITLE_PREFIX
};
