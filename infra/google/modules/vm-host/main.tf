locals {
  repository = "${path.module}/../../../.."
  units      = sort(tolist(fileset("${local.repository}/deploy/vm/host/systemd", "*")))
  scripts    = sort(tolist(fileset("${local.repository}/deploy/vm/host/bin", "*.sh")))
  edge       = sort(tolist(fileset("${local.repository}/deploy/vm/edge", "*.conf")))

  # COS keeps /etc on tmpfs, so cloud-init rewrites these on every boot and
  # the repository stays the only source of the host layer.
  write_files = concat(
    [for name in local.units : {
      path        = "/etc/systemd/system/${name}"
      owner       = "root:root"
      permissions = "0644"
      content     = file("${local.repository}/deploy/vm/host/systemd/${name}")
    }],
    [for name in local.scripts : {
      path        = "/etc/sim-g/bin/${name}"
      owner       = "root:root"
      permissions = "0755"
      content     = file("${local.repository}/deploy/vm/host/bin/${name}")
    }],
    # The nginx templates; sim-g-edge.sh renders them at start.
    [for name in local.edge : {
      path        = "/etc/sim-g/edge/${name}"
      owner       = "root:root"
      permissions = "0644"
      content     = file("${local.repository}/deploy/vm/edge/${name}")
    }],
    [{
      path        = "/etc/sim-g/bin/sim-g-backup.sh"
      owner       = "root:root"
      permissions = "0755"
      content     = file("${local.repository}/deploy/vm/backup/sim-g-backup.sh")
    }],
  )

  user_data = "#cloud-config\n${yamlencode({
    write_files = local.write_files
    runcmd = [
      ["systemctl", "daemon-reload"],
      ["systemctl", "start", "--no-block", "sim-g.target"],
    ]
  })}"
}
