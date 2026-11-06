locals {
  # Empty containers only. Their values are added out of band as secret
  # versions and never pass through Terraform or its state. The gateway's
  # configuration document is a file on the data disk holding only
  # references (vm-host runbook), so it is not a secret here.
  secrets = {
    "database-url"   = { purpose = "database_connection", provider = "postgresql" }
    "notion-token"   = { purpose = "provider_credential", provider = "notion" }
    "github-app-key" = { purpose = "provider_credential", provider = "github" }
  }
}

resource "google_secret_manager_secret" "gateway" {
  for_each = local.secrets

  project   = local.project
  secret_id = "family-brain-${each.key}"
  labels = merge(local.labels, {
    purpose  = each.value.purpose
    provider = each.value.provider
  })

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.required]
}

# Per-secret access: one binding never widens to another secret.
resource "google_secret_manager_secret_iam_member" "runtime" {
  for_each = google_secret_manager_secret.gateway

  project   = local.project
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}
