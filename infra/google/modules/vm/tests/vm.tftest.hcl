# Plans the e2-micro VM module against a mocked Google provider: no
# credentials, project or API call is involved, and nothing can be applied.

mock_provider "google" {}

override_data {
  target = data.google_project.this
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
  environment          = "development"
  boot_image           = "projects/cos-cloud/global/images/cos-stable-121-18867-90-38"
  audit_retention_days = 90
  domain               = "gateway-dev.sim-g.test"
  operator_email       = "operator@example.invalid"
  alert_email          = "alerts@example.invalid"
  github_repository    = "synthetic-owner/synthetic-gateway"
  github_repository_id = "123456789"
}

run "plans_a_free_tier_shaped_shielded_vm" {
  command = plan

  assert {
    condition     = google_compute_instance.gateway.machine_type == "e2-micro"
    error_message = "The approved target is one e2-micro."
  }
  assert {
    condition     = google_compute_instance.gateway.scheduling[0].preemptible == false && google_compute_instance.gateway.scheduling[0].provisioning_model == "STANDARD"
    error_message = "The free tier needs a non-Spot VM."
  }
  assert {
    condition     = google_compute_instance.gateway.boot_disk[0].initialize_params[0].type == "pd-standard" && google_compute_instance.gateway.boot_disk[0].initialize_params[0].size == 10
    error_message = "The boot disk is a 10 GB standard PD (balanced is not free)."
  }
  assert {
    condition     = google_compute_disk.data.type == "pd-standard" && google_compute_disk.data.size == 10
    error_message = "The data disk is a 10 GB standard PD."
  }
  assert {
    condition     = google_compute_instance.gateway.shielded_instance_config[0].enable_secure_boot && google_compute_instance.gateway.shielded_instance_config[0].enable_vtpm && google_compute_instance.gateway.shielded_instance_config[0].enable_integrity_monitoring
    error_message = "Shielded VM is fully on."
  }
  assert {
    condition = alltrue([
      google_compute_instance.gateway.metadata["enable-oslogin"] == "TRUE",
      google_compute_instance.gateway.metadata["block-project-ssh-keys"] == "TRUE",
      google_compute_instance.gateway.metadata["serial-port-enable"] == "FALSE",
      google_compute_instance.gateway.metadata["google-logging-enabled"] == "true",
    ])
    error_message = "OS Login, no project keys, no serial port, logging agent on."
  }
  assert {
    condition     = google_compute_instance.gateway.network_interface[0].access_config[0].network_tier == "STANDARD"
    error_message = "The IPv4 is on the Standard tier."
  }
}

run "keeps_development_temporary" {
  command = plan

  assert {
    condition     = length(google_compute_address.ingress) == 0
    error_message = "Development reserves no static IPv4, which would bill while unattached."
  }
  assert {
    condition = alltrue([
      !google_compute_instance.gateway.deletion_protection,
      google_compute_disk.data.deletion_policy == "DELETE",
      google_storage_bucket.backups.deletion_policy == "DELETE",
      google_storage_bucket.recent_backups.deletion_policy == "DELETE",
      google_logging_project_bucket_config.audit.deletion_policy == "DELETE",
    ])
    error_message = "Development can be torn down completely."
  }
}

run "protects_production" {
  command = plan

  override_data {
    target = data.google_project.this
    values = {
      project_id = "synthetic-gateway-prod"
      number     = "210987654321"
      labels     = { family_brain_environment = "production" }
    }
  }

  variables {
    project_id  = "synthetic-gateway-prod"
    environment = "production"
  }

  assert {
    condition     = length(google_compute_address.ingress) == 1 && google_compute_address.ingress[0].network_tier == "STANDARD" && google_compute_address.ingress[0].deletion_policy == "PREVENT"
    error_message = "Production has one protected static Standard-tier IPv4."
  }
  assert {
    condition = alltrue([
      google_compute_instance.gateway.deletion_protection,
      google_compute_disk.data.deletion_policy == "PREVENT",
      google_storage_bucket.backups.deletion_policy == "PREVENT",
      google_storage_bucket.recent_backups.deletion_policy == "PREVENT",
      google_storage_bucket.deploy.deletion_policy == "PREVENT",
      google_logging_project_bucket_config.audit.deletion_policy == "PREVENT",
    ])
    error_message = "Terraform cannot destroy production's VM, data, backups, deploy history or audit trail."
  }
}

run "opens_only_https_and_iap_ssh" {
  command = plan

  assert {
    condition     = length(google_compute_firewall.https.allow) == 1 && alltrue([for rule in google_compute_firewall.https.allow : rule.ports == tolist(["443"])])
    error_message = "The HTTPS rule opens 443 only."
  }
  assert {
    condition     = google_compute_firewall.iap_ssh.source_ranges == toset(["35.235.240.0/20"]) && alltrue([for rule in google_compute_firewall.iap_ssh.allow : rule.ports == tolist(["22"])])
    error_message = "SSH only from IAP."
  }
  assert {
    condition     = google_compute_network.gateway.auto_create_subnetworks == false
    error_message = "A custom VPC with no default subnets or rules."
  }
}

run "opens_port_80_for_redirects_and_validation" {
  command = plan

  # Owner decision 2026-10-27: port 80 serves only HTTPS redirects and the
  # ACME HTTP-01 challenge (nginx), so it is always open, and only to the
  # edge tag.
  assert {
    condition     = length(google_compute_firewall.http.allow) == 1 && alltrue([for rule in google_compute_firewall.http.allow : rule.ports == tolist(["80"])]) && google_compute_firewall.http.target_tags == toset(["sim-g-edge"])
    error_message = "Port 80 is open to the edge tag only."
  }
}

run "keeps_buckets_private_and_bounded" {
  command = plan

  assert {
    condition = alltrue([
      for bucket in [google_storage_bucket.backups, google_storage_bucket.recent_backups, google_storage_bucket.deploy] :
      bucket.uniform_bucket_level_access && bucket.public_access_prevention == "enforced"
    ])
    error_message = "Every bucket is private with uniform access."
  }
  assert {
    condition     = google_storage_bucket.backups.retention_policy[0].retention_period == "3024000" && google_storage_bucket.backups.soft_delete_policy[0].retention_duration_seconds == 7 * 86400
    error_message = "Backups are retained 35 days with the minimum soft delete."
  }
  assert {
    condition = alltrue([
      google_storage_bucket.backups.name == "synthetic-gateway-dev-sim-g-backups",
      [for rule in google_storage_bucket.backups.lifecycle_rule : one(rule.condition).age] == [36],
    ])
    error_message = "The daily bucket is unchanged: its name and deletion at 36 days."
  }
  assert {
    # The host wrapper derives exactly this name from the project.
    condition     = google_storage_bucket.recent_backups.name == "synthetic-gateway-dev-sim-g-recent-backups"
    error_message = "The recent bucket has the name the VM derives."
  }
  assert {
    condition = alltrue([
      google_storage_bucket.recent_backups.retention_policy[0].retention_period == "259200",
      google_storage_bucket.recent_backups.soft_delete_policy[0].retention_duration_seconds == 7 * 86400,
      length(google_storage_bucket.recent_backups.lifecycle_rule) == 1,
      [for rule in google_storage_bucket.recent_backups.lifecycle_rule : one(rule.condition).age] == [4],
      [for rule in google_storage_bucket.recent_backups.lifecycle_rule : one(rule.action).type] == ["Delete"],
    ])
    error_message = "Recent backups are retained 3 days, deleted at 4, with the minimum soft delete."
  }
  assert {
    condition = alltrue([
      google_storage_bucket.recent_backups.location == google_storage_bucket.backups.location,
      google_storage_bucket.recent_backups.location == "US-CENTRAL1",
      google_storage_bucket.recent_backups.storage_class == "STANDARD",
      google_storage_bucket.recent_backups.labels == google_storage_bucket.backups.labels,
      google_storage_bucket.recent_backups.labels == tomap({ application = "family-brain-gateway", environment = "development", managed_by = "terraform" }),
    ])
    error_message = "The recent bucket sits beside the daily one: same region, class and labels."
  }
  assert {
    # Locking is irreversible and stays an owner decision.
    condition = alltrue([
      for bucket in [google_storage_bucket.backups, google_storage_bucket.recent_backups] :
      !coalesce(bucket.retention_policy[0].is_locked, false)
    ])
    error_message = "Neither backup retention policy is locked."
  }
  assert {
    condition     = google_logging_project_bucket_config.audit.retention_days == 90
    error_message = "Audit retention is explicit."
  }
  assert {
    condition     = strcontains(google_logging_project_sink.audit.filter, "resource.type=\"gce_instance\"") && strcontains(google_logging_project_sink.audit.filter, "family_brain_audit")
    error_message = "The audit sink selects the VM's audit lines."
  }
}

run "refuses_another_environments_project" {
  command = plan

  override_data {
    target = data.google_project.this
    values = {
      project_id = "synthetic-gateway-dev"
      number     = "123456789012"
      labels     = { family_brain_environment = "production" }
    }
  }

  expect_failures = [data.google_project.this]
}

run "refuses_another_environments_project_even_when_targeted" {
  command = plan

  override_data {
    target = data.google_project.this
    values = {
      project_id = "synthetic-gateway-dev"
      number     = "123456789012"
      labels     = { family_brain_environment = "production" }
    }
  }

  plan_options {
    target = [google_storage_bucket.deploy]
  }

  expect_failures = [data.google_project.this]
}

run "refuses_a_zone_outside_the_region" {
  command = plan

  variables {
    zone = "us-east1-b"
  }

  expect_failures = [var.zone]
}

run "refuses_a_non_free_tier_region" {
  command = plan

  variables {
    region = "us-east4"
    zone   = "us-east4-a"
  }

  expect_failures = [var.region]
}

run "grants_only_per_resource_roles_and_one_log_writer" {
  command = plan

  assert {
    condition     = google_project_iam_member.runtime_writes_logs.role == "roles/logging.logWriter"
    error_message = "The one project-level role is the runtime's log writer."
  }
  assert {
    condition     = alltrue([for grant in google_storage_bucket_iam_member.runtime_creates_backups : grant.role == "roles/storage.objectCreator"])
    error_message = "The runtime may only create backup objects."
  }
  assert {
    condition     = length(google_secret_manager_secret.gateway) == 3 && length(google_secret_manager_secret_iam_member.runtime) == 3
    error_message = "Three empty secrets, each with its own accessor grant."
  }
  assert {
    condition     = google_artifact_registry_repository_iam_member.runtime_pulls.role == "roles/artifactregistry.reader" && google_artifact_registry_repository_iam_member.deployer_pushes.role == "roles/artifactregistry.writer"
    error_message = "The runtime pulls and the deployer pushes, on the one repository."
  }
  assert {
    condition     = google_artifact_registry_repository.images.docker_config[0].immutable_tags == true
    error_message = "Tags are immutable; deployment is by digest."
  }
  assert {
    condition     = google_compute_instance.gateway.metadata["enable-oslogin-2fa"] == "TRUE"
    error_message = "OS Login requires two-step verification (owner decision)."
  }
  assert {
    condition     = google_compute_instance_iam_member.operator_logs_in.member == "user:operator@example.invalid" && google_iap_tunnel_instance_iam_member.operator_tunnels.member == "user:operator@example.invalid"
    error_message = "Only the named operator logs in, through IAP."
  }
}

run "federates_only_the_deploy_workflow_on_main" {
  command = plan

  assert {
    condition     = strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, "assertion.repository_id == \"123456789\"") && strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, "assertion.ref == \"refs/heads/main\"")
    error_message = "Only the repository's main branch."
  }
  assert {
    condition     = strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, "assertion.job_workflow_ref == \"synthetic-owner/synthetic-gateway/.github/workflows/deploy.yml@refs/heads/main\"") && strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, "assertion.environment == \"development\"")
    error_message = "Only the deploy workflow, in this environment."
  }
  assert {
    condition     = strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, "(assertion.event_name == \"workflow_dispatch\" || assertion.event_name == \"workflow_run\")")
    error_message = "Development deploys by hand or after CI passes on main (owner ruling 2026-11-04)."
  }
  assert {
    condition     = length(google_artifact_registry_repository.images.cleanup_policies) == 2
    error_message = "Development keeps the newest images and removes older ones."
  }
}

run "alerts_the_owner_on_health_events_and_missing_backups" {
  command = plan

  assert {
    condition     = google_monitoring_notification_channel.owner.labels.email_address == "alerts@example.invalid"
    error_message = "Alerts go to the configured recipient."
  }
  assert {
    condition     = google_monitoring_uptime_check_config.health.http_check[0].path == "/healthz" && google_monitoring_uptime_check_config.health.http_check[0].validate_ssl == true
    error_message = "The uptime check reads /healthz over verified TLS."
  }
  assert {
    condition     = strcontains(google_logging_metric.ops_event.filter, "\"backup_stale\"") && strcontains(google_logging_metric.ops_event.filter, "\"certificate_renewal_failed\"") && strcontains(google_logging_metric.ops_event.filter, "NOT (jsonPayload.msg=\"backup_failed\" AND jsonPayload.tier=\"recent\")")
    error_message = "Operational events page; a recent-tier backup failure does not."
  }
  assert {
    condition     = strcontains(google_logging_metric.ops_event.filter, "\"log_ship_failed\"") && strcontains(google_logging_metric.ops_event.filter, "jsonPayload.MESSAGE=~")
    error_message = "A failed host log shipper pages through COS's own journal path."
  }
  assert {
    condition     = google_monitoring_alert_policy.recent_backup_missing.conditions[0].condition_absent[0].duration == "2700s"
    error_message = "The off-VM alert fires after 45 minutes without a recent backup."
  }
  assert {
    condition     = length(google_billing_budget.monthly) == 0
    error_message = "No budget without the owner's billing account."
  }
}

run "adds_cost_alerts_when_the_owner_supplies_the_billing_account" {
  command = plan

  variables {
    billing_account_id = "000000-000000-000000"
  }

  assert {
    condition     = length(google_billing_budget.monthly) == 1 && google_billing_budget.monthly[0].amount[0].specified_amount[0].units == "10"
    error_message = "Alerts at 50 and 80 percent of USD 10."
  }
}

run "binds_production_federation_to_the_production_environment" {
  command = plan

  variables {
    environment = "production"
  }

  override_data {
    target = data.google_project.this
    values = {
      project_id = "synthetic-gateway-dev"
      number     = "123456789012"
      labels     = { family_brain_environment = "production" }
    }
  }

  assert {
    condition     = strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, "assertion.environment == \"production\"") && !strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, "development")
    error_message = "Production federation accepts only the production GitHub environment."
  }
  assert {
    condition     = strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, "(assertion.event_name == \"workflow_dispatch\")") && !strcontains(google_iam_workload_identity_pool_provider.github.attribute_condition, "workflow_run")
    error_message = "Production accepts only a manual dispatch."
  }
  assert {
    condition     = length(google_artifact_registry_repository.images.cleanup_policies) == 0
    error_message = "Production images are never removed automatically."
  }
}

# Owner decision 2026-10-30 (COS patching): patches are VM replacements from
# an exact, reviewed cos-cloud LTS image.
run "accepts_an_exact_cos_lts_image" {
  command = plan

  variables {
    boot_image = "projects/cos-cloud/global/images/cos-129-19506-578-21"
  }

  assert {
    condition     = one(google_compute_instance.gateway.boot_disk[0].initialize_params).image == "projects/cos-cloud/global/images/cos-129-19506-578-21"
    error_message = "The boot disk uses the exact LTS image."
  }
  assert {
    condition     = google_compute_instance.gateway.shielded_instance_config[0].enable_secure_boot && google_compute_instance.gateway.shielded_instance_config[0].enable_vtpm && google_compute_instance.gateway.shielded_instance_config[0].enable_integrity_monitoring
    error_message = "Secure Boot, vTPM and integrity monitoring stay on."
  }
}

run "refuses_an_image_family" {
  command = plan

  variables {
    boot_image = "projects/cos-cloud/global/images/family/cos-129-lts"
  }

  expect_failures = [var.boot_image]
}

run "refuses_a_beta_image" {
  command = plan

  variables {
    boot_image = "projects/cos-cloud/global/images/cos-beta-133-19999-44-170"
  }

  expect_failures = [var.boot_image]
}

run "refuses_an_image_from_another_project" {
  command = plan

  variables {
    boot_image = "projects/debian-cloud/global/images/cos-129-19506-578-21"
  }

  expect_failures = [var.boot_image]
}

run "refuses_an_arm64_image" {
  command = plan

  variables {
    boot_image = "projects/cos-cloud/global/images/cos-arm64-129-19506-578-21"
  }

  expect_failures = [var.boot_image]
}

run "refuses_a_dev_image" {
  command = plan

  variables {
    boot_image = "projects/cos-cloud/global/images/cos-dev-137-20100-1-0"
  }

  expect_failures = [var.boot_image]
}

run "refuses_trailing_text_after_the_build" {
  command = plan

  variables {
    boot_image = "projects/cos-cloud/global/images/cos-129-19506-578-21-x"
  }

  expect_failures = [var.boot_image]
}
