# GitHub workload identity federation (VM design section 5): only the deploy
# workflow of the exact repository (by immutable ID and name), on main, in
# this environment's GitHub environment can exchange a token at all.
# Production accepts only a manual dispatch. Development also accepts the
# run that follows CI's success on main (owner ruling 2026-11-04); the
# workflow refuses pull requests, forks and commits main has moved past.
locals {
  github_deploy_events = local.production ? ["workflow_dispatch"] : ["workflow_dispatch", "workflow_run"]
  github_event_clause  = "(${join(" || ", [for event in local.github_deploy_events : "assertion.event_name == \"${event}\""])})"
}

resource "google_iam_workload_identity_pool" "github" {
  project                   = local.project
  workload_identity_pool_id = "github-actions"
  display_name              = "GitHub Actions"

  depends_on = [google_project_service.required]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = local.project
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub ${local.github_environment}"

  attribute_mapping = {
    "google.subject"          = "assertion.sub"
    "attribute.repository"    = "assertion.repository"
    "attribute.repository_id" = "assertion.repository_id"
    "attribute.ref"           = "assertion.ref"
    "attribute.environment"   = "assertion.environment"
  }

  attribute_condition = join(" && ", [
    "assertion.repository_id == \"${var.github_repository_id}\"",
    "assertion.repository == \"${var.github_repository}\"",
    "assertion.ref == \"refs/heads/main\"",
    "assertion.environment == \"${local.github_environment}\"",
    "assertion.job_workflow_ref == \"${var.github_repository}/.github/workflows/deploy.yml@refs/heads/main\"",
    local.github_event_clause,
  ])

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "github_deploys_as_deployer" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.environment/${local.github_environment}"
}
