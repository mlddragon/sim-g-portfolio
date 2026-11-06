# The images this environment runs, by digest only: the gateway and the
# PostgreSQL, nginx and certbot derivatives, built by the deploy workflow.
resource "google_artifact_registry_repository" "images" {
  project       = local.project
  location      = var.region
  repository_id = "sim-g"
  format        = "DOCKER"
  description   = "SIM-G images (${var.environment}); deployed by digest."
  labels        = local.labels

  docker_config {
    immutable_tags = true
  }

  # Development deploys after every merge, so it keeps each image's newest
  # versions (rollback targets) and removes older ones after two weeks.
  # Production images are never removed automatically.
  dynamic "cleanup_policies" {
    for_each = local.production ? [] : ["keep-recent"]
    content {
      id     = cleanup_policies.value
      action = "KEEP"
      most_recent_versions {
        keep_count = 5
      }
    }
  }
  dynamic "cleanup_policies" {
    for_each = local.production ? [] : ["delete-old"]
    content {
      id     = cleanup_policies.value
      action = "DELETE"
      condition {
        tag_state  = "ANY"
        older_than = "1209600s"
      }
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_artifact_registry_repository_iam_member" "runtime_pulls" {
  project    = local.project
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_artifact_registry_repository_iam_member" "deployer_pushes" {
  project    = local.project
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.deployer.email}"
}
