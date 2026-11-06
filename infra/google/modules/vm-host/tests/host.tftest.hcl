# Renders the cloud-config offline; no provider is involved.

run "renders_the_host_layer" {
  command = plan

  assert {
    condition     = startswith(output.user_data, "#cloud-config\n")
    error_message = "cloud-init needs the #cloud-config header."
  }
  assert {
    condition = alltrue([
      for path in [
        "/etc/systemd/system/sim-g.target",
        "/etc/systemd/system/sim-g-firewall.service",
        "/etc/systemd/system/sim-g-postgres.service",
        "/etc/systemd/system/sim-g-gateway.service",
        "/etc/systemd/system/sim-g-backup.timer",
        "/etc/sim-g/bin/sim-g-data-disk.sh",
        "/etc/sim-g/bin/sim-g-backup.sh",
        "/etc/systemd/system/sim-g-edge.service",
        "/etc/systemd/system/sim-g-certificate.timer",
        "/etc/sim-g/bin/sim-g-edge.sh",
        "/etc/sim-g/bin/sim-g-certificate.sh",
        "/etc/sim-g/edge/nginx.conf",
        "/etc/sim-g/edge/site.conf",
      ] : contains([for entry in local.write_files : entry.path], path)
    ])
    error_message = "Every unit and script is written."
  }
  assert {
    condition     = length(output.user_data) < 256 * 1024
    error_message = "A metadata value is limited to 256 KiB."
  }
  assert {
    condition     = strcontains(output.user_data, "sim-g.target")
    error_message = "cloud-init starts the target."
  }
}
