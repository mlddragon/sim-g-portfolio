# Provider-free: it only renders files from the repository, so it can be
# evaluated offline (scripts/check-vm-host.sh) exactly as the VM receives it.
terraform {
  required_version = ">= 1.17.0, < 2.0.0"
}
