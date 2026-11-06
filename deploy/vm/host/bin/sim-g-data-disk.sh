#!/usr/bin/env bash
# Mounts the persistent data disk (VM design section 1). It formats the disk
# only when two independent checks agree that it is new:
#   - the low-level probe finds no signature (blkid -p exit 2); and
#   - the disk reads back as zeros, as a new persistent disk does: the first
#     and last 16 MiB, and the first 64 KiB of every 8 MiB, which covers the
#     start of every ext4 block group (backup superblocks included) for 1, 2
#     and 4 KiB blocks.
# blkid also exits 2 when it cannot read the disk, when a damaged superblock
# fails its checksum, and when only the head was wiped. Such a disk still
# holds data, so the zero check refuses it, and so does any read error. An
# existing filesystem must be ext4 with the SIM-G label. Prints one JSON line.
set -euo pipefail

device=/dev/disk/by-id/google-sim-g-data
mount_point=/mnt/disks/data
label=sim-g-data
edge=$((16 << 20))
stride=$((8 << 20))
sample=$((64 << 10))

fail() {
  printf '{"severity":"ERROR","msg":"data_disk_failed","reason":"%s"}\n' "$1"
  exit 1
}

# Succeeds only when $3 bytes at byte offset $2 of $1 read back as zeros; a
# short read or a read error fails.
zeros_at() (
  set -o pipefail
  dd if="$1" bs=64K skip="$2" count="$3" iflag=skip_bytes,count_bytes,fullblock status=none |
    cmp -s -n "$3" - /dev/zero
)

blank_disk() { # device-or-image
  local size
  if [[ -b "$1" ]]; then
    size="$(blockdev --getsize64 "$1")" || return 1
  else
    size="$(stat -c %s "$1" 2>/dev/null)" || return 1
  fi
  [[ "${size}" =~ ^[0-9]+$ ]] && ((size >= 2 * edge)) || return 1
  zeros_at "$1" 0 "${edge}" && zeros_at "$1" $((size - edge)) "${edge}" || return 1
  local offset
  for ((offset = edge; offset < size - edge; offset += stride)); do
    zeros_at "$1" "${offset}" "${sample}" || return 1
  done
  return 0
}

prepare() {
  install -d -m 0700 -o 70 -g 70 "${mount_point}/postgres"
  install -d -m 0755 -o 0 -g 0 "${mount_point}/sim-g" "${mount_point}/sim-g/config"
  install -d -m 0700 -o 0 -g 0 "${mount_point}/backup-staging"
}

main() {
  mkdir -p "${mount_point}"
  if mountpoint -q "${mount_point}"; then
    # Only this disk may be mounted there; anything else is never prepared.
    [[ "$(readlink -f "$(findmnt -rno SOURCE --mountpoint "${mount_point}")")" == \
      "$(readlink -f "${device}")" ]] || fail data_disk_unexpected_mount
    prepare
    printf '{"severity":"INFO","msg":"data_disk_ready","formatted":false}\n'
    return
  fi
  [[ -b "${device}" ]] || fail data_disk_missing

  local probe status formatted=false
  set +e
  probe="$(blkid -p -o export "${device}")"
  status=$?
  set -e
  case "${status}" in
    2)
      blank_disk "${device}" || fail data_disk_not_blank
      # No terminal: mkfs never prompts, so the checks above are the guard.
      mkfs.ext4 -q -L "${label}" -m 0 -E lazy_itable_init=0,lazy_journal_init=0 \
        "${device}" </dev/null || fail data_disk_format_failed
      formatted=true
      ;;
    0)
      [[ "$(sed -n 's/^TYPE=//p' <<<"${probe}")" == ext4 ]] || fail data_disk_unexpected_filesystem
      [[ "$(sed -n 's/^LABEL=//p' <<<"${probe}")" == "${label}" ]] || fail data_disk_unexpected_label
      ;;
    *) fail data_disk_probe_failed ;;
  esac

  # The verified device itself, not whichever disk carries the label.
  mount -o nodev,nosuid,noexec "${device}" "${mount_point}" || fail data_disk_mount_failed
  prepare
  printf '{"severity":"INFO","msg":"data_disk_ready","formatted":%s}\n' "${formatted}"
}

# Sourcing defines the functions only (the offline check tests blank_disk).
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main
fi
