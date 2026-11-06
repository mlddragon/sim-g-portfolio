module "gateway" {
  source = "../../modules/vm"

  project_id           = var.project_id
  region               = var.region
  zone                 = var.zone
  environment          = "development"
  boot_image           = var.boot_image
  audit_retention_days = var.audit_retention_days
  domain               = var.domain
  operator_email       = var.operator_email
  alert_email          = var.alert_email
  github_repository    = var.github_repository
  github_repository_id = var.github_repository_id
  billing_account_id   = var.billing_account_id
}
