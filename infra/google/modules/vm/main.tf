locals {
  name = "family-brain-gateway"
  # Every resource takes its project from the guarded data source, so even a
  # targeted plan evaluates the environment-label postcondition first.
  project = data.google_project.this.project_id

  # Production is persistent and protected. Development is a temporary
  # environment (cost model): an ephemeral IPv4, and resources Terraform may
  # destroy. Backup buckets empty only through retention and lifecycle first
  # (infra/google/README.md).
  production = var.environment == "production"
  protection = local.production ? "PREVENT" : "DELETE"
  # The GitHub environment whose jobs may deploy here, derived and never an
  # input, so a production root can never accept the development workflow.
  github_environment = local.production ? "production" : "development"
  labels = {
    application = "family-brain-gateway"
    environment = var.environment
    managed_by  = "terraform"
  }

  # The budget's API only when the owner supplies a billing account.
  services = setunion(var.billing_account_id == null ? [] : ["billingbudgets.googleapis.com"], [
    "artifactregistry.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "compute.googleapis.com",
    "drive.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "iap.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "secretmanager.googleapis.com",
    "serviceusage.googleapis.com",
    "storage.googleapis.com",
    "sts.googleapis.com",
  ])
}

# Enabling an API is free; it stays enabled if this module is ever destroyed.
resource "google_project_service" "required" {
  for_each = local.services

  project            = local.project
  service            = each.value
  disable_on_destroy = false
}

# The owner labels each project family_brain_environment=<environment>, so a
# root pointed at the other environment's project fails before any change.
# This catches mistakes; it is not the dev/prod boundary. That is IAM: dev
# identities hold nothing in the prod project or its state bucket.
data "google_project" "this" {
  project_id = var.project_id

  lifecycle {
    postcondition {
      condition     = lookup(self.labels, "family_brain_environment", "") == var.environment
      error_message = "The project must be labelled family_brain_environment=${var.environment}."
    }
  }
}
