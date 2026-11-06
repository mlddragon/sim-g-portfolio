# Encrypted daily dumps (VM design section 8): private, retained 35 days,
# minimum soft delete; Terraform never destroys production's.
resource "google_storage_bucket" "backups" {
  project                     = local.project
  name                        = "${var.project_id}-sim-g-backups"
  location                    = upper(var.region)
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  labels                      = local.labels

  retention_policy {
    # Seconds, as a string in provider 8.x: 35 days.
    retention_period = "3024000"
  }

  soft_delete_policy {
    retention_duration_seconds = 7 * 86400
  }

  lifecycle_rule {
    condition {
      age = 36
    }
    action {
      type = "Delete"
    }
  }

  deletion_policy = local.protection

  depends_on = [google_project_service.required]
}

# Encrypted 15-minute dumps (recovery point investigation, section 5): the
# same protections as the daily bucket, retained 3 days. A separate bucket,
# because a retention policy covers every object in its bucket. The VM
# derives this name from its project (sim-g-host-env.sh).
resource "google_storage_bucket" "recent_backups" {
  project                     = local.project
  name                        = "${var.project_id}-sim-g-recent-backups"
  location                    = upper(var.region)
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  labels                      = local.labels

  retention_policy {
    # Seconds, as a string in provider 8.x: 3 days.
    retention_period = "259200"
  }

  soft_delete_policy {
    retention_duration_seconds = 7 * 86400
  }

  lifecycle_rule {
    condition {
      age = 4
    }
    action {
      type = "Delete"
    }
  }

  deletion_policy = local.protection

  depends_on = [google_project_service.required]
}

# The deploy pointer (VM design section 10): one small object naming the
# digest to run. Versioned so every deploy is recorded.
resource "google_storage_bucket" "deploy" {
  project                     = local.project
  name                        = "${var.project_id}-sim-g-deploy"
  location                    = upper(var.region)
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  labels                      = local.labels

  versioning {
    enabled = true
  }

  # The last 50 deploys stay recorded; older pointer versions are removed.
  lifecycle_rule {
    condition {
      num_newer_versions = 50
      with_state         = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }

  deletion_policy = local.protection

  depends_on = [google_project_service.required]
}
