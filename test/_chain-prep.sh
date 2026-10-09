#!/bin/bash
# 串行后台链：s2/s3 复登验证 → s4 探测定口令 → SNMP v3 预配（大间隔防 VTY 防御态）
cd /d/zcode/nettopo
LOG=test/_chpw-log.txt
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a $LOG; }

sleep 240   # 先静默 4 分钟，让设备防御窗口过去

log "=== s2 ShellManager 复登验证 ==="
DEV_HOST=192.168.50.102 DEV_PASS='Abcd!1234+1' node test/_sm-check.js 2>&1 | tee -a $LOG
sleep 100
log "=== s3 ShellManager 复登验证 ==="
DEV_HOST=192.168.50.103 DEV_PASS='Abcd!1234+1' node test/_sm-check.js 2>&1 | tee -a $LOG
sleep 100
log "=== s4 探测（表格口令 Abcd!1234+） ==="
DEV_HOST=192.168.50.104 DEV_PASS='Abcd!1234+' node test/_login-raw.js 2>&1 | tee -a $LOG
if grep -q "OK-PROMPT" <(tail -3 $LOG); then
  S4STATE=table
elif grep -q "AUTH-FAIL" <(tail -3 $LOG); then
  sleep 100
  log "=== s4 探测（变体口令 Abcd!1234+1） ==="
  DEV_HOST=192.168.50.104 DEV_PASS='Abcd!1234+1' node test/_login-raw.js 2>&1 | tee -a $LOG
  if grep -q "OK-PROMPT" <(tail -3 $LOG); then S4STATE=variant
  elif grep -q "AUTH-FAIL" <(tail -3 $LOG); then S4STATE=none
  else S4STATE=unknown; fi
else
  S4STATE=unknown
fi
log "=== s4 口令状态: $S4STATE ==="

# SNMP 预配：s1-s3 一批（口令 Abcd!1234+1）
sleep 60
log "=== SNMP v3 预配 s1,s2,s3 ==="
node test/_setup-snmp.js --hosts 101,102,103 --pass 'Abcd!1234+1' 2>&1 | tee -a $LOG
if [ "$S4STATE" = "table" ]; then
  sleep 60
  log "=== SNMP v3 预配 s4（表格口令） ==="
  node test/_setup-snmp.js --hosts 104 --pass 'Abcd!1234+' 2>&1 | tee -a $LOG
elif [ "$S4STATE" = "variant" ]; then
  sleep 60
  log "=== SNMP v3 预配 s4（变体口令） ==="
  node test/_setup-snmp.js --hosts 104 --pass 'Abcd!1234+1' 2>&1 | tee -a $LOG
else
  log "=== s4 未能定口令（$S4STATE），跳过其 SNMP 预配 ==="
fi
log "=== 链式任务全部完成 ==="
