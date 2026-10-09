#!/bin/bash
# 后台慢速通道：改 s2/s3 初始口令 → 复登验证 → s4 探测（全程大间隔防 VTY 防御态）
cd /d/zcode/nettopo
LOG=test/_chpw-log.txt
: > $LOG
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a $LOG; }

# 单台改密（重试至多 4 次，间隔 150s；输出入独立临时文件判成功）
chpw() {
  local host=$1 out
  for i in 1 2 3 4; do
    log "chpw $host 第 $i 次尝试"
    out=$(ANSWER=Y NEW_PASS='Abcd!1234+1' DEV_HOST=$host VERBOSE=1 node test/_chpw-raw.js 2>&1 | grep -v "Continue?")
    echo "$out" | tail -8 >> $LOG
    if echo "$out" | grep -q "PROMPT"; then log "chpw $host 成功"; return 0; fi
    sleep 150
  done
  log "chpw $host 未成功"
  return 1
}

# 单台裸登验证
verify() {
  local host=$1 pass=$2 label=$3
  log "verify $host ($label)"
  DEV_HOST=$host DEV_PASS="$pass" node test/_login-raw.js 2>&1 | tee -a $LOG
}

log "=== s2 改密 ==="
chpw 192.168.50.102
sleep 100
log "=== s2 复登验证（新口令） ==="
verify 192.168.50.102 'Abcd!1234+1' new

sleep 100
log "=== s3 改密 ==="
chpw 192.168.50.103
sleep 100
log "=== s3 复登验证（新口令） ==="
verify 192.168.50.103 'Abcd!1234+1' new

sleep 100
log "=== s4 探测（表格口令） ==="
verify 192.168.50.104 'Abcd!1234+' table
sleep 90
log "=== s4 探测（变体口令） ==="
verify 192.168.50.104 'Abcd!1234+1' variant

sleep 100
log "=== s1 ShellManager 应用路径复登验证（新口令） ==="
DEV_HOST=192.168.50.101 DEV_PASS='Abcd!1234+1' node test/_sm-check.js 2>&1 | tee -a $LOG

log "=== 全部完成 ==="
