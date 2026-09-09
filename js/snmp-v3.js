/* NetTopo SNMP v3 —— USM 安全模型纯函数实现（主进程纯 Node，不依赖 Electron）
 * 实现 RFC 3414（USM）与 RFC 3826（AES-128）的核心密码学原语与消息编解码：
 *   - passwordToKey：口令 → 本地化密钥 Kul（MD5 / SHA-1，RFC 3414 A.1/A.2）
 *   - authDigest / verifyAuth：HMAC-MD5-96 / HMAC-SHA-96 整包签名与校验（authParams 置零后计算）
 *   - encryptDES / decryptDES（CBC-DES，IV = salt ⊕ boots‖time）、encryptAES / decryptAES（AES-128-CFB，IV = boots‖time‖salt）
 *   - buildV3Message / parseV3Message：SNMPv3 消息编解码（USM 安全参数 + scopedPDU）
 *   - Client：引擎 ID 发现 + 时间同步 + 按用户缓存（供 monitor.js 的 GET/GETNEXT/Walk 复用）
 * 兼容性：auth 支持 MD5 / SHA；priv 支持 DES / AES-128（noAuthNoPriv / authNoPriv / authPriv 三档）。
 * 可在 Node 测试中直接使用（含 RFC 3414 A.2.1 官方向量）。
 */
'use strict';
const crypto = require('crypto');

const OID_USM_UNKNOWN_ENGINE_IDS = '1.3.6.1.6.3.15.1.1.4.0';
const OID_USM_NOT_IN_TIME_WINDOWS = '1.3.6.1.6.3.15.1.1.2.0';
const OID_USM_UNKNOWN_USER_NAMES = '1.3.6.1.6.3.15.1.1.5.0';
const OID_USM_WRONG_DIGESTS = '1.3.6.1.6.3.15.1.1.6.0';
const OID_USM_UNSUPPORTED_SEC_LEVELS = '1.3.6.1.6.3.15.1.1.1.0';

/* ---------------- 基础 BER 编解码（与 monitor.js 同款风格） ---------------- */
function berLenOf(n) {
  if (n < 128) return Buffer.from([n]);
  if (n < 256) return Buffer.from([0x81, n]);
  return Buffer.from([0x82, (n >> 8) & 0xff, n & 0xff]);
}
function berTlv(tag, body) { return Buffer.concat([Buffer.from([tag]), berLenOf(body.length), body]); }
function berInt(n) {
  // 无符号视值编码为最小长度补码整数：正数首字节高位为 1 时必须补前导 0x00
  // （否则 65507 会被编码成 02 02 ff e3，按补码解读为 -29，真实设备直接丢包）
  const bytes = [];
  let v = n >>> 0;
  do { bytes.unshift(v & 0xff); v = v >>> 8; } while (v);
  if (bytes[0] & 0x80) bytes.unshift(0);
  return berTlv(0x02, Buffer.from(bytes));
}
function berOct(b) { return berTlv(0x04, Buffer.isBuffer(b) ? b : Buffer.from(String(b || ''), 'utf8')); }
function berOid(oid) {
  // 容忍常见输入形态：前导点（.1.3.6.1）/多余空白/末尾点——strip 后再编码
  const parts = String(oid).trim().replace(/^\.+/, '').replace(/\.+$/, '').split('.').map(Number);
  const body = [parts[0] * 40 + (parts[1] || 0)];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    const tmp = [v & 0x7f];
    v >>>= 7;
    while (v) { tmp.unshift((v & 0x7f) | 0x80); v >>>= 7; }
    body.push(...tmp);
  }
  return berTlv(0x06, Buffer.from(body));
}
function tlvWalk(buf, start) {
  if (start + 2 > buf.length) return null;
  const tag = buf[start];
  let len = buf[start + 1];
  let hs = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n > 2 || start + 2 + n > buf.length) return null;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[start + 2 + i];
    hs = 2 + n;
  }
  if (start + hs + len > buf.length) return null;
  return { tag, body: buf.subarray(start + hs, start + hs + len), next: start + hs + len, start, hs };
}
function decodeOid(b) {
  if (!b || !b.length) return '';
  const arr = [Math.floor(b[0] / 40), b[0] % 40];
  let v = 0;
  for (let i = 1; i < b.length; i++) {
    v = (v << 7) | (b[i] & 0x7f);
    if (!(b[i] & 0x80)) { arr.push(v); v = 0; }
  }
  return arr.join('.');
}
function readUInt(b) {
  if (!b || !b.length || b.length > 8) return null;
  return [...b].reduce((a, x) => a * 256 + x, 0);
}
function decodeValue(tag, body) {
  switch (tag) {
    case 0x02: { const n = readUInt(body); return n == null ? '' : String(n); }
    case 0x04: return body.toString('utf8').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ');
    case 0x05: return '';
    case 0x06: return decodeOid(body);
    case 0x40: return body && body.length === 4 ? [...body].join('.') : '';
    case 0x41: case 0x42: case 0x43: { const n = readUInt(body); return n == null ? '' : String(n); }
    case 0x46: { const n = readUInt(body); return n == null ? '' : String(n); }
    default: return body ? body.toString('hex').slice(0, 64) : '';
  }
}

/* ---------------- RFC 3414 密码学原语 ---------------- */
/** 口令 → 本地化密钥 Kul（RFC 3414 A.1）：
 *  口令按 UTF-8 反复填充至恰好 1MB，逐 64 字节块迭代 x = H(x‖chunk)（x0 = H(空串)），
 *  Kul = H(x‖engineID‖x)。algo: 'md5' | 'sha'（SHA-1），输出 16 / 20 字节。 */
function passwordToKey(password, engineID, algo) {
  const hashName = String(algo) === 'sha' ? 'sha1' : 'md5';
  const pwd = Buffer.from(String(password == null ? '' : password), 'utf8');
  if (!pwd.length) throw new Error('SNMP v3 口令为空');
  const eid = Buffer.isBuffer(engineID) ? engineID : Buffer.from(String(engineID || ''), 'hex');
  if (!eid.length) throw new Error('SNMP v3 引擎 ID 为空，无法本地化密钥');
  const LIMIT = 1024 * 1024;
  const ext = Buffer.alloc(LIMIT);
  for (let off = 0; off < LIMIT; off += pwd.length) {
    pwd.copy(ext, off, 0, Math.min(pwd.length, LIMIT - off));
  }
  const h1 = crypto.createHash(hashName).update(ext).digest();
  return crypto.createHash(hashName).update(Buffer.concat([h1, eid, h1])).digest();
}

/** 整包 HMAC 签名：msg 中 authParams 12 字节置零后计算，取前 96 位 */
function authDigest(msg, authKey, algo) {
  const hashName = String(algo) === 'sha' ? 'sha1' : 'md5';
  const mac = crypto.createHmac(hashName, authKey).update(msg).digest();
  return mac.subarray(0, 12);
}

/** CBC-DES 加密（RFC 3414 8.1.1.1）：key = Kul 前 8 字节，IV = salt ⊕ boots‖time，数据补齐 8 字节倍数 */
function desAvailable() {
  try { crypto.createCipheriv('des-cbc', Buffer.alloc(8), Buffer.alloc(8)); return true; } catch (e) { return false; }
}
function encryptDES(kul, iv8, data) {
  const key = kul.subarray(0, 8);
  if (!desAvailable()) throw new Error('本环境不支持 DES 加密（Node/OpenSSL 3 默认禁用），请改用 AES-128 隐私协议');
  const pad = (8 - (data.length % 8)) % 8;
  const plain = Buffer.concat([data, Buffer.alloc(pad)]);
  const cipher = crypto.createCipheriv('des-cbc', key, iv8);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}
function decryptDES(kul, iv8, data) {
  if (!desAvailable()) throw new Error('本环境不支持 DES 解密（Node/OpenSSL 3 默认禁用），请改用 AES-128 隐私协议');
  const key = kul.subarray(0, 8);
  const decipher = crypto.createDecipheriv('des-cbc', key, iv8);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}
/** AES-128-CFB 加密（RFC 3826）：key = Kul 前 16 字节，IV = boots‖time‖salt（16 字节） */
function encryptAES(kul, iv16, data) {
  const cipher = crypto.createCipheriv('aes-128-cfb', kul.subarray(0, 16), iv16);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}
function decryptAES(kul, iv16, data) {
  const decipher = crypto.createDecipheriv('aes-128-cfb', kul.subarray(0, 16), iv16);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/* ---------------- v3 用户归一化 ---------------- */
/** 归一化 v3 用户配置：{user, authProto:'md5'|'sha', authPass, privProto:'des'|'aes', privPass}
 *  → { user, level: noAuth|auth|authPriv, authProto, authPass, privProto, privPass } 或 null */
function normalizeV3User(v) {
  v = v && typeof v === 'object' ? v : {};
  const user = String(v.user || '').trim().slice(0, 32);
  if (!user) return null;
  const authProto = String(v.authProto).toLowerCase() === 'sha' ? 'sha' : (String(v.authProto).toLowerCase() === 'md5' ? 'md5' : '');
  const authPass = String(v.authPass || '');
  const privProto = String(v.privProto).toLowerCase() === 'aes' ? 'aes' : (String(v.privProto).toLowerCase() === 'des' ? 'des' : '');
  const privPass = String(v.privPass || '');
  if (!authProto || !authPass) return { user, level: 'noAuth', authProto: '', authPass: '', privProto: '', privPass: '' };
  if (!privProto || !privPass) return { user, level: 'auth', authProto, authPass, privProto: '', privPass: '' };
  return { user, level: 'authPriv', authProto, authPass, privProto, privPass };
}

/* ---------------- v3 消息构建与解析 ---------------- */
/** 构造 SNMPv3 请求消息。
 *  opts: { msgID, pduTag(0xa0 GET/0xa1 GetNext), oids, engineID(Buffer|hex串), boots, time,
 *          user: normalizeV3User 结果, saltCounter(可注入,测试用) }
 *  返回 { msg: Buffer, authParamsOffset（供测试/校验）, scoped } */
function buildV3Message(opts) {
  opts = opts || {};
  const user = opts.user || { user: '', level: 'noAuth' };
  const engineID = Buffer.isBuffer(opts.engineID) ? opts.engineID : Buffer.from(String(opts.engineID || ''), 'hex');
  const boots = opts.boots || 0;
  const time = opts.time || 0;
  const varb = (opts.oids || []).map(oid => berTlv(0x30, Buffer.concat([berOid(oid), Buffer.from([0x05, 0x00])])));
  const rid = berInt((opts.rid || 1) & 0x7fffffff);
  const pdu = berTlv(opts.pduTag || 0xa0, Buffer.concat([rid, berInt(0), berInt(0), berTlv(0x30, Buffer.concat(varb))]));
  const contextEngine = engineID.length ? engineID : Buffer.alloc(0);
  const scoped = berTlv(0x30, Buffer.concat([berOct(contextEngine), berOct(Buffer.alloc(0)), pdu]));

  const flags = (user.level === 'authPriv' ? 0x03 : user.level === 'auth' ? 0x01 : 0x00) | (opts.reportable ? 0x04 : 0x00);
  const privSalt = Buffer.alloc(8);
  let saltVal = 0;
  if (user.level === 'authPriv') {
    // RFC 3414 8.1.1.1 / RFC 3826：privParameters salt 每条消息必须唯一（重复即 IV 重用，
    // 两密文异或泄露明文关系）。单调计数器保证唯一；时间戳派生无此保证且同毫秒乘积超 2^53 有偏
    saltVal = (opts.saltCounter != null) ? opts.saltCounter : (v3SaltCounter = ((v3SaltCounter + 1) & 0x7fffffff) || 1);
    privSalt.writeUInt32BE(boots >>> 0, 0);
    privSalt.writeUInt32BE(saltVal >>> 0, 4);
  }
  const usmBody = Buffer.concat([
    berOct(engineID), berInt(boots >>> 0), berInt(time >>> 0),
    berOct(user.user), berOct(Buffer.alloc(12)),
    user.level === 'authPriv' ? berOct(privSalt) : berOct(Buffer.alloc(0))
  ]);
  // RFC 3414：msgSecurityParameters 是 OCTET STRING，内容为 USMSecurityParametersFields
  // （SEQUENCE）的 ASN.1 编码——真实设备（net-snmp 等）要求必须有内层 SEQUENCE 头
  const usm = berOct(berTlv(0x30, usmBody));

  let msgData;
  if (user.level === 'authPriv') {
    const kul = passwordToKey(user.authPass, engineID, user.authProto);
    const iv8 = Buffer.alloc(8);
    iv8.writeUInt32BE(boots >>> 0, 0);
    iv8.writeUInt32BE(time >>> 0, 4);
    let iv16;
    let encrypted;
    if (user.privProto === 'aes') {
      iv16 = Buffer.alloc(16);
      iv16.writeUInt32BE(boots >>> 0, 0);
      iv16.writeUInt32BE(time >>> 0, 4);
      privSalt.copy(iv16, 8);
      encrypted = encryptAES(kul.subarray(0, 16), iv16, scoped); // AES 用 Kul 前 16 字节（RFC 3826）
    } else {
      // DES：IV = salt ⊕ boots‖time；密钥 = Kul 前 8 字节（RFC 3414：Kul 前 16 字节中取前 8）
      for (let i = 0; i < 8; i++) iv8[i] = iv8[i] ^ privSalt[i];
      const desKey = kul.subarray(0, 8);
      encrypted = encryptDES(desKey, iv8, scoped);
    }
    msgData = berOct(encrypted);
  } else {
    msgData = scoped;
  }
  // RFC 3411 SNMPv3Message ::= SEQUENCE { version, msgGlobalData(HeaderData SEQUENCE),
  // msgSecurityParameters OCTET STRING, msgData }——msgID/maxSize/flags/secModel 必须包在
  // HeaderData SEQUENCE 里；缺失时真实设备（net-snmp 等）按坏包丢弃
  const header = berTlv(0x30, Buffer.concat([
    berInt((opts.msgID || 1) & 0x7fffffff),
    berInt(65507),
    berOct(Buffer.from([flags])),
    berInt(3)
  ]));
  const msg = berTlv(0x30, Buffer.concat([
    berInt(3),
    header,
    usm,
    msgData
  ]));
  // 若带认证：计算 HMAC 回填 authParams（usm 内第 5 个 TLV 的 12 字节区）
  let authParamsOffset = -1;
  if (user.level !== 'noAuth') {
    const root = tlvWalk(msg, 0);
    // 顶层字段：version(0) header(1) usm(2) data(3)
    let cur = 0;
    const fields = [];
    while (cur < root.body.length) {
      const t = tlvWalk(root.body, cur);
      if (!t) break;
      fields.push(t);
      cur = t.next;
    }
    const usmT = fields[2];
    const usmInner = tlvWalk(usmT.body, 0);
    const usmScope = (usmInner && usmInner.tag === 0x30) ? usmInner.body : usmT.body;
    const ufields = [];
    let c = 0;
    while (c < usmScope.length) {
      const t = tlvWalk(usmScope, c);
      if (!t) break;
      ufields.push(t);
      c = t.next;
    }
    const authT = ufields[4]; // authParams OCTET STRING
    if (authT && authT.body.length === 12) {
      const kul = passwordToKey(user.authPass, engineID, user.authProto);
      const digest = authDigest(msg, kul, user.authProto);
      const off = root.start + root.hs + usmT.start + usmT.hs +
        (usmInner && usmInner.tag === 0x30 ? usmInner.start + usmInner.hs : 0) +
        authT.start + authT.hs;
      digest.copy(msg, off);
      authParamsOffset = off;
    }
  }
  return { msg, authParamsOffset, saltVal }; // saltVal：本轮 priv 盐值（测试断言唯一性用）
}

/** 解析 varbind 序列（SEQUENCE of {OID, value}）；畸形行跳过，数量封顶 */
function parseVbs(seqT) {
  const out = [];
  if (!seqT || seqT.tag !== 0x30) return out;
  let q = 0;
  while (q < seqT.body.length && out.length < 64) {
    const vb = tlvWalk(seqT.body, q);
    if (!vb) break;
    q = vb.next;
    let j = 0;
    const parts = [];
    while (j < vb.body.length) {
      const t = tlvWalk(vb.body, j);
      if (!t) break;
      parts.push(t);
      j = t.next;
    }
    const oidT = parts[0], valT = parts[1];
    out.push({ oid: oidT && oidT.tag === 0x06 ? decodeOid(oidT.body) : '', value: valT ? decodeValue(valT.tag, valT.body) : '' });
  }
  return out;
}

/** 解析 SNMPv3 消息（响应/Report/Trap）。校验认证（若配置了用户与密钥）并按需解密。
 *  opts: { user(本端配置), expectEngineID(hex串|Buffer|空) }
 *  返回 { ok, engineID(hex), boots, time, userName, pduTag, varbinds:[{oid,value}], rid,
 *          report: {oid}|null, authenticated, decrypted } 或 { ok:false, reason } */
function parseV3Message(buf, opts) {
  opts = opts || {};
  try {
    const root = tlvWalk(buf, 0);
    if (!root || root.tag !== 0x30) return { ok: false, reason: '非 SEQUENCE' };
    const fields = [];
    let cur = 0;
    while (cur < root.body.length) {
      const t = tlvWalk(root.body, cur);
      if (!t) return { ok: false, reason: '字段截断' };
      fields.push(t);
      cur = t.next;
    }
    if (fields.length < 4) return { ok: false, reason: 'v3 字段不足' };
    const version = readUInt(fields[0].body);
    if (version !== 3) return { ok: false, reason: '非 v3 版本' };
    // RFC 3411 标准形态：version, header(SEQUENCE{id,max,flags,secModel}), usm(OCTET), msgData；
    // 兼容历史平铺形态：version, msgID, maxSize, flags, secModel, usm, msgData
    const isRfc = fields[1].tag === 0x30;
    let rid, flagsBuf, usmT, msgDataT;
    if (isRfc) {
      if (fields.length < 4) return { ok: false, reason: 'v3 字段不足' };
      const hd = [];
      let h = 0;
      while (h < fields[1].body.length) {
        const t = tlvWalk(fields[1].body, h);
        if (!t) return { ok: false, reason: 'HeaderData 截断' };
        hd.push(t);
        h = t.next;
      }
      if (hd.length < 4) return { ok: false, reason: 'HeaderData 字段不足' };
      rid = readUInt(hd[0].body);
      flagsBuf = hd[2].body;
      usmT = fields[2];
      msgDataT = fields[3];
    } else {
      if (fields.length < 7) return { ok: false, reason: 'v3 字段不足' };
      rid = readUInt(fields[1].body);
      flagsBuf = fields[3].body;
      usmT = fields[5];
      msgDataT = fields[6];
    }
    const flags = flagsBuf && flagsBuf.length ? flagsBuf[0] : 0;
    const wantAuth = !!(flags & 0x01);
    const wantPriv = !!(flags & 0x02);
    // 兼容两种形态：RFC 3414 标准（真实设备）为内层 SEQUENCE 包裹字段；历史形态为直接平铺
    let usmScope = usmT.body;
    const usmInner = tlvWalk(usmT.body, 0);
    if (usmInner && usmInner.tag === 0x30) usmScope = usmInner.body;
    const uf = [];
    let c = 0;
    while (c < usmScope.length) {
      const t = tlvWalk(usmScope, c);
      if (!t) return { ok: false, reason: 'USM 截断' };
      uf.push(t);
      c = t.next;
    }
    if (uf.length < 5) return { ok: false, reason: 'USM 字段不足' };
    const engineID = uf[0].body.toString('hex');
    const boots = readUInt(uf[1].body) || 0;
    const time = readUInt(uf[2].body) || 0;
    const userName = uf[3].body.toString('utf8');
    const authParams = uf[4].body;
    const privParams = uf.length > 5 ? uf[5].body : Buffer.alloc(0);

    // 认证校验必须先于解密/解析（不可信数据先验签）：包声称已认证但本端无对应密钥 → 拒绝
    let authenticated = false;
    if (wantAuth) {
      const u = opts.user;
      if (!u || !u.authProto || u.user !== userName) return { ok: false, reason: 'v3 认证包无法校验（用户 ' + userName + ' 未配置认证密钥）' };
      if (authParams.length !== 12) return { ok: false, reason: 'authParams 长度异常' };
      const kul = passwordToKey(u.authPass, Buffer.from(engineID, 'hex'), u.authProto);
      const masked = Buffer.from(buf);
      const off = root.start + root.hs + usmT.start + usmT.hs +
        (usmInner && usmInner.tag === 0x30 ? usmInner.start + usmInner.hs : 0) +
        uf[4].start + uf[4].hs;
      masked.fill(0, off, off + 12); // authParams 置零后重算整包 HMAC（RFC 3414 7.2.4）
      const expect = authDigest(masked, kul, u.authProto);
      if (!expect.equals(Buffer.from(authParams))) return { ok: false, reason: 'v3 认证失败（签名不匹配，认证密码或算法不符）' };
      authenticated = true;
    }

    // msgData：authPriv 为 OCTET STRING(密文)，解密后得完整 scopedPDU TLV；明文时 msgDataT 即 scopedPDU TLV
    let scopedBody = null;
    let decrypted = false;
    if (msgDataT.tag === 0x04) {
      // 加密 scopedPDU：需本端配置用户且与包内用户一致
      const u = opts.user;
      if (!u || u.level !== 'authPriv') return { ok: false, reason: '收到加密 v3 包但未配置 v3 用户' };
      if (u.user !== userName) return { ok: false, reason: 'v3 用户不匹配（' + userName + '）' };
      const kul = passwordToKey(u.authPass, Buffer.from(engineID, 'hex'), u.authProto);
      let plain;
      if (u.privProto === 'aes') {
        const iv16 = Buffer.alloc(16);
        iv16.writeUInt32BE(boots >>> 0, 0);
        iv16.writeUInt32BE(time >>> 0, 4);
        privParams.copy(iv16, 8);
        plain = decryptAES(kul.subarray(0, 16), iv16, msgDataT.body);
      } else {
        const iv8 = Buffer.alloc(8);
        iv8.writeUInt32BE(boots >>> 0, 0);
        iv8.writeUInt32BE(time >>> 0, 4);
        for (let i = 0; i < 8; i++) iv8[i] = iv8[i] ^ privParams[i];
        plain = decryptDES(kul.subarray(0, 8), iv8, msgDataT.body);
      }
      const scoped = tlvWalk(plain, 0);
      if (!scoped || scoped.tag !== 0x30) return { ok: false, reason: 'scopedPDU 解密后格式异常' };
      scopedBody = scoped.body;
      decrypted = true;
    } else {
      scopedBody = msgDataT.body;
    }
    const sfields = [];
    let s = 0;
    while (s < scopedBody.length) {
      const t = tlvWalk(scopedBody, s);
      if (!t) return { ok: false, reason: 'scopedPDU 截断' };
      sfields.push(t);
      s = t.next;
    }
    if (sfields.length < 3) return { ok: false, reason: 'scopedPDU 字段不足' };
    const pduT = sfields[2];

    // PDU 解析（0xa2 响应 / 0xa8 Report / 0xa7 Trap）
    const pf = [];
    let k = 0;
    while (k < pduT.body.length) {
      const t = tlvWalk(pduT.body, k);
      if (!t) return { ok: false, reason: 'PDU 截断' };
      pf.push(t);
      k = t.next;
    }
    let varbinds = [];
    let report = null;
    let responseRid = null;
    // 响应/Trap/请求包：取 PDU 内 request-id（区别于外层 msgID）与 varbinds
    if (pduT.tag === 0xa2 || pduT.tag === 0xa7 || pduT.tag === 0xa0 || pduT.tag === 0xa1) {
      responseRid = pf.length ? readUInt(pf[0].body) : null;
      varbinds = parseVbs(pf[3]);
    } else if (pduT.tag === 0xa8) {
      // Report：varbind 携带 usmStats 错误计数；request-id 同样回显（RFC 3412 6.3），供调用方防伪造重同步
      responseRid = pf.length ? readUInt(pf[0].body) : null;
      for (const vb of parseVbs(pf[3])) if (vb.oid) report = { oid: vb.oid, value: vb.value };
    }
    return { ok: true, engineID, boots, time, userName, flags, pduTag: pduT.tag, varbinds, rid: responseRid != null ? responseRid : rid, report, authenticated, decrypted, wantAuth, wantPriv };
  } catch (e) {
    return { ok: false, reason: 'v3 解析异常：' + String((e && e.message) || e) };
  }
}

/** Report 错误 OID → 中文原因 */
function reportReason(report) {
  if (!report) return '';
  switch (report.oid) {
    case OID_USM_UNKNOWN_ENGINE_IDS: return '引擎 ID 未发现（discovery 未完成）';
    case OID_USM_NOT_IN_TIME_WINDOWS: return '时间窗口不同步（设备时钟与采集机偏差过大）';
    case OID_USM_UNKNOWN_USER_NAMES: return '用户名不存在（设备未配置该 v3 用户）';
    case OID_USM_WRONG_DIGESTS: return '认证失败（认证密码或算法不匹配）';
    case OID_USM_UNSUPPORTED_SEC_LEVELS: return '安全级别不被支持（认证/加密配置与设备不符）';
    default: return 'USM 错误：' + report.oid;
  }
}

/** v3 会话缓存（引擎发现 + 时间同步），模块级：host|port|user → {engineID, boots, time, at} */
const v3Engines = new Map();
/** priv salt 单调计数器（模块级，31 位回绕）：同引擎并发请求的 IV 唯一性来源 */
let v3SaltCounter = 0;
function v3EngineReset(host, port, user) {
  if (host != null) v3Engines.delete(host + '|' + (port || 161) + '|' + (user || ''));
  else v3Engines.clear();
}
function v3EngineGet(host, port, user) {
  return v3Engines.get(host + '|' + (port || 161) + '|' + (user || '')) || null;
}
function v3EngineSet(host, port, user, st) {
  v3Engines.set(host + '|' + (port || 161) + '|' + (user || ''), st);
}

module.exports = {
  passwordToKey, authDigest, encryptDES, decryptDES, encryptAES, decryptAES, desAvailable,
  normalizeV3User, buildV3Message, parseV3Message, reportReason,
  berTlv, berInt, berOct, berOid, tlvWalk, decodeOid, decodeValue, readUInt,
  v3EngineReset, v3EngineGet, v3EngineSet,
  OID_USM_UNKNOWN_ENGINE_IDS, OID_USM_NOT_IN_TIME_WINDOWS, OID_USM_UNKNOWN_USER_NAMES, OID_USM_WRONG_DIGESTS
};
