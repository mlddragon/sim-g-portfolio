output "user_data" {
  description = "The VM's cloud-config. Every instance process can read it, so it holds no secrets."
  value       = local.user_data
}
