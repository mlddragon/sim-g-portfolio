# Machine identities and their grants (VM design section 5). No identity
# has a key. Every grant is an additive member on one resource, except the
# one project-level role the owner approved: logging.logWriter.

resource "google_service_account" "drive" {
  project      = local.project
  account_id   = "fbg-drive"
  display_name = "Family Brain Gateway Drive identity (${var.environment})"
  description  = "No Google Cloud roles; shared only with the registered Drive roots and impersonated by the runtime."

  depends_on = [google_project_service.required]
}

resource "google_service_account" "deployer" {
  project      = local.project
  account_id   = "fbg-deployer"
  display_name = "Family Brain Gateway deployer (${var.environment})"
  description  = "Federated from the deploy workflow only: pushes images and writes the deploy pointer."

  depends_on = [google_project_service.required]
}

# The runtime mints short-lived Drive tokens and nothing else.
resource "google_service_account_iam_member" "runtime_impersonates_drive" {
  service_account_id = google_service_account.drive.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.runtime.email}"
}

# The approved exception (owner decision 2026-10-27): Google grants
# logging.logWriter only at project level. It is write-only, for the VM's
# logging agent.
resource "google_project_iam_member" "runtime_writes_logs" {
  project = local.project
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

# Backups: create only. The runtime cannot read, list, overwrite or delete
# them (recovery point investigation, section 8, item 5).
resource "google_storage_bucket_iam_member" "runtime_creates_backups" {
  for_each = {
    daily  = google_storage_bucket.backups.name
    recent = google_storage_bucket.recent_backups.name
  }

  bucket = each.value
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.runtime.email}"
}

# The deploy pointer: the VM reads it; the deployer writes it.
resource "google_storage_bucket_iam_member" "runtime_reads_pointer" {
  bucket = google_storage_bucket.deploy.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_storage_bucket_iam_member" "deployer_writes_pointer" {
  bucket = google_storage_bucket.deploy.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.deployer.email}"
}

# The one human operator (owner decision: Operator): OS Login as an
# administrator (two-step verification is required by the instance
# metadata), SSH only through IAP, and acting as the runtime, which OS Login
# requires on an instance with a service account. Instance-level, never
# project-level.
resource "google_compute_instance_iam_member" "operator_logs_in" {
  project       = local.project
  zone          = var.zone
  instance_name = google_compute_instance.gateway.name
  role          = "roles/compute.osAdminLogin"
  member        = "user:${var.operator_email}"

  # A COS image replacement deletes the instance and its IAM policy; the
  # name stays the same, so the grant must be recreated with it.
  lifecycle {
    replace_triggered_by = [google_compute_instance.gateway.id]
  }
}

resource "google_iap_tunnel_instance_iam_member" "operator_tunnels" {
  project  = local.project
  zone     = var.zone
  instance = google_compute_instance.gateway.name
  role     = "roles/iap.tunnelResourceAccessor"
  member   = "user:${var.operator_email}"

  lifecycle {
    replace_triggered_by = [google_compute_instance.gateway.id]
  }
}

resource "google_service_account_iam_member" "operator_acts_as_runtime" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "user:${var.operator_email}"
}
