#!/usr/bin/env bash
# Host firewall rules (VM design sections 3 and 4), in two chains that
# DOCKER-USER, which sees all container traffic before Docker's own rules,
# jumps to:
#
# SIM-G-METADATA, for anything addressed to 169.254.169.254. Only traffic
# that arrives on the gateway's bridge (sim-g-gw0) AND comes from its subnet
# passes. A forged source on another bridge fails the interface test, and
# every other network, including docker0 and nginx's bridge, is dropped. DNS
# (port 53, which the metadata server also answers) is allowed for every
# container, because it issues no credentials.
#
# SIM-G-INGRESS, for new connections to nginx's published ports (after
# Docker's DNAT, 8080 and 8443 on its bridge's subnet): per source address,
# at most 20 new connections a second (burst 40) and 32 open at once. These
# bound connection floods; nginx limits the requests inside each connection.
#
# Each chain is built completely before DOCKER-USER jumps to it, and an
# existing chain must match exactly, or the unit fails closed. The metadata
# jump stays first in DOCKER-USER and the ingress jump second.
set -euo pipefail

metadata_rules=(
  "-p udp -m udp --dport 53 -j RETURN"
  "-p tcp -m tcp --dport 53 -j RETURN"
  "! -i sim-g-gw0 -j DROP"
  "! -s 172.31.250.16/28 -j DROP"
)
ingress_rules=(
  "-m conntrack --ctstate NEW -m hashlimit --hashlimit-above 20/sec --hashlimit-burst 40 --hashlimit-mode srcip --hashlimit-name sim-g-ingress -j DROP"
  "-m conntrack --ctstate NEW -m connlimit --connlimit-above 32 --connlimit-mask 32 --connlimit-saddr -j DROP"
)
metadata_jump=(DOCKER-USER -d 169.254.169.254/32 -j SIM-G-METADATA)
# shellcheck disable=SC2054 # 8080,8443 is one multiport argument
ingress_jump=(DOCKER-USER -d 172.31.250.32/28 -p tcp -m multiport --dports 8080,8443 -j SIM-G-INGRESS)

fail() {
  printf '{"severity":"ERROR","msg":"firewall_failed","reason":"%s"}\n' "$1"
  exit 1
}

ensure_chain() { # name rules...
  local chain="$1" expected rule actual
  shift
  expected="-N ${chain}"
  for rule in "$@"; do expected+=$'\n'"-A ${chain} ${rule}"; done
  if actual="$(iptables -w -S "${chain}" 2>/dev/null)"; then
    [[ "${actual}" == "${expected}" ]] || fail firewall_rules_mismatch
  else
    iptables -w -N "${chain}" || fail firewall_unavailable
    for rule in "$@"; do
      # shellcheck disable=SC2086 # each rule is a fixed, reviewed word list
      iptables -w -A "${chain}" ${rule} || fail firewall_unavailable
    done
  fi
}

ensure_jump() { # position rule...
  local position="$1" status
  shift
  set +e
  iptables -w -C "$@" 2>/dev/null
  status=$?
  set -e
  case "${status}" in
    0) ;;
    1) iptables -w -I "$1" "${position}" "${@:2}" || fail firewall_unavailable ;;
    *) fail firewall_unavailable ;;
  esac
}

iptables -w -S DOCKER-USER >/dev/null 2>&1 || fail firewall_chain_missing

ensure_chain SIM-G-METADATA "${metadata_rules[@]}"
ensure_chain SIM-G-INGRESS "${ingress_rules[@]}"
ensure_jump 1 "${metadata_jump[@]}"
ensure_jump 2 "${ingress_jump[@]}"
# Nothing may run ahead of them (an ACCEPT there would bypass both).
[[ "$(iptables -w -S DOCKER-USER | sed -n 2p)" == "-A ${metadata_jump[*]}" ]] ||
  fail firewall_jump_not_first
[[ "$(iptables -w -S DOCKER-USER | sed -n 3p)" == "-A ${ingress_jump[*]}" ]] ||
  fail firewall_ingress_jump_not_second
printf '{"severity":"INFO","msg":"firewall_ready"}\n'
