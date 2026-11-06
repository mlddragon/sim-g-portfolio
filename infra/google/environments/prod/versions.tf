terraform {
  required_version = ">= 1.17.0, < 2.0.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "8.6.0"
    }
  }

  # State lives in an owner-created, versioned bucket in this environment's
  # project, supplied only at init: terraform init -backend-config=bucket=<name>.
  backend "gcs" {}
}

provider "google" {
  project = var.project_id
  region  = var.region
  # Quota and billing for user credentials (the operator applies) go to this
  # project; the Budgets API needs it.
  user_project_override = true
  billing_project       = var.project_id
}
