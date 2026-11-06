output "project_number" {
  description = "For the configuration document's secrets.projectNumber."
  value       = data.google_project.this.number
}

output "ingress_address" {
  description = "The public IPv4: static in production (the DNS A record), ephemeral in development."
  value       = local.production ? google_compute_address.ingress[0].address : google_compute_instance.gateway.network_interface[0].access_config[0].nat_ip
}

output "runtime_service_account" {
  value = google_service_account.runtime.email
}

output "backup_bucket" {
  value = google_storage_bucket.backups.name
}

output "recent_backup_bucket" {
  value = google_storage_bucket.recent_backups.name
}

output "deploy_bucket" {
  value = google_storage_bucket.deploy.name
}

output "audit_log_bucket" {
  value = google_logging_project_bucket_config.audit.id
}

output "artifact_repository" {
  description = "Where the deploy workflow pushes images: <region>-docker.pkg.dev/<project>/sim-g."
  value       = "${google_artifact_registry_repository.images.location}-docker.pkg.dev/${local.project}/${google_artifact_registry_repository.images.repository_id}"
}

output "deployer_service_account" {
  description = "For the GitHub environment variable GCP_DEPLOYER_SERVICE_ACCOUNT."
  value       = google_service_account.deployer.email
}

output "workload_identity_provider" {
  description = "For the GitHub environment variable GCP_WORKLOAD_IDENTITY_PROVIDER."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "drive_service_account" {
  description = "Share only the registered Drive roots with this identity (providers.drive.machineIdentity.id)."
  value       = google_service_account.drive.email
}

output "secret_ids" {
  description = "Empty secret containers; their values are added out of band."
  value       = sort([for secret in google_secret_manager_secret.gateway : secret.secret_id])
}
