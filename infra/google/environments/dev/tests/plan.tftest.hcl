# Plans the development root against a mocked Google provider: no credentials,
# project, state bucket or API call is involved.

mock_provider "google" {}

override_data {
  target = module.gateway.data.google_project.this
  values = {
    project_id = "synthetic-gateway-dev"
    number     = "123456789012"
    labels     = { family_brain_environment = "development" }
  }
}

variables {
  project_id           = "synthetic-gateway-dev"
  region               = "us-central1"
  zone                 = "us-central1-a"
  boot_image           = "projects/cos-cloud/global/images/cos-stable-121-18867-90-38"
  audit_retention_days = 90
  domain               = "gateway-dev.sim-g.test"
  operator_email       = "operator@example.invalid"
  alert_email          = "alerts@example.invalid"
  github_repository    = "synthetic-owner/synthetic-gateway"
  github_repository_id = "123456789"
}

# The fixed environment is checked through the label guard: a root wired to
# the wrong environment fails this plan.
run "plans_dev" {
  command = plan
}
