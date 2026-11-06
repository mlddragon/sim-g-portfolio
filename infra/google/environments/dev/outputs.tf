output "gateway" {
  description = "Names and addresses to record (no credentials)."
  value = {
    project_number             = module.gateway.project_number
    ingress_address            = module.gateway.ingress_address
    runtime_service_account    = module.gateway.runtime_service_account
    backup_bucket              = module.gateway.backup_bucket
    recent_backup_bucket       = module.gateway.recent_backup_bucket
    deploy_bucket              = module.gateway.deploy_bucket
    audit_log_bucket           = module.gateway.audit_log_bucket
    artifact_repository        = module.gateway.artifact_repository
    deployer_service_account   = module.gateway.deployer_service_account
    workload_identity_provider = module.gateway.workload_identity_provider
    drive_service_account      = module.gateway.drive_service_account
    secret_ids                 = module.gateway.secret_ids
  }
}
