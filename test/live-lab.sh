#!/usr/bin/env bash
# NetTopo 真机集成测试实验环境（部署脚本，需 root 运行）
# ---------------------------------------------------------------------------
# 在一台 Linux 宿主机上搭出「多台真实网络设备」，供 test/live.js 做真机集成测试：
#   每台设备 = 一个 network namespace，内部真实运行
#     · zebra + bgpd（设备间 eBGP 互联，真路由、真接口计数器）
#     · sshd（Linux 层管理口，账号复用宿主机已有账号，认证走 passwd/PAM）
#     · snmpd（SNMP v2c + v3 auth/authPriv，真 net-snmp，含 UCD CPU/内存与 ifTable）
#     · FRR vty telnet（真设备 CLI）+ /usr/local/bin/nt-cli（vtysh 集成 CLI 包装）
#
# 拓扑（管理面经宿主机转发，数据面设备间 veth 直连不经宿主机）：
#       测试机 ── LAN ── 宿主机(被测设备的管理面发布点)
#                          │ nt-m1 / nt-m2 / nt-m3（各一条管理链路）
#                ┌─────────┴──────┬────────────┐
#             r1 10.99.1.2     r2 10.99.2.2  r3 10.99.3.2
#                └─ 10.99.12.0/30 ┘ ─ 10.99.23.0/30 ─┘   （r1↔r2、r2↔r3 eBGP）
#
# 为什么管理面要「端口映射」而不是让测试机直接路由到 10.99.0.0/16：
#   实测（Windows 无线客户端 + 商用 AP）下，AP 会丢弃目的地址不在本网段的无线帧，
#   即使测试机路由表正确也一个包都到不了宿主机。故设备管理面统一发布在宿主机 IP 上、
#   每台一组高位端口（见下方 PUB_* 基址），测试机只需能访问宿主机的常规端口即可。
#   设备自身 IP（10.99.x.2）仍保留，用于实验内部结构与宿主侧检查。
# 设备名 R1-Core-01 / R2-Dist-02 / R3-Access-03，AS 65001/65002/65003，
# 各宣告 10.10.0.0/16、10.20.0.0/16、10.30.0.0/16（bgpd `no bgp network import-check`）。
#
# 用法：
#   sudo bash live-lab.sh up      # 部署（幂等：先拆再建）
#   sudo bash live-lab.sh down    # 拆除（含本脚本加的 iptables 规则）
#   sudo bash live-lab.sh status  # 只读检查（不动任何配置）
# 环境变量：LAB_ROOT（默认 /opt/nettopo-lab；**不要放 /home/<user> 下**——家目录通常 750，
#          FRR 以 frr 用户运行会因无法穿越家目录而 EACCES 起不来）
#          LAB_PUBLIC_IP（发布管理面的宿主机 IP，默认自动探测默认路由出口地址）
#          CLIENT_NET（测试机网段，默认 192.168.50.0/24，用于放行 FORWARD）
#          LAB_USER（设备上可登录的账号，默认 a）
# 输出：结尾打印 NETTOPO_LAB_INVENTORY=<json>（设备清单，供 test/live.js 解析）
# ---------------------------------------------------------------------------
set -uo pipefail

LAB_ROOT=${LAB_ROOT:-/opt/nettopo-lab}
LAB_USER=${LAB_USER:-a}
CLIENT_NET=${CLIENT_NET:-192.168.50.0/24}
NS_PREFIX=nettopo
VTY_PORT=2601          # 设备内 FRR vty（Telnet CLI）端口
TELNET_PASS=nettopo
PUB_SSH_BASE=2201      # 宿主机上发布的 SSH 端口基址（r1→2201，r2→2202…）
PUB_TELNET_BASE=2611   # 发布的 Telnet 端口基址
PUB_SNMP_BASE=1611     # 发布的 SNMP 端口基址
CMD=${1:-up}

# 设备表：id:主机名:设备内管理IP:AS号:宣告网段:环回
DEVSPEC=(
  "r1:R1-Core-01:10.99.1.2:65001:10.10.0.0/16:1.1.1.1"
  "r2:R2-Dist-02:10.99.2.2:65002:10.20.0.0/16:2.2.2.2"
  "r3:R3-Access-03:10.99.3.2:65003:10.30.0.0/16:3.3.3.3"
)
# 数据面链路：链路名:左设备:右设备:左IP:右IP（两端都在 namespace 内，veth 直连）
LINKSPEC=(
  "d12:r1:r2:10.99.12.1:10.99.12.2"
  "d23:r2:r3:10.99.23.1:10.99.23.2"
)

log()  { echo "[live-lab] $*"; }
warn() { echo "[live-lab][警告] $*" >&2; }
die()  { echo "[live-lab][失败] $*" >&2; exit 1; }
need_root() { [ "$(id -u)" = 0 ] || die "需要 root：sudo bash $0 $CMD"; }

# 宿主机发布地址 / 默认路由出口网卡（用于 MASQUERADE）
UPLINK_IF=$(ip route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}' | head -1)
LAB_PUBLIC_IP=${LAB_PUBLIC_IP:-$(ip -4 -o addr show dev "${UPLINK_IF:-ens33}" scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)}

# FRR 在 Ubuntu 上带 AppArmor 限制（abstractions/frr 只放行扁平的
# /etc/frr/、/run/frr/@{profile_name}.pid、/run/frr/@{profile_name}.vty、/var/log/frr/*）；
# 多设备实验每台都要独立的 pid/日志/vty socket，只能另起路径，否则守护进程创建文件被
# DENIED mknod 卡死（bgpd 报 "Can't create pid lock file" 后退出，zebra 则日志静默丢失）。
# 这里用 aa-exec 以 unconfined 启动**本实验室的**守护进程：只影响本脚本启动的进程，不改系统策略；
# 宿主没有 AppArmor 用户态工具时（Debian/旧版 Ubuntu）原样启动即可。
AAEXEC=""
command -v aa-exec >/dev/null 2>&1 && AAEXEC="aa-exec -p unconfined --"

# ---- 设备表查询 ----
dev_row()  { local r; for r in "${DEVSPEC[@]}"; do [ "${r%%:*}" = "$1" ] && { echo "$r"; return; }; done; }
dev_name() { dev_row "$1" | cut -d: -f2; }
dev_ip()   { dev_row "$1" | cut -d: -f3; }
dev_as()   { dev_row "$1" | cut -d: -f4; }
dev_lan()  { dev_row "$1" | cut -d: -f5; }
dev_lo()   { dev_row "$1" | cut -d: -f6; }
dev_mgmt_host_ip() { echo "10.99.${1#r}.1"; }
dev_host_if() { echo "nt-m${1#r}"; }
dev_ns_if()   { echo "ntp${1#r}"; }
dev_dir()  { echo "$LAB_ROOT/$1"; }
dev_ns()   { echo "$NS_PREFIX-$1"; }
pub_ssh()    { echo $((PUB_SSH_BASE + ${1#r} - 1)); }
pub_telnet() { echo $((PUB_TELNET_BASE + ${1#r} - 1)); }
pub_snmp()   { echo $((PUB_SNMP_BASE + ${1#r} - 1)); }

# ---------------------------------------------------------------- 放行 / 转发 / 发布
# 宿主机 FORWARD 默认 DROP（Docker 设的）：不放行则测试机访问不到任何设备管理面
# （上一轮实验室正是在这里翻车——「管理面全闭」）。规则带 nettopo-lab 注释便于精确回收。
forward_allow() {
  [ "$(cat /proc/sys/net/ipv4/ip_forward 2>/dev/null)" = "1" ] || sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1
  local a b
  for pair in "10.99.0.0/16|$CLIENT_NET" "$CLIENT_NET|10.99.0.0/16"; do
    a=${pair%%|*}; b=${pair##*|}
    iptables -C FORWARD -s "$a" -d "$b" -m comment --comment nettopo-lab -j ACCEPT 2>/dev/null \
      || iptables -I FORWARD 1 -s "$a" -d "$b" -m comment --comment nettopo-lab -j ACCEPT
  done
}
forward_deny() {
  while iptables -D FORWARD -s 10.99.0.0/16 -d "$CLIENT_NET" -m comment --comment nettopo-lab -j ACCEPT 2>/dev/null; do :; done
  while iptables -D FORWARD -s "$CLIENT_NET" -d 10.99.0.0/16 -m comment --comment nettopo-lab -j ACCEPT 2>/dev/null; do :; done
}
# 管理面发布：宿主机:高位端口 → 设备管理 IP（DNAT）；设备主动外联（Syslog/Trap/TFTP/FTP）
# 经 MASQUERADE 出网卡，测试机侧看到的来源统一为宿主机 IP（便于测试机侧防火墙只放行一个地址）。
publish_allow() {
  local row id ip p
  [ -n "$LAB_PUBLIC_IP" ] || { warn "未探测到发布 IP，跳过端口映射"; return; }
  forward_allow
  for row in "${DEVSPEC[@]}"; do
    id=$(echo "$row" | cut -d: -f1); ip=$(dev_ip "$id")
    p=$(pub_ssh "$id");    iptables -t nat -C PREROUTING -d "$LAB_PUBLIC_IP" -p tcp --dport "$p" -m comment --comment nettopo-lab -j DNAT --to-destination "$ip:22" 2>/dev/null \
      || iptables -t nat -A PREROUTING -d "$LAB_PUBLIC_IP" -p tcp --dport "$p" -m comment --comment nettopo-lab -j DNAT --to-destination "$ip:22"
    p=$(pub_telnet "$id"); iptables -t nat -C PREROUTING -d "$LAB_PUBLIC_IP" -p tcp --dport "$p" -m comment --comment nettopo-lab -j DNAT --to-destination "$ip:$VTY_PORT" 2>/dev/null \
      || iptables -t nat -A PREROUTING -d "$LAB_PUBLIC_IP" -p tcp --dport "$p" -m comment --comment nettopo-lab -j DNAT --to-destination "$ip:$VTY_PORT"
    p=$(pub_snmp "$id");   iptables -t nat -C PREROUTING -d "$LAB_PUBLIC_IP" -p udp --dport "$p" -m comment --comment nettopo-lab -j DNAT --to-destination "$ip:161" 2>/dev/null \
      || iptables -t nat -A PREROUTING -d "$LAB_PUBLIC_IP" -p udp --dport "$p" -m comment --comment nettopo-lab -j DNAT --to-destination "$ip:161"
  done
  [ -n "$UPLINK_IF" ] && { iptables -t nat -C POSTROUTING -s 10.99.0.0/16 -o "$UPLINK_IF" -m comment --comment nettopo-lab -j MASQUERADE 2>/dev/null \
    || iptables -t nat -A POSTROUTING -s 10.99.0.0/16 -o "$UPLINK_IF" -m comment --comment nettopo-lab -j MASQUERADE; }
}
publish_deny() {
  local row id p
  for row in "${DEVSPEC[@]}"; do
    id=$(echo "$row" | cut -d: -f1); ip=$(dev_ip "$id")
    p=$(pub_ssh "$id");    while iptables -t nat -D PREROUTING -d "$LAB_PUBLIC_IP" -p tcp --dport "$p" -m comment --comment nettopo-lab -j DNAT --to-destination "$ip:22" 2>/dev/null; do :; done
    p=$(pub_telnet "$id"); while iptables -t nat -D PREROUTING -d "$LAB_PUBLIC_IP" -p tcp --dport "$p" -m comment --comment nettopo-lab -j DNAT --to-destination "$ip:$VTY_PORT" 2>/dev/null; do :; done
    p=$(pub_snmp "$id");   while iptables -t nat -D PREROUTING -d "$LAB_PUBLIC_IP" -p udp --dport "$p" -m comment --comment nettopo-lab -j DNAT --to-destination "$ip:161" 2>/dev/null; do :; done
  done
  [ -n "$UPLINK_IF" ] && while iptables -t nat -D POSTROUTING -s 10.99.0.0/16 -o "$UPLINK_IF" -m comment --comment nettopo-lab -j MASQUERADE 2>/dev/null; do :; done
}
# 管理口放开 rp_filter：测试机与设备之间是「经宿主机转发」的非对称路径，严格模式会丢包。
# 只动本脚本自己创建的 veth（其生命周期与实验一致，无需还原）。
rp_filter_relax() {
  local ifc=$1
  [ -e "/proc/sys/net/ipv4/conf/$ifc/rp_filter" ] && echo 0 > "/proc/sys/net/ipv4/conf/$ifc/rp_filter" 2>/dev/null
  return 0
}

# ---------------------------------------------------------------- 拆除
teardown() {
  need_root
  log "拆除实验环境…"
  local row id s d p
  for row in "${DEVSPEC[@]}"; do
    id=$(echo "$row" | cut -d: -f1); s=$(dev_ns "$id"); d=$(dev_dir "$id")
    for p in zebra bgpd; do
      [ -f "$d/run/$p.pid" ] && kill "$(cat "$d/run/$p.pid")" 2>/dev/null
    done
    [ -f "$d/run/sshd.pid" ] && kill "$(cat "$d/run/sshd.pid")" 2>/dev/null
    [ -f "$d/run/snmpd.pid" ] && kill "$(cat "$d/run/snmpd.pid")" 2>/dev/null
    if ip netns list 2>/dev/null | awk '{print $1}' | grep -qx "$s"; then
      ip netns pids "$s" 2>/dev/null | xargs -r kill 2>/dev/null
    fi
  done
  sleep 1
  for row in "${LINKSPEC[@]}"; do
    ip link del "nt-$(echo "$row" | cut -d: -f1)a" 2>/dev/null   # 删任一端即整对消失
  done
  for row in "${DEVSPEC[@]}"; do
    id=$(echo "$row" | cut -d: -f1)
    ip link del "$(dev_host_if "$id")" 2>/dev/null
    ip netns del "$(dev_ns "$id")" 2>/dev/null
  done
  ip netns list 2>/dev/null | awk -v p="$NS_PREFIX-" '$1 ~ "^"p {print $1}' | while read -r n; do ip netns del "$n" 2>/dev/null; done
  publish_deny
  forward_deny
  rm -f /usr/local/etc/nettopo-lab-cli.map
  log "拆除完成（实验目录 $LAB_ROOT 保留，便于取证）"
}

# ---------------------------------------------------------------- 部署
setup() {
  need_root
  command -v vtysh >/dev/null   || die "缺少 FRR：apt-get install -y frr"
  command -v snmpd >/dev/null   || die "缺少 snmpd：apt-get install -y snmpd snmp"
  [ -x /usr/sbin/sshd ]         || die "缺少 sshd：apt-get install -y openssh-server"
  [ -n "$LAB_PUBLIC_IP" ]       || die "未探测到发布 IP，请显式指定 LAB_PUBLIC_IP=<宿主机可达 IP>"
  teardown
  log "实验根目录 $LAB_ROOT"
  log "管理面发布：$LAB_PUBLIC_IP（SSH ${PUB_SSH_BASE}+ / Telnet ${PUB_TELNET_BASE}+ / SNMP ${PUB_SNMP_BASE}+）"
  mkdir -p /run/sshd "$LAB_ROOT"
  publish_allow

  # ---- 1) namespace / 管理链路 / 数据面链路 ----
  local row id
  for row in "${DEVSPEC[@]}"; do
    id=$(echo "$row" | cut -d: -f1)
    mkdir -p "$(dev_dir "$id")"/{etc,log,run,vty,ssh,snmp}
    ip netns add "$(dev_ns "$id")" || die "创建 namespace $(dev_ns "$id") 失败"
    ip netns exec "$(dev_ns "$id")" ip link set lo up
    ip netns exec "$(dev_ns "$id")" ip addr add "$(dev_lo "$id")/32" dev lo
    ip link add "$(dev_host_if "$id")" type veth peer name "$(dev_ns_if "$id")" || die "创建管理链路失败"
    ip link set "$(dev_ns_if "$id")" netns "$(dev_ns "$id")"
    ip addr add "$(dev_mgmt_host_ip "$id")/30" dev "$(dev_host_if "$id")"
    ip link set "$(dev_host_if "$id")" up
    rp_filter_relax "$(dev_host_if "$id")"
    ip netns exec "$(dev_ns "$id")" ip link set "$(dev_ns_if "$id")" up
    ip netns exec "$(dev_ns "$id")" ip addr add "$(dev_ip "$id")/30" dev "$(dev_ns_if "$id")"
    # 回程路由：设备只认测试机网段（走宿主机转发），不加默认路由以免掩盖数据面路由问题
    ip netns exec "$(dev_ns "$id")" ip route add "$CLIENT_NET" via "$(dev_mgmt_host_ip "$id")" 2>/dev/null
  done
  for row in "${LINKSPEC[@]}"; do
    local ln a b la lb
    ln=$(echo "$row" | cut -d: -f1); a=$(echo "$row" | cut -d: -f2); b=$(echo "$row" | cut -d: -f3)
    la=$(echo "$row" | cut -d: -f4); lb=$(echo "$row" | cut -d: -f5)
    ip link add "nt-${ln}a" type veth peer name "nt-${ln}b" || die "创建数据链路 $ln 失败"
    ip link set "nt-${ln}a" netns "$(dev_ns "$a")"
    ip link set "nt-${ln}b" netns "$(dev_ns "$b")"
    ip netns exec "$(dev_ns "$a")" ip link set "nt-${ln}a" up
    ip netns exec "$(dev_ns "$b")" ip link set "nt-${ln}b" up
    ip netns exec "$(dev_ns "$a")" ip addr add "$la/30" dev "nt-${ln}a"
    ip netns exec "$(dev_ns "$b")" ip addr add "$lb/30" dev "nt-${ln}b"
  done

  # ---- 2) 每台设备的 FRR / sshd / snmpd 配置 ----
  mkdir -p /usr/local/etc
  cat > /usr/local/bin/nt-cli <<'CLIEOF'
#!/bin/sh
# NetTopo 实验室设备 CLI 包装（vtysh 集成 CLI）。
# 设备管理 IP 只在本 network namespace 内可见，故按管理 IP 查映射表定位本设备的 vty socket 目录。
# stderr 丢弃：宿主机 /etc/frr 下的系统配置对普通账号不可读，vtysh 每次都会刷两行权限告警，
# 会污染应用侧捕获到的命令输出（真机测试里表现为命令输出里混入无关告警）。
ip=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -m1 '^10\.99\.')
d=$(awk -v ip="$ip" '$1==ip{print $2}' /usr/local/etc/nettopo-lab-cli.map 2>/dev/null)
[ -n "$d" ] || { echo "nt-cli: 无法定位设备（管理 IP=$ip）" >&2; exit 1; }
exec vtysh --vty_socket "$d" "$@" 2>/dev/null
CLIEOF
  chmod 755 /usr/local/bin/nt-cli
  : > /usr/local/etc/nettopo-lab-cli.map
  for row in "${DEVSPEC[@]}"; do
    id=$(echo "$row" | cut -d: -f1)
    local d name as lan
    d=$(dev_dir "$id"); name=$(dev_name "$id"); as=$(dev_as "$id"); lan=$(dev_lan "$id")
    echo "$(dev_ip "$id") $d/vty" >> /usr/local/etc/nettopo-lab-cli.map
    # zebra：vty 口令（Telnet CLI 认证）。日志走命令行 --log file:（配置里的 `log file` 在守护
    # 进程刚启动、日志文件尚不可写时会告警）。宣告网段不需要静态路由：bgpd 关了 import-check。
    {
      echo "hostname $name"
      echo "password $TELNET_PASS"
      echo "!"
      echo "line vty"
      echo " password $TELNET_PASS"
      echo "!"
    } > "$d/etc/zebra.conf"
    # bgpd：eBGP 邻居（邻居地址/AS 由链路表推导）
    {
      echo "hostname $name"
      echo "password $TELNET_PASS"
      echo "router bgp $as"
      echo " bgp router-id $(dev_lo "$id")"
      echo " no bgp ebgp-requires-policy"
      echo " no bgp network import-check"
      echo " network $lan"
      local l2 other nip
      for l2 in "${LINKSPEC[@]}"; do
        if [ "$(echo "$l2" | cut -d: -f2)" = "$id" ]; then other=$(echo "$l2" | cut -d: -f3); nip=$(echo "$l2" | cut -d: -f5)
        elif [ "$(echo "$l2" | cut -d: -f3)" = "$id" ]; then other=$(echo "$l2" | cut -d: -f2); nip=$(echo "$l2" | cut -d: -f4)
        else continue; fi
        echo " neighbor $nip remote-as $(dev_as "$other")"
        echo " neighbor $nip description $(echo "$l2" | cut -d: -f1)-to-$other"
      done
      echo "!"
      echo "line vty"
      echo " password $TELNET_PASS"
      echo "!"
    } > "$d/etc/bgpd.conf"
    chown -R frr:frr "$d" 2>/dev/null
    # sshd：独立主机密钥 + 独立 pidfile，监听设备管理 IP
    [ -f "$d/ssh/ssh_host_ed25519_key" ] || ssh-keygen -q -t ed25519 -N '' -f "$d/ssh/ssh_host_ed25519_key" >/dev/null
    [ -f "$d/ssh/ssh_host_rsa_key" ]     || ssh-keygen -q -t rsa -b 2048 -N '' -f "$d/ssh/ssh_host_rsa_key" >/dev/null
    {
      echo "Port 22"
      echo "ListenAddress $(dev_ip "$id")"
      echo "HostKey $d/ssh/ssh_host_ed25519_key"
      echo "HostKey $d/ssh/ssh_host_rsa_key"
      echo "PidFile $d/run/sshd.pid"
      echo "PasswordAuthentication yes"
      echo "KbdInteractiveAuthentication no"
      echo "UsePAM yes"
      echo "PermitRootLogin no"
      echo "AllowUsers $LAB_USER"
      echo "X11Forwarding no"
      echo "PrintMotd no"
      echo "Subsystem sftp internal-sftp"
    } > "$d/etc/sshd_config"
    # snmpd：v2c public + v3 auth/authPriv。注意 `-C`（不读默认配置）同时也不会读 USM 的
    # persistent 存储，因此 createUser 必须直接写在 -c 指定的主配置里，否则设备侧一直是
    # 「Unknown user name」（实测踩过：v3 用例全挂，而 v2c 一切正常）。
    {
      echo "agentaddress udp:161"
      echo "createUser v3auth SHA \"AuthPass1\""
      echo "createUser v3priv SHA \"AuthPass1\" AES \"PrivPass1\""
      echo "rocommunity public 10.99.0.0/16"
      echo "rocommunity public $CLIENT_NET"
      echo "rocommunity public 10.99.1.1"
      echo "rouser v3auth auth"
      echo "rouser v3priv priv"
      echo "sysName $name"
      echo "sysLocation nettopo-lab"
      echo "sysContact nettopo@lab"
      echo "sysServices 72"
    } > "$d/etc/snmpd.conf"
  done

  # ---- 3) 启动各设备服务（stdio 全部脱离 SSH 通道，否则守护进程会攥着 ssh 会话不放手）----
  for row in "${DEVSPEC[@]}"; do
    id=$(echo "$row" | cut -d: -f1)
    local d s
    d=$(dev_dir "$id"); s=$(dev_ns "$id")
    ip netns exec "$s" $AAEXEC /usr/lib/frr/zebra -u frr -g frr --vty_socket "$d/vty" -z "$d/run/zserv.api" \
      -i "$d/run/zebra.pid" -f "$d/etc/zebra.conf" -A 0.0.0.0 -P $VTY_PORT --log file:"$d/log/zebra.log" -d \
      </dev/null >>"$d/log/startup.err" 2>&1
    sleep 0.4
    ip netns exec "$s" $AAEXEC /usr/lib/frr/bgpd -u frr -g frr --vty_socket "$d/vty" -z "$d/run/zserv.api" \
      -i "$d/run/bgpd.pid" -f "$d/etc/bgpd.conf" --log file:"$d/log/bgpd.log" -d \
      </dev/null >>"$d/log/startup.err" 2>&1
    sleep 0.6
    local p
    for p in zebra bgpd; do    # 启动结果必须校验：daemon 起不来会一路带着「空设备」跑出难懂的断言失败
      [ -f "$d/run/$p.pid" ] || { warn "$(dev_name "$id") 的 $p 未起来，最后 5 行日志："; tail -5 "$d/log/startup.err" >&2 2>/dev/null || true; }
    done
    chmod -R 777 "$d/vty" 2>/dev/null   # 设备上的 vtysh（nt-cli）要能连本设备的 vty socket
    ip netns exec "$s" /usr/sbin/sshd -f "$d/etc/sshd_config" -E "$d/log/sshd.log" </dev/null >>"$d/log/startup.err" 2>&1
    ip netns exec "$s" /usr/sbin/snmpd -C -c "$d/etc/snmpd.conf" -p "$d/run/snmpd.pid" -Lf "$d/log/snmpd.log" </dev/null >>"$d/log/startup.err" 2>&1
  done

  sleep 3
  publish_allow
  status_report
}

# ---------------------------------------------------------------- 状态
port_open() { timeout 3 bash -c "cat < /dev/null > /dev/tcp/$1/$2" 2>/dev/null; }
bgp_summary() { # 设备 BGP 邻居状态（宿主侧经 vty socket 查询，不占管理面；带超时防挂死）
  timeout 8 vtysh --vty_socket "$1/vty" -c "show bgp ipv4 unicast summary" 2>/dev/null \
    | awk 'NR>1 && $1 ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ {print $1"="$10}' | tr '\n' ' '
}
status_report() {
  log "===== 设备状态 ====="
  local row id ip name d ssh_ok tel_ok snmp_name bgp
  for row in "${DEVSPEC[@]}"; do
    id=$(echo "$row" | cut -d: -f1); ip=$(dev_ip "$id"); name=$(dev_name "$id"); d=$(dev_dir "$id")
    ssh_ok=$(port_open "$ip" 22 && echo up || echo DOWN)
    tel_ok=$(port_open "$ip" $VTY_PORT && echo up || echo DOWN)
    snmp_name=$(snmpget -v2c -c public -t 2 -r 0 "$ip:161" 1.3.6.1.2.1.1.5.0 2>/dev/null | sed 's/.*STRING: //' | tr -d '"')
    [ -z "$snmp_name" ] && snmp_name=DOWN
    bgp=$(bgp_summary "$d")
    log "  $name  $ip  ssh=$ssh_ok  telnet=$tel_ok  snmp=$snmp_name  bgp=[$bgp]"
    log "      发布：ssh=$LAB_PUBLIC_IP:$(pub_ssh "$id")  telnet=$LAB_PUBLIC_IP:$(pub_telnet "$id")  snmp=$LAB_PUBLIC_IP:$(pub_snmp "$id")/udp"
  done
}

inventory() {
  local first=1 line="" row id d dls dli l2
  for row in "${DEVSPEC[@]}"; do
    id=$(echo "$row" | cut -d: -f1); d=$(dev_dir "$id")
    dls=""; dli=""
    for l2 in "${LINKSPEC[@]}"; do
      local ln a b la lb
      ln=$(echo "$l2" | cut -d: -f1); a=$(echo "$l2" | cut -d: -f2); b=$(echo "$l2" | cut -d: -f3)
      la=$(echo "$l2" | cut -d: -f4); lb=$(echo "$l2" | cut -d: -f5)
      if [ "$a" = "$id" ]; then dls="$dls\"nt-${ln}a\","; dli="$dli\"$la\","
      elif [ "$b" = "$id" ]; then dls="$dls\"nt-${ln}b\","; dli="$dli\"$lb\","; fi
    done
    [ $first = 1 ] || line="$line,"
    first=0
    line="$line{\"id\":\"$id\",\"name\":\"$(dev_name "$id")\",\"ns\":\"$(dev_ns "$id")\",\"host\":\"$LAB_PUBLIC_IP\",\"internalIp\":\"$(dev_ip "$id")\",\"sshPort\":$(pub_ssh "$id"),\"telnetPort\":$(pub_telnet "$id"),\"snmpPort\":$(pub_snmp "$id"),\"devSshPort\":22,\"devTelnetPort\":$VTY_PORT,\"devSnmpPort\":161,\"as\":$(dev_as "$id"),\"lan\":\"$(dev_lan "$id")\",\"loopback\":\"$(dev_lo "$id")\",\"mgmtHostIp\":\"$(dev_mgmt_host_ip "$id")\",\"sshUser\":\"$LAB_USER\",\"telnetPassword\":\"$TELNET_PASS\",\"devIf\":\"$(dev_ns_if "$id")\",\"hostIf\":\"$(dev_host_if "$id")\",\"dataIfs\":[${dls%,}],\"dataIps\":[${dli%,}],\"vtySocket\":\"$d/vty\",\"configDir\":\"$d/etc\",\"logDir\":\"$d/log\",\"runDir\":\"$d/run\",\"sshDir\":\"$d/ssh\"}"
  done
  echo "{\"lab\":\"nettopo\",\"labRoot\":\"$LAB_ROOT\",\"host\":\"$LAB_PUBLIC_IP\",\"clientNet\":\"$CLIENT_NET\",\"telnetPassword\":\"$TELNET_PASS\",\"sshUser\":\"$LAB_USER\",\"devices\":[$line]}"
}

case "$CMD" in
  up)     setup ;;
  down)   teardown ;;
  status) need_root; status_report ;;
  inv)    inventory; exit 0 ;;
  *)      die "未知子命令：$CMD（可用 up / down / status / inv）" ;;
esac
echo "NETTOPO_LAB_INVENTORY=$(inventory)"
