#!/usr/bin/env bash
# Behaviour cases for the host scripts, run in the check container after
# run.sh has written them to /etc/sim-g/bin. Real blkid, mkfs.ext4, dd, cmp
# and iptables (in the container's own network namespace) are used where they
# can be; docker, systemctl, curl and the mount tools are stubs that record
# their arguments. Nothing outside the container is touched.
set -euo pipefail

bin=/etc/sim-g/bin
stubs="$(mktemp -d)"
log="${stubs}/calls.log"
export STUB_LOG="${log}"
: >"${log}"
real_path="${PATH}"
failures=0

stub() { # name body
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$(basename "$0") $*" >>"${STUB_LOG}"\n%s\n' "$2" \
    >"${stubs}/$1"
  chmod +x "${stubs}/$1"
}
stub blkid 'printf "%b" "${STUB_BLKID_EXPORT:-}"; exit "${STUB_BLKID_STATUS:-0}"'
stub blockdev 'echo "${STUB_DISK_SIZE:-67108864}"'
stub dd '
[[ -z "${STUB_DD_FAIL:-}" ]] || exit 1
count=16777216
for arg in "$@"; do [[ "${arg}" == count=* ]] && count="${arg#count=}"; done
if [[ -n "${STUB_DISK_ZERO:-}" ]]; then head -c "${count}" /dev/zero; else head -c "${count}" /dev/urandom; fi'
stub mkfs.ext4 'exit 0'
stub mount 'exit 0'
stub mountpoint 'exit "${STUB_MOUNTED:-1}"'
stub findmnt 'echo "${STUB_FINDMNT_SOURCE:-}"'
stub curl '
case "$*" in
  *project-id*) [[ -z "${STUB_CURL_FAIL:-}" ]] || exit 22; echo "${STUB_PROJECT:-synthetic-gateway-dev}" ;;
  *service-accounts/default/token*)
    [[ -z "${STUB_TOKEN_FAIL:-}" ]] || exit 22
    echo "{\"access_token\": \"synthetic-token\"}" ;;
  *storage.googleapis.com/upload/*)
    # The backup upload: drain the header config on stdin, report a status.
    cat >/dev/null
    printf "%s" "${STUB_UPLOAD_HTTP:-200}" ;;
  *gateway.digest*)
    [[ -z "${STUB_POINTER_FAIL:-}" ]] || { printf 000; exit 7; }
    cat >"${STUB_LOG}.config"
    out=""
    while [[ $# -gt 0 ]]; do [[ "$1" == -o ]] && out="$2"; shift; done
    [[ -n "${out}" ]] && printf "%s\n" "${STUB_POINTER:-}" >"${out}"
    printf "%s" "${STUB_POINTER_HTTP:-200}" ;;
  *) exit 22 ;;
esac'
stub docker-credential-gcr 'exit "${STUB_GCR_STATUS:-0}"'
stub systemctl '
case "$*" in
  "show --property ActiveState --value sim-g-backup-recent.service")
    # Running for STUB_BUSY_CHECKS checks, then done (a file counts them).
    n="$(cat /tmp/stub-busy 2>/dev/null || echo 0)"; echo $((n + 1)) >/tmp/stub-busy
    if [[ "${n}" -lt "${STUB_BUSY_CHECKS:-0}" ]]; then echo activating; else echo inactive; fi
    [[ -z "${STUB_MAINTENANCE_DURING_WAIT:-}" ]] || { mkdir -p /run/sim-g; touch /run/sim-g/maintenance; }
    exit 0 ;;
  "show --property ActiveState --value "*) echo inactive; exit 0 ;;
  "show --property LoadState --value "*)
    [[ " ${STUB_UNLOADED:-} " == *" ${*: -1} "* ]] && { echo not-found; exit 0; }
    echo loaded; exit 0 ;;
  "stop "*" ${STUB_UNLOADED:-none} "* | "stop "*" ${STUB_UNLOADED:-none}") exit 5 ;;
  "reboot") [[ -z "${STUB_SYSTEMCTL_REBOOT_FAIL:-}" ]] || exit 1; exit 0 ;;
  "is-active --quiet sim-g-postgres.service") [[ -z "${STUB_POSTGRES_DOWN:-}" ]] || exit 3; exit 0 ;;
  "restart sim-g-gateway.service")
    # "once": only the first restart fails, so the rollback restart succeeds.
    if [[ "${STUB_RESTART_FAIL:-}" == once && ! -e /tmp/stub-restart-failed ]]; then
      touch /tmp/stub-restart-failed
      exit 1
    fi
    [[ -z "${STUB_RESTART_FAIL:-}" || "${STUB_RESTART_FAIL}" == once ]] || exit 1
    # The restarted container runs the image the settings now name.
    sed -n "s/^SIM_G_GATEWAY_IMAGE=//p" /mnt/disks/data/sim-g/host.env >/tmp/stub-container
    exit 0 ;;
esac
exit "${STUB_SYSTEMCTL_STATUS:-0}"'
stub docker '
if [[ "$1 $2" == "network inspect" ]]; then
  name="${*: -1}"
  for entry in ${STUB_NETWORKS:-}; do
    if [[ "${entry%%=*}" == "${name}" ]]; then
      printf "%s\n" "${entry#*=}" | tr "," " "
      exit 0
    fi
  done
  exit 1
fi
if [[ "$1" == run && "$*" == *migration-cli* && -n "${STUB_MAINTENANCE_DURING_MIGRATION:-}" ]]; then
  mkdir -p /run/sim-g && touch /run/sim-g/maintenance
fi
if [[ "$1" == run && -n "${STUB_DOCKER_RUN_FAIL:-}" ]]; then exit "${STUB_DOCKER_RUN_FAIL}"; fi
# certbot: writes the chain it "obtained" (STUB_CERTBOT_CHAIN), if any.
if [[ "$1" == run && "$*" == *certonly* && -n "${STUB_CERTBOT_CHAIN:-}" ]]; then
  live="/mnt/disks/data/sim-g/edge/certs/live/${SIM_G_DOMAIN}"
  mkdir -p "${live}"
  printf "%s\n" "${STUB_CERTBOT_CHAIN}" >"${live}/fullchain.pem"
  printf "synthetic key\n" >"${live}/privkey.pem"
fi
if [[ "$1" == exec ]]; then [[ -n "${STUB_EXEC_READY:-}" ]] && exit 0; exit 2; fi
# The PostgreSQL container appears only after STUB_CONTAINER_ABSENT_CHECKS
# checks (its image is still being pulled).
if [[ "$1 $2" == "container inspect" ]]; then
  n="$(cat /tmp/stub-absent 2>/dev/null || echo 0)"; echo $((n + 1)) >/tmp/stub-absent
  [[ "${n}" -ge "${STUB_CONTAINER_ABSENT_CHECKS:-0}" ]] || exit 1
  exit 0
fi
# The backup encryption container: the dump in, an age file out.
if [[ "$1" == run && "$*" == *"age --encrypt"* ]]; then
  cat >/dev/null
  printf "age-encryption.org/v1\nsynthetic ciphertext\n"
  exit 0
fi
if [[ "$1" == pull && -n "${STUB_PULL_FAIL:-}" ]]; then exit 1; fi
if [[ "$1 $2" == "image ls" ]]; then printf "%s\n" ${STUB_IMAGES:-}; exit 0; fi
if [[ "$1 $2" == "image rm" && -n "${STUB_RM_FAIL:-}" ]]; then exit 1; fi
if [[ "$1" == inspect ]]; then
  # The running container: healthy unless it runs the bad digest.
  image="$(cat /tmp/stub-container 2>/dev/null || true)"
  if [[ -n "${STUB_ALWAYS_UNHEALTHY:-}" ]] ||
    { [[ -n "${STUB_BAD_DIGEST:-}" ]] && [[ "${image}" == *"${STUB_BAD_DIGEST}"* ]]; }; then
    echo "true ${image} unhealthy"
  else
    echo "true ${image} healthy"
  fi
fi
exit 0'
export PATH="${stubs}:${PATH}"

# Runs one command; records its stdout and exit status.
# Every line any case printed, so the log shipper's shape can be checked
# against all of them at the end.
printed="${stubs}/printed.log"
: >"${printed}"
run() {
  : >"${log}"
  set +e
  output="$(env "$@" 2>/dev/null)"
  status=$?
  set -e
  printf '%s\n' "${output}" >>"${printed}"
}
check() { # description condition...
  local description="$1"
  shift
  if "$@"; then
    echo "ok   ${description}"
  else
    echo "FAIL ${description}" >&2
    echo "     status=${status:-} output=${output:-}" >&2
    sed 's/^/     call: /' "${log}" >&2 || true
    failures=$((failures + 1))
  fi
}
succeeded() { [[ "${status}" -eq 0 ]]; }
reason() { [[ "${status}" -ne 0 && "${output}" == *"\"reason\":\"$1\""* ]]; }
called() { grep -qF -- "$1" "${log}"; }
not_called() { ! grep -qF -- "$1" "${log}"; }
calls() { grep -cF -- "$1" "${log}" || true; }
fails() { ! "$@"; }

# --- data disk: the blank test, with the real tools ------------------------
images="$(mktemp -d)"
blank() ( PATH="${real_path}" && source "${bin}/sim-g-data-disk.sh" && blank_disk "$1" )

head -c $((64 << 20)) /dev/zero >"${images}/zero.img"
check "blank test: an all-zero disk is blank" blank "${images}/zero.img"

cp "${images}/zero.img" "${images}/tail.img"
printf 'EFI PART' | PATH="${real_path}" dd of="${images}/tail.img" bs=1 seek=$(((64 << 20) - 512)) conv=notrunc status=none
check "blank test: data near the end (a backup GPT) is not blank" \
  fails blank "${images}/tail.img"

head -c $((64 << 20)) /dev/zero >"${images}/ext4.img"
PATH="${real_path}" mkfs.ext4 -q -F -L sim-g-data "${images}/ext4.img"
# One byte of the primary superblock changed, as a torn write might leave it.
printf '\xff' | PATH="${real_path}" dd of="${images}/ext4.img" bs=1 seek=$((1024 + 0x78)) conv=notrunc status=none
set +e
PATH="${real_path}" blkid -p -o export "${images}/ext4.img" >/dev/null 2>&1
probe_status=$?
set -e
check "blank test: real blkid reports a damaged ext4 as having no signature (exit 2)" \
  test "${probe_status}" -eq 2
check "blank test: a damaged ext4 is still not blank, so it is never formatted" \
  fails blank "${images}/ext4.img"

# A filesystem whose first 16 MiB were wiped still has backup superblocks
# further in, for 1 KiB blocks (8 MiB groups) and 4 KiB blocks (128 MiB).
for block in 1024 4096; do
  truncate -s 512M "${images}/wiped-${block}.img"
  PATH="${real_path}" mkfs.ext4 -q -F -b "${block}" -L sim-g-data "${images}/wiped-${block}.img"
  PATH="${real_path}" dd if=/dev/zero of="${images}/wiped-${block}.img" bs=1M count=16 \
    conv=notrunc status=none
  set +e
  PATH="${real_path}" blkid -p -o export "${images}/wiped-${block}.img" >/dev/null 2>&1
  probe_status=$?
  set -e
  check "blank test: real blkid finds nothing on an ext4 (${block}-byte blocks) with a wiped head" \
    test "${probe_status}" -eq 2
  check "blank test: its backup superblocks make it not blank" fails blank "${images}/wiped-${block}.img"
done

truncate -s $(((64 << 20) + 512)) "${images}/unaligned.img"
printf 'EFI PART' | PATH="${real_path}" dd of="${images}/unaligned.img" bs=1 seek=$((64 << 20)) \
  conv=notrunc status=none
check "blank test: data in the last sector of an unaligned disk is not blank" \
  fails blank "${images}/unaligned.img"

head -c $((1 << 20)) /dev/zero >"${images}/small.img"
check "blank test: a disk too small to check is not blank" \
  fails blank "${images}/small.img"
check "blank test: an unreadable disk is not blank" \
  fails blank "${images}/missing.img"

# --- data disk: every outcome of the script ------------------------------
device=/dev/disk/by-id/google-sim-g-data
mkdir -p "$(dirname "${device}")"
rm -f "${device}"
run bash "${bin}/sim-g-data-disk.sh"
check "data disk: a missing device fails" reason data_disk_missing
check "data disk: a missing device is never formatted" not_called mkfs.ext4

mknod "${device}" b 7 200
run STUB_BLKID_STATUS=2 STUB_DISK_ZERO=1 bash "${bin}/sim-g-data-disk.sh"
check "data disk: a blank disk is formatted and mounted" \
  bash -c '[[ $0 -eq 0 && $1 == *"\"formatted\":true"* ]]' "${status}" "${output}"
check "data disk: formatted with the label" called "mkfs.ext4 -q -L sim-g-data"
check "data disk: mounted nodev,nosuid,noexec" \
  called "mount -o nodev,nosuid,noexec ${device} /mnt/disks/data"

run STUB_BLKID_STATUS=2 bash "${bin}/sim-g-data-disk.sh"
check "data disk: no signature but data present fails" reason data_disk_not_blank
check "data disk: no signature but data present is never formatted" not_called mkfs.ext4

run STUB_BLKID_STATUS=2 STUB_DD_FAIL=1 bash "${bin}/sim-g-data-disk.sh"
check "data disk: a read error fails" reason data_disk_not_blank
check "data disk: a read error is never formatted" not_called mkfs.ext4

run STUB_BLKID_EXPORT='TYPE=ext4\nLABEL=sim-g-data\n' bash "${bin}/sim-g-data-disk.sh"
check "data disk: an existing filesystem is mounted" \
  bash -c '[[ $0 -eq 0 && $1 == *"\"formatted\":false"* ]]' "${status}" "${output}"
check "data disk: an existing filesystem is never formatted" not_called mkfs.ext4
check "data disk: postgres directory belongs to uid 70" \
  bash -c '[[ "$(stat -c "%u %a" /mnt/disks/data/postgres)" == "70 700" ]]'

run STUB_BLKID_EXPORT='TYPE=xfs\nLABEL=sim-g-data\n' bash "${bin}/sim-g-data-disk.sh"
check "data disk: another filesystem type fails" reason data_disk_unexpected_filesystem
check "data disk: another filesystem type is never formatted" not_called mkfs.ext4
check "data disk: another filesystem type is never mounted" not_called "mount -o"

run STUB_BLKID_EXPORT='TYPE=ext4\nLABEL=other\n' bash "${bin}/sim-g-data-disk.sh"
check "data disk: a foreign label fails" reason data_disk_unexpected_label
check "data disk: a foreign label is never formatted" not_called mkfs.ext4

run STUB_BLKID_EXPORT='PTTYPE=gpt\n' bash "${bin}/sim-g-data-disk.sh"
check "data disk: a partition table fails" reason data_disk_unexpected_filesystem
check "data disk: a partition table is never formatted" not_called mkfs.ext4

for code in 4 8; do
  run STUB_BLKID_STATUS="${code}" bash "${bin}/sim-g-data-disk.sh"
  check "data disk: blkid exit ${code} fails" reason data_disk_probe_failed
  check "data disk: blkid exit ${code} is never formatted" not_called mkfs.ext4
done

run STUB_MOUNTED=0 STUB_FINDMNT_SOURCE="${device}" STUB_BLKID_STATUS=2 STUB_DISK_ZERO=1 \
  bash "${bin}/sim-g-data-disk.sh"
check "data disk: its own existing mount is kept" succeeded
check "data disk: its own existing mount is never formatted" not_called mkfs.ext4

run STUB_MOUNTED=0 STUB_FINDMNT_SOURCE=tmpfs bash "${bin}/sim-g-data-disk.sh"
check "data disk: something else mounted there fails" reason data_disk_unexpected_mount
check "data disk: something else mounted there is never prepared" \
  bash -c '[[ $0 -ne 0 ]]' "${status}"

# --- docker networks -----------------------------------------------------
run bash "${bin}/sim-g-networks.sh"
check "networks: missing networks are created" succeeded
for spec in \
  "172.31.250.0/28 --opt com.docker.network.bridge.name=sim-g-int0 --opt com.docker.network.driver.mtu=1460 --internal sim-g-internal" \
  "172.31.250.16/28 --opt com.docker.network.bridge.name=sim-g-gw0 --opt com.docker.network.driver.mtu=1460 sim-g-gateway-egress" \
  "172.31.250.32/28 --opt com.docker.network.bridge.name=sim-g-edge0 --opt com.docker.network.driver.mtu=1460 sim-g-edge-egress"; do
  check "networks: ${spec##* } has its subnet, bridge name and MTU" \
    called "docker network create --driver bridge --subnet ${spec}"
done

matching='sim-g-internal=172.31.250.0/28,true,false,sim-g-int0,1460 sim-g-gateway-egress=172.31.250.16/28,false,false,sim-g-gw0,1460 sim-g-edge-egress=172.31.250.32/28,false,false,sim-g-edge0,1460'
run STUB_NETWORKS="${matching}" bash "${bin}/sim-g-networks.sh"
check "networks: matching networks are kept" succeeded
check "networks: matching networks are not recreated" not_called "network create"

run STUB_NETWORKS="${matching/28,true/28,false}" bash "${bin}/sim-g-networks.sh"
check "networks: an internal bridge with egress fails" reason network_mismatch_sim-g-internal
run STUB_NETWORKS="${matching/16\/28,false,false/16\/28,false,true}" bash "${bin}/sim-g-networks.sh"
check "networks: an IPv6-enabled bridge fails" reason network_mismatch_sim-g-gateway-egress
run STUB_NETWORKS="${matching/sim-g-gw0/docker7}" bash "${bin}/sim-g-networks.sh"
check "networks: another bridge name fails" reason network_mismatch_sim-g-gateway-egress
run STUB_NETWORKS="${matching/sim-g-edge0,1460/sim-g-edge0,1500}" bash "${bin}/sim-g-networks.sh"
check "networks: another MTU fails" reason network_mismatch_sim-g-edge-egress

# --- metadata-server isolation, with the real iptables -------------------
ipt() { PATH="${real_path}" iptables -w "$@"; }
firewall() { run PATH="${real_path}" bash "${bin}/sim-g-firewall.sh"; }
expected='-N SIM-G-METADATA
-A SIM-G-METADATA -p udp -m udp --dport 53 -j RETURN
-A SIM-G-METADATA -p tcp -m tcp --dport 53 -j RETURN
-A SIM-G-METADATA ! -i sim-g-gw0 -j DROP
-A SIM-G-METADATA ! -s 172.31.250.16/28 -j DROP'
jumps() { ipt -S DOCKER-USER | grep -cF -- '-d 169.254.169.254/32 -j SIM-G-METADATA' || true; }

firewall
check "firewall: a missing DOCKER-USER chain fails closed" reason firewall_chain_missing

ipt -N DOCKER-USER
firewall
check "firewall: the rules are installed" succeeded
check "firewall: the metadata chain holds exactly the reviewed rules" \
  bash -c '[[ "$(PATH=$1 iptables -w -S SIM-G-METADATA)" == "$2" ]]' _ "${real_path}" "${expected}"
check "firewall: DOCKER-USER sends metadata traffic to it once" test "$(jumps)" -eq 1

firewall
check "firewall: a second run succeeds" succeeded
check "firewall: a second run adds nothing" test "$(jumps)" -eq 1

ipt -I DOCKER-USER 1 -j ACCEPT
firewall
check "firewall: a rule ahead of the metadata jump fails closed" reason firewall_jump_not_first
ipt -D DOCKER-USER 1

ipt -D SIM-G-METADATA 3
firewall
check "firewall: an altered metadata chain fails closed" reason firewall_rules_mismatch

# The ingress connection limits (nginx's published ports), from a clean slate.
ipt -F DOCKER-USER
for chain in SIM-G-METADATA SIM-G-INGRESS; do ipt -F "${chain}" 2>/dev/null || true; ipt -X "${chain}" 2>/dev/null || true; done
ingress='-N SIM-G-INGRESS
-A SIM-G-INGRESS -m conntrack --ctstate NEW -m hashlimit --hashlimit-above 20/sec --hashlimit-burst 40 --hashlimit-mode srcip --hashlimit-name sim-g-ingress -j DROP
-A SIM-G-INGRESS -m conntrack --ctstate NEW -m connlimit --connlimit-above 32 --connlimit-mask 32 --connlimit-saddr -j DROP'
ingress_jumps() { ipt -S DOCKER-USER | grep -cF -- '-d 172.31.250.32/28 -p tcp -m multiport --dports 8080,8443 -j SIM-G-INGRESS' || true; }
firewall
check "firewall: the ingress limits are installed" succeeded
check "firewall: the ingress chain holds exactly the reviewed rules" \
  bash -c '[[ "$(PATH=$1 iptables -w -S SIM-G-INGRESS)" == "$2" ]]' _ "${real_path}" "${ingress}"
check "firewall: only nginx's published ports jump to it, once" test "$(ingress_jumps)" -eq 1
check "firewall: the metadata jump stays first and the ingress jump second" bash -c '
  rules="$(PATH=$1 iptables -w -S DOCKER-USER)"
  [[ "$(sed -n 2p <<<"${rules}")" == *"-j SIM-G-METADATA" && "$(sed -n 3p <<<"${rules}")" == *"-j SIM-G-INGRESS" ]]' _ "${real_path}"
firewall
check "firewall: a second run adds no ingress jump" test "$(ingress_jumps)" -eq 1

ipt -D SIM-G-INGRESS 2
firewall
check "firewall: an altered ingress chain fails closed" reason firewall_rules_mismatch
ipt -A SIM-G-INGRESS -m conntrack --ctstate NEW -m connlimit --connlimit-above 32 --connlimit-mask 32 --connlimit-saddr -j DROP

ipt -I DOCKER-USER 2 -j ACCEPT
firewall
check "firewall: a rule between the jumps fails closed" reason firewall_ingress_jump_not_second
ipt -D DOCKER-USER 2

# --- host settings -------------------------------------------------------
env_file=/mnt/disks/data/sim-g/host.env
mkdir -p "$(dirname "${env_file}")"
digest="sha256:$(printf '%064d' 0)"
registry=us-central1-docker.pkg.dev
gateway_image="${registry}/synthetic-gateway-dev/sim-g/family-brain-gateway@${digest}"
postgres_image="${registry}/synthetic-gateway-dev/sim-g/sim-g-postgres@${digest}"
edge_image="${registry}/synthetic-gateway-dev/sim-g/nginx-unprivileged@${digest}"
certbot_image="${registry}/synthetic-gateway-dev/sim-g/certbot@${digest}"
recipient="age1$(printf 'q%.0s' {1..58})"
settings=("SIM_G_GATEWAY_IMAGE=${gateway_image}" "SIM_G_POSTGRES_IMAGE=${postgres_image}"
  SIM_G_BACKUP_BUCKET=synthetic-gateway-dev-sim-g-backups "SIM_G_BACKUP_RECIPIENT=${recipient}"
  "SIM_G_EDGE_IMAGE=${edge_image}" "SIM_G_CERTBOT_IMAGE=${certbot_image}"
  SIM_G_DOMAIN=gateway-dev.sim-g.test)
write_settings() {
  rm -f "${env_file}"
  { printf '# synthetic host settings\n\n'; printf '%s\n' "${settings[@]}" "$@"; } >"${env_file}"
  chmod 0600 "${env_file}"
}
probe=/tmp/print-settings.sh
printf '#!/usr/bin/env bash\nenv | grep -E "^(SIM_G_|HOME=)" | sort\n' >"${probe}"
with_settings() { run "$@" bash "${bin}/sim-g-host-env.sh" "${probe}"; }

write_settings
with_settings
check "host settings: valid settings pass" succeeded
check "host settings: they reach the command" \
  bash -c '[[ $0 == *"SIM_G_GATEWAY_IMAGE=$1"* && $0 == *"SIM_G_BACKUP_RECIPIENT=$2"* ]]' \
  "${output}" "${gateway_image}" "${recipient}"
check "host settings: the validated project reaches the command" \
  bash -c '[[ $0 == *"SIM_G_PROJECT=synthetic-gateway-dev"* ]]' "${output}"
check "host settings: the recent backup bucket is derived from the project" \
  bash -c '[[ $0 == *"SIM_G_RECENT_BACKUP_BUCKET=synthetic-gateway-dev-sim-g-recent-backups"* ]]' "${output}"
check "host settings: docker gets a writable home" \
  bash -c '[[ $0 == *"HOME=/var/lib/sim-g/home"* ]]' "${output}"
check "host settings: Artifact Registry pulls are configured" \
  called "docker-credential-gcr configure-docker --registries=${registry}"
mkdir -p /var/lib/sim-g/home/.docker
printf '{\n  "credHelpers": {\n    "%s": "gcr"\n  }\n}\n' "${registry}" \
  >/var/lib/sim-g/home/.docker/config.json
with_settings
check "host settings: an existing registry set-up is not rewritten" not_called configure-docker
rm -rf /var/lib/sim-g/home/.docker

chmod 0620 "${env_file}"
with_settings
check "host settings: a group-writable file fails" reason host_env_insecure
check "host settings: an insecure file never runs the command" bash -c '[[ $0 != *SIM_G_* ]]' "${output}"

write_settings
chown 1000 "${env_file}"
with_settings
check "host settings: a file not owned by root fails" reason host_env_insecure

write_settings
mv "${env_file}" "${env_file}.real"
ln -s "${env_file}.real" "${env_file}"
with_settings
check "host settings: a symlink fails" reason host_env_missing
rm -f "${env_file}" "${env_file}.real"

write_settings 'LD_PRELOAD=/tmp/x.so'
with_settings
check "host settings: an unexpected key fails" reason host_env_unexpected_key

write_settings 'SIM_G_RECENT_BACKUP_BUCKET=another-project-x-sim-g-recent-backups'
with_settings
check "host settings: the recent bucket cannot be set in the file" reason host_env_unexpected_key

write_settings 'BASH_ENV=/tmp/x.sh'
with_settings
check "host settings: BASH_ENV is refused" reason host_env_unexpected_key

write_settings "SIM_G_BACKUP_BUCKET=synthetic-gateway-dev-sim-g-backups"
with_settings
check "host settings: a repeated key fails" reason host_env_duplicate_key

settings[0]="SIM_G_GATEWAY_IMAGE=\"${gateway_image}\""
write_settings
with_settings
check "host settings: a quoted value fails" reason host_env_malformed
settings[0]="SIM_G_GATEWAY_IMAGE=${gateway_image}"

settings[0]="SIM_G_GATEWAY_IMAGE=${gateway_image%@*}:latest"
write_settings
with_settings
check "host settings: a tag instead of a digest fails" reason gateway_image_not_pinned
settings[0]="SIM_G_GATEWAY_IMAGE=${gateway_image}"

settings[1]="SIM_G_POSTGRES_IMAGE=${registry}/another-project-x/sim-g/sim-g-postgres@${digest}"
write_settings
with_settings
check "host settings: an image from another project fails" reason postgres_image_not_pinned
settings[1]="SIM_G_POSTGRES_IMAGE=postgres@${digest}"
write_settings
with_settings
check "host settings: an image outside Artifact Registry fails" reason postgres_image_not_pinned
settings[1]="SIM_G_POSTGRES_IMAGE=${postgres_image}"

settings[2]=SIM_G_BACKUP_BUCKET=another-project-x-sim-g-backups
write_settings
with_settings
check "host settings: another project's bucket fails" reason invalid_backup_bucket
settings[2]=SIM_G_BACKUP_BUCKET=synthetic-gateway-dev-sim-g-backups

settings[3]=SIM_G_BACKUP_RECIPIENT=AGE-SECRET-KEY-1
write_settings
with_settings
check "host settings: a non-recipient key fails" reason invalid_backup_recipient
settings[3]="SIM_G_BACKUP_RECIPIENT=${recipient}"

settings[4]="SIM_G_EDGE_IMAGE=nginxinc/nginx-unprivileged@${digest}"
write_settings
with_settings
check "host settings: an ingress image outside Artifact Registry fails" reason edge_image_not_pinned
settings[4]="SIM_G_EDGE_IMAGE=${edge_image}"

settings[5]="SIM_G_CERTBOT_IMAGE=${certbot_image%@*}:v5"
write_settings
with_settings
check "host settings: a certbot tag instead of a digest fails" reason certbot_image_not_pinned
settings[5]="SIM_G_CERTBOT_IMAGE=${certbot_image}"

for bad in Gateway.sim-g.test localhost -lead.sim-g.test 'sim-g.test.' a..b.test; do
  settings[6]="SIM_G_DOMAIN=${bad}"
  write_settings
  with_settings
  check "host settings: the host name ${bad} fails" reason invalid_domain
done
settings[6]=SIM_G_DOMAIN=gateway-dev.sim-g.test

settings_without_ingress=("${settings[@]:0:4}")
rm -f "${env_file}"
{ printf '%s\n' "${settings_without_ingress[@]}"; } >"${env_file}"
chmod 0600 "${env_file}"
with_settings
check "host settings: the ingress settings are optional for the other units" succeeded

write_settings
with_settings
check "host settings: terms not yet agreed are allowed" succeeded
check "host settings: the ingress settings reach the command" \
  bash -c '[[ $0 == *"SIM_G_DOMAIN=gateway-dev.sim-g.test"* && $0 == *"SIM_G_EDGE_IMAGE=$1"* && $0 == *"SIM_G_ACME_TERMS="* ]]' \
  "${output}" "${edge_image}"
write_settings SIM_G_ACME_TERMS=yes
with_settings
check "host settings: terms other than agreed fail" reason invalid_acme_terms
write_settings SIM_G_ACME_TERMS=agreed
with_settings
check "host settings: agreed terms pass" succeeded

write_settings
with_settings STUB_CURL_FAIL=1
check "host settings: an unknown project fails closed" reason metadata_project_unavailable
with_settings STUB_GCR_STATUS=1
check "host settings: a registry set-up failure fails closed" reason registry_auth_failed

# --- backup tiers (recovery point investigation, section 5) ----------------
marker=/var/lib/sim-g/backup-recent.last
daily_bucket=synthetic-gateway-dev-sim-g-backups
recent_bucket=synthetic-gateway-dev-sim-g-recent-backups
backup_settings=("SIM_G_BACKUP_BUCKET=${daily_bucket}" "SIM_G_BACKUP_RECIPIENT=${recipient}"
  "SIM_G_POSTGRES_IMAGE=${postgres_image}")
backup=(env "${backup_settings[@]}" "SIM_G_RECENT_BACKUP_BUCKET=${recent_bucket}" bash "${bin}/sim-g-backup.sh")
# Today's daily line, which the recent tier must leave exactly as it is.
daily_line='^\{"severity":"INFO","msg":"backup_completed","object":"family-brain-gateway/[0-9]{4}/[0-9]{2}/[0-9]{2}/[0-9]{8}T[0-9]{6}Z\.dump\.age","bytes":[0-9]+\}$'
matches() { [[ "${output}" =~ $1 ]]; }
rm -f "${marker}"

run "${backup[@]}"
check "backup: the daily tier succeeds" succeeded
check "backup: the daily line is unchanged" matches "${daily_line}"
check "backup: the daily tier uploads to the daily bucket" called "/b/${daily_bucket}/o?"
check "backup: the daily tier never touches the recent bucket" not_called "${recent_bucket}"
check "backup: the daily tier writes no recent marker" test ! -e "${marker}"
run "${backup[@]}" daily
check "backup: an explicit daily tier is the same" matches "${daily_line}"

run "${backup[@]}" recent
check "backup: the recent tier succeeds" succeeded
check "backup: the recent line names its tier" \
  matches '^\{"severity":"INFO","msg":"backup_completed","tier":"recent","object":"family-brain-gateway/[^"]+\.dump\.age","bytes":[0-9]+\}$'
check "backup: the recent tier uploads to the recent bucket" called "/b/${recent_bucket}/o?"
check "backup: the recent tier never touches the daily bucket" not_called "/b/${daily_bucket}/o?"
check "backup: a recent success records its completion time" \
  bash -c '[[ "$(cat "$0")" =~ ^[0-9]+$ ]] && (( $(date -u +%s) - $(cat "$0") < 60 ))' "${marker}"
check "backup: the marker is writable only by root" \
  bash -c '[[ "$(stat -c %u "$0")" == 0 && $((8#$(stat -c %a "$0") & 8#022)) -eq 0 ]]' "${marker}"

rm -f "${marker}"
run STUB_UPLOAD_HTTP=503 "${backup[@]}" recent
check "backup: a failed recent upload fails with its tier" \
  matches '^\{"severity":"ERROR","msg":"backup_failed","tier":"recent","reason":"backup_upload_http_503"\}$'
check "backup: a failed recent upload records nothing" test ! -e "${marker}"
run STUB_UPLOAD_HTTP=503 "${backup[@]}"
check "backup: a failed daily upload keeps today's line" \
  matches '^\{"severity":"ERROR","msg":"backup_failed","reason":"backup_upload_http_503"\}$'

run "${backup[@]}" weekly
check "backup: an unknown tier fails" reason invalid_backup_tier
check "backup: an unknown tier runs nothing" not_called "docker run"
run "${backup[@]}" recent extra
check "backup: extra arguments fail" reason invalid_backup_tier
run "${backup[@]}" ""
check "backup: an empty tier fails" reason invalid_backup_tier
run env "${backup_settings[@]}" bash "${bin}/sim-g-backup.sh"
check "backup: the daily tier needs no recent bucket" matches "${daily_line}"
run env "${backup_settings[@]}" bash "${bin}/sim-g-backup.sh" recent
check "backup: a recent run without its bucket fails" reason invalid_backup_bucket
check "backup: a recent run without its bucket runs nothing" not_called "docker run"
run env "${backup_settings[@]}" "SIM_G_RECENT_BACKUP_BUCKET=${daily_bucket}" bash "${bin}/sim-g-backup.sh" recent
check "backup: the recent tier never writes to the daily bucket" reason invalid_backup_bucket
check "backup: a recent bucket equal to the daily one runs nothing" not_called "docker run"

mkdir -p "${marker}"
run "${backup[@]}" recent
check "backup: a marker that cannot be written fails the run" reason backup_marker_failed
rm -rf "${marker}"
ln -s /tmp/elsewhere "${marker}"
run "${backup[@]}" recent
check "backup: a symlinked marker is never followed" reason backup_marker_failed
check "backup: a symlinked marker writes nothing through it" test ! -e /tmp/elsewhere
rm -f "${marker}"
ln -s /tmp/elsewhere "${marker}.tmp"
run "${backup[@]}" recent
check "backup: a planted temporary name is never written through" test ! -e /tmp/elsewhere
check "backup: a planted temporary name never becomes the marker" test ! -L "${marker}"
rm -f "${marker}" "${marker}.tmp"
check "backup: no temporary marker is left behind" \
  bash -c '! compgen -G "$0.*" >/dev/null' "${marker}"

# --- recent backup staleness (recovery point investigation, section 5) -----
uptime_file=/tmp/stub-uptime
stale=(env "SIM_G_UPTIME_FILE=${uptime_file}" bash "${bin}/sim-g-backup-stale.sh")
booted() { printf '%s.42 1234.5\n' "$1" >"${uptime_file}"; }
backed_up() { printf '%s\n' "$(($(date -u +%s) - $1))" >"${marker}"; }
quiet() { [[ "${status}" -eq 0 && "${output}" != *'"msg":"backup_stale"'* ]]; }
stale_because() { [[ "${status}" -ne 0 && "${output}" == *"\"msg\":\"backup_stale\",\"reason\":\"$1\""* ]]; }
booted 86400

backed_up 60
run "${stale[@]}"
check "stale: a fresh backup is quiet" quiet
check "stale: a fresh backup reports its age" \
  matches '^\{"severity":"INFO","msg":"backup_recent_fresh","age_seconds":(5[0-9]|6[0-9])\}$'
backed_up 1200
run "${stale[@]}"
check "stale: one missed run is quiet" quiet
# Two clock reads (here and in the script) can straddle a second, so the
# boundary cases keep a second or two of margin.
backed_up 2098
run "${stale[@]}"
check "stale: just under 35 minutes is quiet" quiet
backed_up 2101
run "${stale[@]}"
check "stale: over 35 minutes is stale" stale_because backup_too_old
backed_up 2400
run "${stale[@]}"
check "stale: two missed runs are stale" stale_because backup_too_old
check "stale: the stale line carries the age" \
  matches '^\{"severity":"ERROR","msg":"backup_stale","reason":"backup_too_old","age_seconds":24[0-9][0-9]\}$'

mkdir -p /run/sim-g
touch /run/sim-g/maintenance
run "${stale[@]}"
check "stale: maintenance never silences it" stale_because backup_too_old
rm -f "${marker}"
run "${stale[@]}"
check "stale: maintenance never silences a missing marker" stale_because marker_missing
rm -f /run/sim-g/maintenance

rm -f "${marker}"
run "${stale[@]}"
check "stale: no marker after the boot grace is stale" stale_because marker_missing
booted 600
run "${stale[@]}"
check "stale: no marker within the boot grace is quiet" quiet
check "stale: the boot grace says so" \
  matches '^\{"severity":"INFO","msg":"backup_stale_check_deferred","reason":"boot_grace"\}$'
backed_up 90000
run "${stale[@]}"
check "stale: an old marker within the boot grace is quiet" quiet
booted 2099
run "${stale[@]}"
check "stale: the last second of the boot grace is quiet" quiet
booted 2100
run "${stale[@]}"
check "stale: the boot grace ends at 35 minutes" stale_because backup_too_old
booted 86400

printf 'soon\n' >"${marker}"
run "${stale[@]}"
check "stale: a malformed marker is stale" stale_because marker_invalid
backed_up -3600
run "${stale[@]}"
check "stale: a marker from the future is stale" stale_because marker_invalid
backed_up -298
run "${stale[@]}"
check "stale: up to 5 minutes of clock skew is tolerated" quiet
check "stale: a skewed marker reports no negative age" \
  matches '^\{"severity":"INFO","msg":"backup_recent_fresh","age_seconds":0\}$'
backed_up -302
run "${stale[@]}"
check "stale: more than 5 minutes ahead is stale" stale_because marker_invalid
printf '08\n' >"${marker}"
run "${stale[@]}"
check "stale: a zero-padded marker is stale, not a shell error" stale_because marker_invalid
printf '0%s\n' "$(($(date -u +%s) - 60))" >"${marker}"
run "${stale[@]}"
check "stale: a zero-padded current time is not read as octal" stale_because marker_invalid
rm -f "${marker}"
mkdir -p "${marker}"
run "${stale[@]}"
check "stale: a marker that is not a file is invalid" stale_because marker_invalid
rmdir "${marker}"
printf '089.5 1.0\n' >"${uptime_file}"
backed_up 2400
run "${stale[@]}"
check "stale: a zero-padded uptime is read as decimal (89 s: within the grace)" \
  matches '^\{"severity":"INFO","msg":"backup_stale_check_deferred","reason":"boot_grace"\}$'
booted 86400
rm -f "${marker}"
backed_up 60
mv "${marker}" /tmp/real-marker
ln -s /tmp/real-marker "${marker}"
run "${stale[@]}"
check "stale: a symlinked marker is stale" stale_because marker_invalid
rm -f "${marker}" /tmp/real-marker

backed_up 2400
rm -f "${uptime_file}"
run "${stale[@]}"
check "stale: an unreadable uptime still checks" stale_because backup_too_old
rm -f "${marker}"

rm -f "${env_file}"
with_settings
check "host settings: a missing file fails" reason host_env_missing
write_settings

# --- workloads -----------------------------------------------------------
exported=("SIM_G_GATEWAY_IMAGE=${gateway_image}" "SIM_G_POSTGRES_IMAGE=${postgres_image}")

rm -f /mnt/disks/data/postgres/PG_VERSION
run "${exported[@]}" bash "${bin}/sim-g-postgres.sh"
check "postgres: an unbootstrapped data directory fails" reason postgres_not_bootstrapped
check "postgres: an unbootstrapped data directory never starts a server" not_called "docker run"

echo 17 >/mnt/disks/data/postgres/PG_VERSION
mkdir -p /run/sim-g
touch /run/sim-g/maintenance
run "${exported[@]}" bash "${bin}/sim-g-postgres.sh"
check "postgres: refuses to start during maintenance" reason maintenance_mode
check "postgres: never starts a second server during maintenance" not_called "docker run"
run "${exported[@]}" bash "${bin}/sim-g-gateway.sh"
check "gateway: refuses to start during maintenance" reason maintenance_mode
check "gateway: maintenance exits 3 (not restarted every 5 s)" test "${status}" -eq 3
rm -f /run/sim-g/maintenance

run "${exported[@]}" bash "${bin}/sim-g-postgres.sh"
check "postgres: starts with no network and no TCP listener" \
  bash -c 'grep -F "docker run" "$0" | grep -F -- "--network none" | grep -qF "listen_addresses="' "${log}"
check "postgres: the socket directory belongs to uid 70" \
  bash -c '[[ "$(stat -c "%u" /run/sim-g/postgresql)" == 70 ]]'

run STUB_EXEC_READY=1 SIM_G_READY_ATTEMPTS=3 bash "${bin}/sim-g-postgres-ready.sh"
check "postgres readiness: waits for the socket" succeeded
check "postgres readiness: asks the server itself" \
  called "docker exec sim-g-postgres pg_isready --host=/run/postgresql --quiet"
run SIM_G_READY_ATTEMPTS=3 bash "${bin}/sim-g-postgres-ready.sh"
check "postgres readiness: a server that never answers fails" reason postgres_not_ready
# COS replacement rehearsal: on a new boot disk the image pull took 160 s,
# which must not count against the readiness attempts.
rm -f /tmp/stub-absent
run STUB_EXEC_READY=1 STUB_CONTAINER_ABSENT_CHECKS=2 SIM_G_READY_ATTEMPTS=1 SIM_G_PULL_SECONDS=5 \
  bash "${bin}/sim-g-postgres-ready.sh"
check "postgres readiness: waits for the container while its image is pulled" succeeded
check "postgres readiness: then asks the server" \
  called "docker exec sim-g-postgres pg_isready --host=/run/postgresql --quiet"
rm -f /tmp/stub-absent
run STUB_EXEC_READY=1 STUB_CONTAINER_ABSENT_CHECKS=1000 SIM_G_READY_ATTEMPTS=1 SIM_G_PULL_SECONDS=1 \
  bash "${bin}/sim-g-postgres-ready.sh"
check "postgres readiness: a container that never appears fails" reason postgres_not_started
check "postgres readiness: never asks a server that never started" \
  not_called "docker exec sim-g-postgres pg_isready"
rm -f /tmp/stub-absent
start="${SECONDS}"
run STUB_EXEC_READY=1 STUB_CONTAINER_ABSENT_CHECKS=1000 SIM_G_PULL_SECONDS=30 MAINPID=999999 \
  bash "${bin}/sim-g-postgres-ready.sh"
check "postgres readiness: a start command that already exited fails at once" \
  bash -c '[[ $0 -ne 0 && "$1" == *postgres_not_started* && $2 -lt 5 ]]' "${status}" "${output}" "$((SECONDS - start))"
rm -f /tmp/stub-absent
run STUB_EXEC_READY=1 SIM_G_PULL_SECONDS=10m bash "${bin}/sim-g-postgres-ready.sh"
check "postgres readiness: a malformed pull budget fails" reason invalid_pull_seconds

rm -f /mnt/disks/data/sim-g/config/gateway.json
run "${exported[@]}" bash "${bin}/sim-g-gateway.sh"
check "gateway: a missing configuration document fails" reason gateway_config_missing
check "gateway: a missing configuration document exits 3 (not restarted every 5 s)" test "${status}" -eq 3
check "gateway: a missing configuration document never starts" not_called "docker create"

mkdir -p /mnt/disks/data/sim-g/config
echo '{}' >/mnt/disks/data/sim-g/config/gateway.json
run "${exported[@]}" bash "${bin}/sim-g-gateway.sh"
check "gateway: created on its egress bridge" \
  bash -c 'grep -F "docker create" "$0" | grep -qF -- "--network sim-g-gateway-egress"' "${log}"
check "gateway: publishes no port" \
  bash -c '! grep -F "docker create" "$0" | grep -qE -- "(^| )(-p|--publish)( |=)"' "${log}"
check "gateway: joined to the internal bridge at the ingress's fixed address" \
  called "docker network connect --ip 172.31.250.2 sim-g-internal sim-g-gateway"
check "gateway: listens on the ingress's fixed port" \
  bash -c 'grep -F "docker create" "$0" | grep -qF -- "--env PORT=8080"' "${log}"

# --- ingress (nginx) and its certificate -----------------------------------
edge_env=("SIM_G_EDGE_IMAGE=${edge_image}" "SIM_G_CERTBOT_IMAGE=${certbot_image}" SIM_G_DOMAIN=gateway-dev.sim-g.test)
live=/mnt/disks/data/sim-g/edge/certs/live/gateway-dev.sim-g.test
rm -rf /mnt/disks/data/sim-g/edge /run/sim-g/edge

run SIM_G_DOMAIN=gateway-dev.sim-g.test bash "${bin}/sim-g-edge.sh"
check "edge: without its image setting it fails" reason edge_image_missing

run "${edge_env[@]}" SIM_G_DOMAIN=Bad.sim-g.test bash "${bin}/sim-g-edge.sh"
check "edge: an invalid host name fails" reason invalid_domain
check "edge: an invalid host name never starts nginx" not_called "docker create"

run "${edge_env[@]}" bash "${bin}/sim-g-edge.sh"
check "edge: without a certificate it starts in bootstrap mode" \
  bash -c '[[ $0 == *"\"mode\":\"bootstrap\""* ]]' "${output}"
check "edge: bootstrap includes no TLS site" test ! -s /run/sim-g/edge/conf/site.conf
check "edge: the configuration names the host and the gateway's fixed address" bash -c '
  grep -qF "return 301 https://gateway-dev.sim-g.test\$request_uri;" /run/sim-g/edge/conf/nginx.conf &&
  grep -qF "server 172.31.250.2:8080;" /run/sim-g/edge/conf/nginx.conf &&
  ! grep -q "@DOMAIN@\|@UPSTREAM@" /run/sim-g/edge/conf/nginx.conf'
check "edge: publishes only 443 and 80, on its own bridge" bash -c '
  line="$(grep -F "docker create" "$0")"
  [[ "${line}" == *"--network sim-g-edge-egress"* && "${line}" == *"--publish 443:8443 --publish 80:8080"* ]] &&
  [[ "$(grep -oE -- "--publish [^ ]+" <<<"${line}" | wc -l)" -eq 2 ]]' "${log}"
check "edge: runs unprivileged and read-only" bash -c '
  line="$(grep -F "docker create" "$0")"
  [[ "${line}" == *"--read-only --cap-drop=ALL --security-opt=no-new-privileges --user 101:101"* ]]' "${log}"
check "edge: mounts its configuration, certificates and webroot read-only" bash -c '
  line="$(grep -F "docker create" "$0")"
  [[ "${line}" == *"/run/sim-g/edge/conf:/etc/nginx/sim-g:ro"* &&
    "${line}" == *"/mnt/disks/data/sim-g/edge/certs/live:/etc/sim-g/certs/live:ro"* &&
    "${line}" == *"/mnt/disks/data/sim-g/edge/certs/archive:/etc/sim-g/certs/archive:ro"* &&
    "${line}" == *"/run/sim-g/edge/acme:/var/www/acme:ro"* ]]' "${log}"
check "edge: mounts exactly its configuration, certificates and webroot" bash -c '
  mounts="$(grep -F "docker create" "$0" | grep -oE -- "--volume [^ ]+" | sort | tr "\n" " ")"
  [[ "${mounts}" == "--volume \"\${acme}:/var/www/acme:ro\" --volume \"\${certs}/archive:/etc/sim-g/certs/archive:ro\" --volume \"\${certs}/live:/etc/sim-g/certs/live:ro\" --volume \"\${conf}:/etc/nginx/sim-g:ro\" " ]] ||
  [[ "${mounts}" == "--volume /mnt/disks/data/sim-g/edge/certs/archive:/etc/sim-g/certs/archive:ro --volume /mnt/disks/data/sim-g/edge/certs/live:/etc/sim-g/certs/live:ro --volume /run/sim-g/edge/acme:/var/www/acme:ro --volume /run/sim-g/edge/conf:/etc/nginx/sim-g:ro " ]]' "${log}"
check "edge: joined to the internal bridge at its own fixed address" \
  called "docker network connect --ip 172.31.250.3 sim-g-internal sim-g-edge"
check "edge: the webroot and certificates belong to nginx's uid" bash -c '
  [[ "$(stat -c %u /run/sim-g/edge/acme)" == 101 && "$(stat -c %u /mnt/disks/data/sim-g/edge/certs)" == 101 ]]'

mkdir -p "${live}"
printf 'synthetic chain\n' >"${live}/fullchain.pem"
printf 'synthetic key\n' >"${live}/privkey.pem"
run "${edge_env[@]}" bash "${bin}/sim-g-edge.sh"
check "edge: with a certificate it serves TLS" \
  bash -c '[[ $0 == *"\"mode\":\"serving\""* ]]' "${output}"
check "edge: the TLS site names the host's certificate" \
  grep -qF "ssl_certificate /etc/sim-g/certs/live/gateway-dev.sim-g.test/fullchain.pem;" /run/sim-g/edge/conf/site.conf
rm -rf /mnt/disks/data/sim-g/edge

run "${edge_env[@]}" bash "${bin}/sim-g-certificate.sh"
check "certificate: before the owner accepts the terms it requests nothing, without failing" succeeded
check "certificate: that state is reported, not paged" \
  bash -c '[[ $0 == *"\"msg\":\"certificate_not_requested\",\"reason\":\"acme_terms_not_accepted\""* && $0 != *certificate_renewal_failed* ]]' "${output}"
check "certificate: no certbot without the terms" not_called "docker run"

run "${edge_env[@]}" SIM_G_ACME_TERMS=agreed STUB_DOCKER_RUN_FAIL=1 bash "${bin}/sim-g-certificate.sh"
check "certificate: a certbot failure is reported" reason certbot_failed
check "certificate: a failure logs certificate_renewal_failed" \
  bash -c '[[ $0 == *"\"msg\":\"certificate_renewal_failed\""* ]]' "${output}"

run "${edge_env[@]}" SIM_G_ACME_TERMS=agreed bash "${bin}/sim-g-certificate.sh"
check "certificate: success without a certificate still fails" reason certificate_missing

run "${edge_env[@]}" SIM_G_ACME_TERMS=agreed STUB_CERTBOT_CHAIN=first bash "${bin}/sim-g-certificate.sh"
check "certificate: the first certificate is issued" succeeded
check "certificate: certbot runs unprivileged, read-only, on the edge bridge" bash -c '
  line="$(grep -F "docker run" "$0")"
  [[ "${line}" == *"--network sim-g-edge-egress"* && "${line}" == *"--read-only --cap-drop=ALL --security-opt=no-new-privileges --user 101:101"* ]] &&
  [[ "${line}" == *"certonly --non-interactive --agree-tos"* && "${line}" == *"--webroot --webroot-path /var/www/acme"* ]] &&
  [[ "${line}" == *"--domain gateway-dev.sim-g.test --cert-name gateway-dev.sim-g.test --keep-until-expiring"* ]]' "${log}"
check "certificate: the first certificate restarts the ingress" called "systemctl restart sim-g-edge.service"
check "certificate: the first certificate needs no reload" not_called "docker kill"

run "${edge_env[@]}" SIM_G_ACME_TERMS=agreed STUB_CERTBOT_CHAIN=renewed bash "${bin}/sim-g-certificate.sh"
check "certificate: a renewal reloads nginx" called "docker kill --signal HUP sim-g-edge"
check "certificate: a renewal does not restart the ingress" not_called "systemctl restart"

run "${edge_env[@]}" SIM_G_ACME_TERMS=agreed STUB_CERTBOT_CHAIN=renewed bash "${bin}/sim-g-certificate.sh"
check "certificate: an unchanged certificate is current" \
  bash -c '[[ $0 == *"\"msg\":\"certificate_current\""* ]]' "${output}"
check "certificate: an unchanged certificate reloads nothing" not_called "docker kill"
rm -rf /mnt/disks/data/sim-g/edge /run/sim-g/edge

run "${exported[@]}" STUB_SYSTEMCTL_STATUS=1 bash "${bin}/sim-g-migrate.sh"
check "migrate: a failed backup stops it" reason migrate_backup_failed
check "migrate: a failed backup is retryable (exit 3)" test "${status}" -eq 3
check "migrate: a failed backup runs no migration" not_called "docker run"

run "${exported[@]}" bash "${bin}/sim-g-migrate.sh"
check "migrate: backup, migrations and grants succeed" succeeded
check "migrate: the backup runs through its unit" called "systemctl start sim-g-backup.service"
check "migrate: migrations, then grants" \
  bash -c 'grep -F "docker run" "$0" | head -1 | grep -qF migration-cli.js &&
    grep -F "docker run" "$0" | tail -1 | grep -qF grant-runtime.sql' "${log}"

run "${exported[@]}" STUB_DOCKER_RUN_FAIL=1 bash "${bin}/sim-g-migrate.sh"
check "migrate: a failed migration stops before the grants" reason migrate_migrations_failed
check "migrate: a failed migration never grants" test "$(calls grant-runtime.sql)" -eq 0

# --- deploy-pointer watcher ----------------------------------------------
current_image() { sed -n 's/^SIM_G_GATEWAY_IMAGE=//p' "${env_file}"; }
next_digest="sha256:$(printf '%064d' 1)"
bad_digest="sha256:$(printf '%064d' 2)"
next_image="${gateway_image%@*}@${next_digest}"
state=/mnt/disks/data/sim-g/deploy-pending
rejected=/mnt/disks/data/sim-g/deploy-rejected
watch=(env "${settings[@]}" SIM_G_PROJECT=synthetic-gateway-dev
  SIM_G_HEALTH_ATTEMPTS=2 SIM_G_HEALTH_INTERVAL=0 bash "${bin}/sim-g-deploy-watch.sh")
fresh() {
  write_settings
  rm -f "${state}" "${rejected}" /run/sim-g/migrate.lock /run/sim-g/maintenance \
    /tmp/stub-restart-failed
  printf '%s\n' "${gateway_image}" >/tmp/stub-container
}
fresh

run STUB_POINTER="${digest}" "${watch[@]}"
check "deploy: the running digest changes nothing" succeeded
check "deploy: the running digest pulls nothing" not_called "docker pull"
check "deploy: the token never reaches process arguments" not_called synthetic-token
check "deploy: the token is sent on stdin" \
  grep -qF 'header = "Authorization: Bearer synthetic-token"' "${log}.config"
check "deploy: the pointer is read from this project's deploy bucket" \
  called "synthetic-gateway-dev-sim-g-deploy/o/family-brain-gateway%2Fgateway.digest?alt=media"

for malformed in "latest" "sha256:abc" "${next_image}" "${next_digest} "; do
  run STUB_POINTER="${malformed}" "${watch[@]}"
  check "deploy: a malformed pointer (${malformed:0:24}...) is refused" reason deploy_pointer_malformed
  check "deploy: a malformed pointer pulls nothing" not_called "docker pull"
done

run STUB_POINTER_HTTP=404 "${watch[@]}"
check "deploy: no pointer yet is quiet" bash -c '[[ $0 -eq 0 && -z $1 ]]' "${status}" "${output}"
run STUB_POINTER_HTTP=403 "${watch[@]}"
check "deploy: a refused pointer read fails" reason deploy_pointer_http_403
run STUB_POINTER_FAIL=1 "${watch[@]}"
check "deploy: an unreachable pointer fails" reason deploy_pointer_unavailable
run STUB_POINTER="${next_digest}" STUB_TOKEN_FAIL=1 "${watch[@]}"
check "deploy: no token fails" reason deploy_token_unavailable

run STUB_POINTER="${next_digest}" STUB_POSTGRES_DOWN=1 "${watch[@]}"
check "deploy: waits quietly while PostgreSQL is down" \
  bash -c '[[ $0 -eq 0 && -z $1 ]]' "${status}" "${output}"
check "deploy: PostgreSQL down pulls nothing" not_called "docker pull"

run STUB_POINTER="${next_digest}" STUB_PULL_FAIL=1 "${watch[@]}"
check "deploy: a failed pull fails" reason deploy_pull_failed
check "deploy: a failed pull keeps the running image" test "$(current_image)" == "${gateway_image}"
check "deploy: a failed pull is retried later" test ! -e "${rejected}"

run STUB_POINTER="${next_digest}" "${watch[@]}"
check "deploy: a new digest is deployed" \
  bash -c '[[ $0 -eq 0 && $1 == *"\"msg\":\"deploy_completed\""* ]]' "${status}" "${output}"
check "deploy: only the same repository is pulled" called "docker pull ${next_image}"
check "deploy: the new image's migrations run" \
  bash -c 'grep -F "docker run" "$0" | grep -F migration-cli.js | grep -qF "$1"' "${log}" "${next_image}"
check "deploy: migrations run before the image is recorded and the gateway restarts" \
  bash -c 'grep -nE "migration-cli|restart sim-g-gateway" "$0" | head -1 | grep -qF migration-cli' "${log}"
check "deploy: the new image is recorded" test "$(current_image)" == "${next_image}"
check "deploy: the settings file stays root-only" \
  bash -c '[[ "$(stat -c "%u %a" "$0")" == "0 600" ]]' "${env_file}"
check "deploy: nothing is left pending" test ! -e "${state}"
fresh

old_image="${gateway_image%@*}@sha256:$(printf '%064d' 3)"
images="${old_image} ${gateway_image} ${next_image} ${postgres_image}"
run STUB_POINTER="${next_digest}" STUB_IMAGES="${images}" "${watch[@]}"
check "prune: an older gateway image is removed" called "docker image rm ${old_image}"
check "prune: the previous image is kept for rollback" not_called "docker image rm ${gateway_image}"
check "prune: the new image is kept" not_called "docker image rm ${next_image}"
check "prune: another repository's image is never removed" not_called "docker image rm ${postgres_image}"
check "prune: only this repository is listed" \
  called "docker image ls --digests --format {{.Repository}}@{{.Digest}} ${gateway_image%@*}"
check "prune: it reports what it removed" \
  bash -c '[[ $0 == *"\"msg\":\"deploy_pruned\",\"removed\":1,\"failed\":0"* ]]' "${output}"
check "prune: the deploy is complete before pruning starts" \
  bash -c '[[ $(grep -n deploy_completed <<<"$0" | cut -d: -f1) -lt $(grep -n deploy_pruned <<<"$0" | cut -d: -f1) ]]' "${output}"
fresh

run STUB_POINTER="${next_digest}" STUB_IMAGES="${images}" STUB_RM_FAIL=1 "${watch[@]}"
check "prune: a failed removal never fails the deploy" \
  bash -c '[[ $0 -eq 0 && $1 == *"\"msg\":\"deploy_completed\""* ]]' "${status}" "${output}"
check "prune: a failed removal is reported" \
  bash -c '[[ $0 == *"\"removed\":0,\"failed\":1"* ]]' "${output}"
fresh

run STUB_POINTER="${bad_digest}" STUB_BAD_DIGEST="${bad_digest}" STUB_IMAGES="${images}" "${watch[@]}"
check "prune: a rolled-back deploy removes nothing" not_called "docker image rm"
fresh

run STUB_POINTER="${bad_digest}" STUB_BAD_DIGEST="${bad_digest}" "${watch[@]}"
check "deploy: an unhealthy image is rolled back" reason deploy_rolled_back
check "deploy: the rollback restores the previous image" test "$(current_image)" == "${gateway_image}"
check "deploy: the rollback restarts the gateway twice" test "$(calls "restart sim-g-gateway")" -eq 2
check "deploy: the bad digest is remembered" grep -qxF "${bad_digest}" "${rejected}"
check "deploy: nothing is left pending after a rollback" test ! -e "${state}"

run STUB_POINTER="${bad_digest}" STUB_BAD_DIGEST="${bad_digest}" "${watch[@]}"
check "deploy: a rejected digest is not retried" succeeded
check "deploy: a rejected digest pulls nothing" not_called "docker pull"
fresh

run STUB_POINTER="${next_digest}" STUB_RESTART_FAIL=once "${watch[@]}"
check "deploy: a failed restart is rolled back, not left running" bash -c '[[ $0 -ne 0 ]]' "${status}"
check "deploy: a failed restart restores the previous image" test "$(current_image)" == "${gateway_image}"
check "deploy: a failed restart is reported as such" reason deploy_restart_failed
check "deploy: a failed restart is not the image's fault" test ! -e "${rejected}"
fresh

run STUB_POINTER="${next_digest}" STUB_RESTART_FAIL=always "${watch[@]}"
check "deploy: a rollback that cannot restart is reported" reason deploy_rollback_unhealthy
check "deploy: it still restores the previous image" test "$(current_image)" == "${gateway_image}"
fresh

# A sed failure must never empty the settings file.
printf '#!/usr/bin/env bash\n[[ "$*" == *SIM_G_GATEWAY_IMAGE=* ]] && exit 4\nexec /usr/bin/sed "$@"\n' \
  >"${stubs}/sed"
chmod +x "${stubs}/sed"
run STUB_POINTER="${next_digest}" "${watch[@]}"
rm -f "${stubs}/sed"
check "deploy: a failed settings rewrite fails" reason deploy_settings_write_failed
check "deploy: a failed settings rewrite keeps the file intact" test "$(current_image)" == "${gateway_image}"
check "deploy: a failed settings rewrite never restarts the gateway" not_called "restart sim-g-gateway"
fresh

run STUB_POINTER="${next_digest}" STUB_ALWAYS_UNHEALTHY=1 "${watch[@]}"
check "deploy: an unhealthy rollback is reported" reason deploy_rollback_unhealthy
check "deploy: an unhealthy rollback still restores the previous image" \
  test "$(current_image)" == "${gateway_image}"
fresh

run STUB_POINTER="${next_digest}" STUB_DOCKER_RUN_FAIL=1 "${watch[@]}"
check "deploy: a failed migration fails" reason deploy_migration_failed
check "deploy: a failed migration never records the image" test "$(current_image)" == "${gateway_image}"
check "deploy: a failed migration never restarts the gateway" not_called "restart sim-g-gateway"
check "deploy: a failed migration's digest is remembered" grep -qxF "${next_digest}" "${rejected}"
fresh

run STUB_POINTER="${next_digest}" STUB_DOCKER_RUN_FAIL=125 "${watch[@]}"
check "deploy: a docker daemon error defers it" reason deploy_migration_deferred
check "deploy: a docker daemon error rejects nothing" test ! -e "${rejected}"
fresh

run STUB_POINTER="${next_digest}" STUB_MAINTENANCE_DURING_MIGRATION=1 "${watch[@]}"
check "deploy: maintenance during migrations stops before the switch" succeeded
check "deploy: maintenance during migrations keeps the running image" test "$(current_image)" == "${gateway_image}"
check "deploy: maintenance during migrations rejects nothing" test ! -e "${rejected}"
fresh

run STUB_POINTER="${next_digest}" STUB_MAINTENANCE_DURING_MIGRATION=1 STUB_DOCKER_RUN_FAIL=1 "${watch[@]}"
check "deploy: a migration failing under maintenance rejects nothing" test ! -e "${rejected}"
fresh

run STUB_POINTER="${next_digest}" STUB_SYSTEMCTL_STATUS=1 "${watch[@]}"
check "deploy: a failed backup is retried later" reason deploy_migration_deferred
check "deploy: a failed backup rejects nothing" test ! -e "${rejected}"
check "deploy: a failed backup never records the image" test "$(current_image)" == "${gateway_image}"
fresh

mkdir -p /run/sim-g
exec 9>/run/sim-g/migrate.lock
flock 9
run STUB_POINTER="${next_digest}" "${watch[@]}"
check "deploy: a migration already running defers it" reason deploy_migration_deferred
check "deploy: a migration already running rejects nothing" test ! -e "${rejected}"
check "deploy: a migration already running runs no migration" not_called migration-cli
exec 9>&-
fresh

for marker in "${gateway_image} ${next_image} extra" "${gateway_image%@*}@sha256:&& ${next_image}" \
  "${gateway_image}"; do
  printf '%s\n' "${marker}" >"${state}"
  run STUB_POINTER="${next_digest}" "${watch[@]}"
  check "deploy: a malformed pending marker (${marker: -12}) fails closed" reason deploy_pending_malformed
  check "deploy: a malformed pending marker changes nothing" test "$(current_image)" == "${gateway_image}"
done
fresh

# A run that died before recording the new image: the deploy starts again.
printf '%s %s\n' "${gateway_image}" "${next_image}" >"${state}"
run STUB_POINTER="${next_digest}" "${watch[@]}"
check "deploy: an interrupted deploy that never switched starts again" \
  bash -c '[[ $0 -eq 0 && $1 == *"\"msg\":\"deploy_completed\""* ]]' "${status}" "${output}"
check "deploy: the restarted deploy migrates again" called migration-cli
fresh

# A run that died after recording the new image but before restarting: the
# old container is still running and healthy, which must not count.
printf '%s %s\n' "${gateway_image}" "${next_image}" >"${state}"
settings[0]="SIM_G_GATEWAY_IMAGE=${next_image}"
write_settings
watch=(env "${settings[@]}" SIM_G_PROJECT=synthetic-gateway-dev
  SIM_G_HEALTH_ATTEMPTS=2 SIM_G_HEALTH_INTERVAL=0 bash "${bin}/sim-g-deploy-watch.sh")
run STUB_POINTER="${next_digest}" "${watch[@]}"
check "deploy: an interrupted deploy restarts onto the recorded image" called "restart sim-g-gateway"
check "deploy: the interrupted deploy completes on the new container" \
  bash -c '[[ $0 -eq 0 && "$(cat /tmp/stub-container)" == "$1" ]]' "${status}" "${next_image}"
rm -f "${state}"
printf '%s\n' "${gateway_image}" >/tmp/stub-container

# A run that died after recording the new image: the next run checks it.
printf '%s %s\n' "${gateway_image}" "${next_image}" >"${state}"
settings[0]="SIM_G_GATEWAY_IMAGE=${next_image}"
write_settings
watch=(env "${settings[@]}" SIM_G_PROJECT=synthetic-gateway-dev
  SIM_G_HEALTH_ATTEMPTS=2 SIM_G_HEALTH_INTERVAL=0 bash "${bin}/sim-g-deploy-watch.sh")
run STUB_POINTER="${next_digest}" STUB_BAD_DIGEST="${next_digest}" "${watch[@]}"
check "deploy: an interrupted deploy that is unhealthy is rolled back" reason deploy_rolled_back
check "deploy: the interrupted deploy restores the previous image" test "$(current_image)" == "${gateway_image}"
check "deploy: the interrupted deploy's digest is remembered" grep -qxF "${next_digest}" "${rejected}"

rm -f "${rejected}"
printf '%s %s\n' "${gateway_image}" "${next_image}" >"${state}"
write_settings
run STUB_POINTER="${next_digest}" STUB_IMAGES="${old_image} ${gateway_image} ${next_image}" "${watch[@]}"
check "prune: a recovered deploy keeps the marker's previous image" \
  not_called "docker image rm ${gateway_image}"
check "prune: a recovered deploy removes older images" called "docker image rm ${old_image}"
check "deploy: an interrupted deploy that is healthy is completed" \
  bash -c '[[ $0 -eq 0 && $1 == *"\"msg\":\"deploy_completed\""* ]]' "${status}" "${output}"
check "deploy: the completed interrupted deploy keeps the new image" test "$(current_image)" == "${next_image}"
check "deploy: the completed interrupted deploy leaves nothing pending" test ! -e "${state}"
settings[0]="SIM_G_GATEWAY_IMAGE=${gateway_image}"
watch=(env "${settings[@]}" SIM_G_PROJECT=synthetic-gateway-dev
  SIM_G_HEALTH_ATTEMPTS=2 SIM_G_HEALTH_INTERVAL=0 bash "${bin}/sim-g-deploy-watch.sh")
fresh

touch /run/sim-g/maintenance
run STUB_POINTER="${next_digest}" "${watch[@]}"
check "deploy: does nothing during maintenance" not_called curl
rm -f /run/sim-g/maintenance

run STUB_POINTER="${next_digest}" SIM_G_STORAGE_BASE=https://attacker.example/b "${watch[@]}"
check "deploy: a non-loopback storage override is refused" reason deploy_endpoint_refused
check "deploy: a refused endpoint never gets a token" not_called "token"
run STUB_POINTER="${next_digest}" SIM_G_METADATA_TOKEN_URL=http://attacker.example/token "${watch[@]}"
check "deploy: a non-loopback token override is refused" reason deploy_endpoint_refused
run STUB_POINTER="${digest}" SIM_G_STORAGE_BASE=http://127.0.0.1:18080/b \
  SIM_G_METADATA_TOKEN_URL=http://127.0.0.1:18081/computeMetadata/v1/instance/service-accounts/default/token "${watch[@]}"
check "deploy: loopback overrides are accepted" succeeded

run bash "${bin}/sim-g-recover.sh"
check "recover: restarts failed workloads" \
  called "systemctl start --no-block sim-g-postgres.service sim-g-gateway.service sim-g-edge.service sim-g-certificate.timer sim-g-backup.timer sim-g-backup-recent.timer sim-g-backup-stale.timer sim-g-log-ship.timer"
mkdir -p /run/sim-g
touch /run/sim-g/maintenance
run bash "${bin}/sim-g-recover.sh"
check "recover: does nothing during maintenance" not_called "systemctl start"
rm -f /run/sim-g/maintenance

# --- host log shipping: a real journal, real journalctl and curl -----------
# Journal files are built from journald's export format; the metadata server
# and Cloud Logging are one loopback server that records each request.
ship="$(mktemp -d)"
python3 - "${ship}" <<'EOF' &
import http.server, os, sys
root = sys.argv[1]
metadata = {
    '/computeMetadata/v1/project/project-id': 'synthetic-gateway-dev',
    '/computeMetadata/v1/instance/id': '4815162342',
    '/computeMetadata/v1/instance/zone': 'projects/123456/zones/us-central1-a',
    '/computeMetadata/v1/instance/service-accounts/default/token':
        '{"access_token":"synthetic-token","expires_in":3599,"token_type":"Bearer"}',
}
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def do_GET(self):
        if (os.path.exists(f'{root}/metadata-down') or self.path not in metadata
                or self.headers.get('Metadata-Flavor') != 'Google'):
            self.send_response(503)
            self.end_headers()
            return
        self.send_response(200)
        self.end_headers()
        self.wfile.write(metadata[self.path].encode())
    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        count = len([name for name in os.listdir(root) if name.endswith('.request')])
        with open(f'{root}/{count:03d}.request', 'wb') as target:
            target.write(body)
        with open(f'{root}/{count:03d}.auth', 'w') as target:
            target.write(f"{self.path} {self.headers.get('Authorization', '')} {self.headers.get('Content-Type', '')}")
        code = 200
        if os.path.exists(f'{root}/status'):
            code = int(open(f'{root}/status').read())
        self.send_response(code)
        self.end_headers()
server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
with open(f'{root}/port.tmp', 'w') as port:
    port.write(str(server.server_port))
os.rename(f'{root}/port.tmp', f'{root}/port')
server.serve_forever()
EOF
ship_server=$!
for _ in $(seq 1 50); do [[ -e "${ship}/port" ]] && break; sleep 0.1; done
ship_url="http://127.0.0.1:$(cat "${ship}/port")"
boot=0123456789abcdef0123456789abcdef
now="$(date -u +%s)"
# One export entry: unit priority seconds-ago micros message.
entry() {
  local when=$(((now - $3) * 1000000 + $4))
  printf '__REALTIME_TIMESTAMP=%s\n__MONOTONIC_TIMESTAMP=%s\n_BOOT_ID=%s\n_SYSTEMD_UNIT=%s\nPRIORITY=%s\nSYSLOG_IDENTIFIER=bash\n_PID=42\n_HOSTNAME=family-brain-gateway\nMESSAGE=%s\n\n' \
    "${when}" "${when}" "${boot}" "$1" "$2" "$5"
}
journal() { # name < export entries
  local name="${1:?}"
  rm -f "${ship:?}/${name}.journal"
  /lib/systemd/systemd-journal-remote --output="${ship}/${name}.journal" - >/dev/null 2>&1
}
clear_requests() { find "${ship:?}" -maxdepth 1 \( -name '*.request' -o -name '*.auth' -o -name position \) -delete; }
{
  entry sim-g-backup-recent.service 6 300 111111 '{"severity":"INFO","msg":"backup_completed","tier":"recent","object":"family-brain-gateway/2026/10/29/20261029T181500Z.dump.age","bytes":41745}'
  entry sim-g-backup-stale.service 6 290 222222 '{"severity":"ERROR","msg":"backup_stale","reason":"backup_too_old","age_seconds":2218}'
  entry sim-g-backup-stale.service 6 280 0 'Starting sim-g-backup-stale.service...'
  entry sim-g-gateway.service 6 270 0 'Error response from daemon: No such container: sim-g-gateway'
  entry sim-g-log-ship.service 3 260 0 '{"severity":"ERROR","msg":"log_ship_failed","reason":"log_ship_http_503"}'
  entry docker.service 6 250 0 '{"severity":"INFO","msg":"not_a_sim_g_unit"}'
  entry sim-g-edge.service 6 240 0 '{"severity":"INFO","msg":"nested","detail":{"a":1}}'
  entry sim-g-edge.service 6 230 0 '{"severity":"INFO","msg":"quoted","reason":"a\"b"}'
  entry sim-g-edge.service 6 220 0 '{"msg":"no_severity","severity":"INFO"}'
  entry sim-g-data-disk.service 6 210 333333 '{"severity":"INFO","msg":"data_disk_ready","formatted":true}'
  entry sim-g-backup-recent.service 6 7200 0 '{"severity":"INFO","msg":"before_this_boot"}'
} | journal first
echo 600.00 600.00 >"${ship}/uptime"
log_ship=(env "SIM_G_JOURNAL_FILE=${ship}/first.journal" "SIM_G_LOG_SHIP_STATE=${ship}/position"
  "SIM_G_METADATA_URL=${ship_url}/computeMetadata/v1" "SIM_G_LOGGING_URL=${ship_url}/v2/entries:write"
  "SIM_G_UPTIME_FILE=${ship}/uptime" "PATH=${real_path}" bash "${bin}/sim-g-log-ship.sh")
requests() { find "${ship}" -maxdepth 1 -name '*.request' | wc -l | tr -d ' '; }
# The shipped request, checked as Cloud Logging would read it.
shipped() { # request-number python-condition
  python3 - "${ship}/$(printf %03d "$1").request" "$2" <<'EOF'
import json, re, sys
body = json.load(open(sys.argv[1]))
entries = body['entries']
msgs = [entry['jsonPayload']['msg'] for entry in entries]
# The condition is a fixed expression written in this file, never request data.
sys.exit(0 if eval(sys.argv[2]) else 1)
EOF
}
first_position="$(((now - 210) * 1000000 + 333333))"

run "${log_ship[@]}"
check "log ship: ships and succeeds quietly" bash -c '[[ $0 -eq 0 && -z "$1" ]]' "${status}" "${output}"
check "log ship: one request" test "$(requests)" -eq 1
check "log ship: only sim-g services' info lines in the host scripts' shape, since boot (even after a clock step)" \
  shipped 0 "msgs == ['backup_completed', 'backup_stale', 'data_disk_ready']"
check "log ship: each line is the jsonPayload unchanged" \
  shipped 0 "entries[0]['jsonPayload'] == {'severity': 'INFO', 'msg': 'backup_completed', 'tier': 'recent', 'object': 'family-brain-gateway/2026/10/29/20261029T181500Z.dump.age', 'bytes': 41745} and entries[2]['jsonPayload']['formatted'] is True"
check "log ship: each keeps its own severity" \
  shipped 0 "[entry['severity'] for entry in entries] == ['INFO', 'ERROR', 'INFO']"
check "log ship: the journal's time, to the microsecond" \
  shipped 0 "all(re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z', entry['timestamp']) for entry in entries) and entries[0]['timestamp'].endswith('.111111Z')"
check "log ship: a 32-hex insertId per line" \
  shipped 0 "len({entry['insertId'] for entry in entries}) == 3 and all(re.fullmatch('[0-9a-f]{32}', entry['insertId']) for entry in entries)"
check "log ship: as this instance, in the sim-g-host log" \
  shipped 0 "body['logName'] == 'projects/synthetic-gateway-dev/logs/sim-g-host' and body['resource'] == {'type': 'gce_instance', 'labels': {'project_id': 'synthetic-gateway-dev', 'instance_id': '4815162342', 'zone': 'us-central1-a'}}"
check "log ship: the token goes only in the Authorization header" \
  grep -qx '/v2/entries:write Bearer synthetic-token application/json' "${ship}/000.auth"
check "log ship: the position is the last line's time, root-only" \
  bash -c '[[ "$(cat "$0")" == "$1" && "$(stat -c %a "$0")" == 600 ]]' "${ship}/position" "${first_position}"

run "${log_ship[@]}"
check "log ship: nothing new, nothing sent" test "$(requests)" -eq 1

{
  entry sim-g-backup-recent.service 6 300 111111 '{"severity":"INFO","msg":"backup_completed","tier":"recent","object":"family-brain-gateway/2026/10/29/20261029T181500Z.dump.age","bytes":41745}'
  entry sim-g-backup-recent.service 6 60 0 '{"severity":"INFO","msg":"backup_completed","tier":"recent","object":"family-brain-gateway/2026/10/29/20261029T183000Z.dump.age","bytes":41745}'
} | journal second
log_ship[1]="SIM_G_JOURNAL_FILE=${ship}/second.journal"
echo 503 >"${ship}/status"
run "${log_ship[@]}"
check "log ship: a refused request fails at priority err" \
  bash -c '[[ $0 -eq 1 && "$1" == "<3>{\"severity\":\"ERROR\",\"msg\":\"log_ship_failed\",\"reason\":\"log_ship_http_503\"}" ]]' "${status}" "${output}"
check "log ship: a refused request keeps the position" \
  bash -c '[[ "$(cat "$0")" == "$1" ]]' "${ship}/position" "${first_position}"
rm -f "${ship:?}/status"
run "${log_ship[@]}"
check "log ship: the outage is caught up, only after the position" bash -c '[[ $0 -eq 0 ]]' "${status}"
check "log ship: the resent line keeps its insertId" \
  python3 -c 'import json, sys; a, b = (json.load(open(f))["entries"] for f in sys.argv[1:]); sys.exit(0 if len(a) == len(b) == 1 and a[0]["insertId"] == b[0]["insertId"] else 1)' \
  "${ship}/001.request" "${ship}/002.request"

for i in $(seq 1 250); do
  entry sim-g-backup-recent.service 6 50 "${i}" "{\"severity\":\"INFO\",\"msg\":\"backup_completed\",\"tier\":\"recent\",\"bytes\":${i}}"
done | journal many
clear_requests
log_ship[1]="SIM_G_JOURNAL_FILE=${ship}/many.journal"
run "${log_ship[@]}"
check "log ship: a backlog goes in batches of 100, two a run" \
  bash -c '[[ $0 -eq 0 ]] && python3 -c "import json, sys; n = [len(json.load(open(f))[\"entries\"]) for f in sorted(sys.argv[1:])]; sys.exit(0 if n == [100, 100] else 1)" "$1"/*.request' \
  "${status}" "${ship}"
run "${log_ship[@]}"
check "log ship: the next run sends the rest; every line once" \
  bash -c '[[ $0 -eq 0 ]] && python3 -c "import json, sys; b = [e[\"jsonPayload\"][\"bytes\"] for f in sorted(sys.argv[1:]) for e in json.load(open(f))[\"entries\"]]; sys.exit(0 if b == list(range(1, 251)) else 1)" "$1"/*.request' \
  "${status}" "${ship}"

# Lines 100 and 101 share a microsecond, across a batch boundary.
{
  for i in $(seq 1 100); do
    entry sim-g-backup-recent.service 6 40 "${i}" "{\"severity\":\"INFO\",\"msg\":\"backup_completed\",\"bytes\":${i}}"
  done
  entry sim-g-backup-stale.service 6 40 100 '{"severity":"INFO","msg":"backup_recent_fresh","age_seconds":101}'
} | journal tie
clear_requests
log_ship[1]="SIM_G_JOURNAL_FILE=${ship}/tie.journal"
run "${log_ship[@]}"
check "log ship: a line sharing the batch boundary's microsecond still ships" \
  bash -c '[[ $0 -eq 0 ]] && python3 -c "import json, sys; n = sum(len(json.load(open(f))[\"entries\"]) for f in sys.argv[1:]); sys.exit(0 if n == 101 else 1)" "$1"/*.request' \
  "${status}" "${ship}"

# Lines 200 and 201 share a microsecond at the two-batch cut.
{
  for i in $(seq 1 200); do
    entry sim-g-backup-recent.service 6 35 "${i}" "{\"severity\":\"INFO\",\"msg\":\"backup_completed\",\"bytes\":${i}}"
  done
  entry sim-g-backup-stale.service 6 35 200 '{"severity":"INFO","msg":"backup_recent_fresh","age_seconds":201}'
  entry sim-g-backup-stale.service 6 35 300 '{"severity":"INFO","msg":"backup_recent_fresh","age_seconds":202}'
} | journal cut
clear_requests
log_ship[1]="SIM_G_JOURNAL_FILE=${ship}/cut.journal"
run "${log_ship[@]}"
run "${log_ship[@]}"
check "log ship: a line sharing the cut's microsecond ships, then the rest, each once" \
  bash -c '[[ $0 -eq 0 ]] && python3 -c "import json, sys; m = [e[\"jsonPayload\"].get(\"bytes\", e[\"jsonPayload\"].get(\"age_seconds\")) for f in sorted(sys.argv[1:]) for e in json.load(open(f))[\"entries\"]]; sys.exit(0 if m == list(range(1, 201)) + [201, 202] else 1)" "$1"/*.request' \
  "${status}" "${ship}"

# Nothing to ship: an empty result is not a journal failure.
entry sim-g-backup-stale.service 6 30 0 'Starting sim-g-backup-stale.service...' | journal quiet
clear_requests
log_ship[1]="SIM_G_JOURNAL_FILE=${ship}/quiet.journal"
run "${log_ship[@]}"
check "log ship: no host line, no request and no output" \
  bash -c '[[ $0 -eq 0 && -z "$1" && "$2" -eq 0 ]]' "${status}" "${output}" "$(requests)"

log_ship[1]="SIM_G_JOURNAL_FILE=${ship}/second.journal"
clear_requests
run "${log_ship[@]/SIM_G_LOGGING_URL=*/SIM_G_LOGGING_URL=http://127.0.0.1:1/v2/entries:write}"
check "log ship: Cloud Logging unreachable fails at priority err, as status 000" \
  bash -c '[[ $0 -eq 1 && "$1" == "<3>{\"severity\":\"ERROR\",\"msg\":\"log_ship_failed\",\"reason\":\"log_ship_http_000\"}" ]]' "${status}" "${output}"
check "log ship: unreachable keeps no position" test ! -e "${ship}/position"
echo "$(((now + 3600) * 1000000))" >"${ship}/position"
run "${log_ship[@]}"
check "log ship: a position an hour ahead of the clock fails" reason log_ship_position_invalid
check "log ship: a position ahead of the clock sends nothing" test "$(requests)" -eq 0

clear_requests
run "${log_ship[@]/SIM_G_LOGGING_URL=*/SIM_G_LOGGING_URL=https://example.invalid/v2/entries:write}"
check "log ship: another endpoint is refused" reason log_ship_endpoint_refused
check "log ship: a refused endpoint gets nothing" test "$(requests)" -eq 0
touch "${ship}/metadata-down"
run "${log_ship[@]}"
check "log ship: no metadata, no shipping" reason log_ship_metadata_unavailable
rm -f "${ship:?}/metadata-down"
echo 0123 >"${ship}/position"
run "${log_ship[@]}"
check "log ship: a malformed position fails" reason log_ship_position_invalid
check "log ship: a malformed position sends nothing" test "$(requests)" -eq 0
kill "${ship_server}"

# The shape check accepts every JSON line the host scripts printed in the
# cases above, and refuses anything else.
# (Sourced with another $0, so the script defines its functions only.)
check "log ship: every host script line is in the shipped shape" bash -c '
  source "$1"
  grep "^{\"severity\"" "$2" | sort -u >"$2.events"
  [[ "$(wc -l <"$2.events")" -ge 50 ]] || { echo "too few lines: $(wc -l <"$2.events")" >&2; exit 1; }
  while IFS= read -r line; do host_event "${line}" || { echo "not shipped: ${line}" >&2; exit 1; }; done <"$2.events"' \
  shape-check "${bin}/sim-g-log-ship.sh" "${printed}"
check "log ship: the shape check accepts a shipped line" \
  bash -c 'source "$1" && host_event "$2"' shape-check "${bin}/sim-g-log-ship.sh" '{"severity":"INFO","msg":"backup_completed","tier":"recent","bytes":1}'
for line in 'plain text' '{"severity":"INFO","msg":"a","n":{"x":1}}' '{"severity":"INFO","msg":"a","s":"q\"q"}' \
  "$(printf '{"severity":"INFO","msg":"a","s":"tab\there"}')" '{"severity":"INFO","msg":"A"}' '{"severity":"LOUD","msg":"a"}' \
  '{"msg":"a","severity":"INFO"}' '{"severity":"INFO","msg":"a"} trailing' '{"severity":"INFO","msg":"a","n":007}'; do
  check "log ship: not shipped: ${line}" fails bash -c 'source "$1" && host_event "$2"' shape-check "${bin}/sim-g-log-ship.sh" "${line}"
done

if [[ "${failures}" -ne 0 ]]; then
  echo "${failures} host case(s) failed" >&2
  exit 1
fi
echo "all host cases passed"
