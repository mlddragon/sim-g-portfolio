# Alerts (VM design section 11), few metric references because alerting is
# billed per reference from September 2027. Every filter reads the
# structured JSON lines the VM writes; that they arrive as jsonPayload is an
# F13d check (VM design section 7).
locals {
  # Operational events that page: failures of the host units, the gateway's
  # startup and audit delivery, database client errors, backups (daily and
  # pre-migration only: a recent-tier failure carries "tier":"recent" and is
  # covered by backup_stale), deploys and certificates.
  ops_events = [
    "audit_delivery_deferred",
    "audit_delivery_failed",
    "backup_failed",
    "backup_stale",
    "certificate_renewal_failed",
    "data_disk_failed",
    "database_idle_client_error",
    "deploy_failed",
    "edge_failed",
    "firewall_failed",
    "gateway_failed",
    "host_env_failed",
    "log_ship_failed",
    "migrate_failed",
    "networks_failed",
    "postgres_failed",
    "startup_failed",
  ]
  # Container lines arrive parsed (jsonPayload.msg), and so do the host
  # units' lines, through sim-g-log-ship (F13d Stage A: COS's agent ships
  # the journal only at priority warning or worse). A journal line COS ships
  # itself arrives raw (jsonPayload.MESSAGE): the shipper's own failure, at
  # priority err.
  ops_names = join("|", local.ops_events)
  ops_filter = join(" ", [
    local.instance_filter,
    "AND (jsonPayload.msg=(${join(" OR ", [for event in local.ops_events : "\"${event}\""])})",
    "OR jsonPayload.MESSAGE=~\"\\\"msg\\\":\\\"(${local.ops_names})\\\"\")",
    "AND NOT (jsonPayload.msg=\"backup_failed\" AND jsonPayload.tier=\"recent\")",
    "AND NOT jsonPayload.MESSAGE=~\"\\\"msg\\\":\\\"backup_failed\\\",\\\"tier\\\":\\\"recent\\\"\"",
  ])
  recent_backup_filter = join(" ", [
    local.instance_filter,
    "AND ((jsonPayload.msg=\"backup_completed\" AND jsonPayload.tier=\"recent\")",
    "OR jsonPayload.MESSAGE=~\"\\\"msg\\\":\\\"backup_completed\\\",\\\"tier\\\":\\\"recent\\\"\")",
  ])
}

resource "google_monitoring_notification_channel" "owner" {
  project      = local.project
  display_name = "SIM-G ${var.environment} alerts"
  type         = "email"
  labels = {
    email_address = var.alert_email
  }

  depends_on = [google_project_service.required]
}

# 1. The gateway answers over HTTPS. One metric reference.
resource "google_monitoring_uptime_check_config" "health" {
  project      = local.project
  display_name = "SIM-G ${var.environment} health"
  timeout      = "10s"
  period       = "300s"

  http_check {
    path           = "/healthz"
    port           = 443
    use_ssl        = true
    validate_ssl   = true
    request_method = "GET"
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = local.project
      host       = var.domain
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_monitoring_alert_policy" "health" {
  project               = local.project
  display_name          = "SIM-G ${var.environment}: health check failing"
  combiner              = "OR"
  notification_channels = [google_monitoring_notification_channel.owner.id]

  conditions {
    display_name = "/healthz fails from more than one location"

    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.check_id=\"${google_monitoring_uptime_check_config.health.uptime_check_id}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "600s"

      aggregations {
        alignment_period     = "1200s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.*"]
      }
    }
  }
}

# 2. Operational events. One log-based metric, labelled by event, and one
# condition on it. One metric reference.
resource "google_logging_metric" "ops_event" {
  project = local.project
  name    = "family_brain/ops_event"
  filter  = local.ops_filter

  # Container lines only; a journal-shaped line pages with an empty label
  # (its entry is linked from the incident).
  label_extractors = {
    event = "EXTRACT(jsonPayload.msg)"
  }

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"

    labels {
      key        = "event"
      value_type = "STRING"
    }
  }

  depends_on = [google_project_service.required]
}

resource "google_monitoring_alert_policy" "ops_event" {
  project               = local.project
  display_name          = "SIM-G ${var.environment}: operational event"
  combiner              = "OR"
  notification_channels = [google_monitoring_notification_channel.owner.id]

  conditions {
    display_name = "Any operational event"

    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.ops_event.name}\" AND resource.type=\"gce_instance\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["metric.label.event"]
      }
    }
  }
}

# 3. The independent off-VM missing-backup alert (owner decision
# 2026-10-27): no recent-tier backup_completed line for 45 minutes. It
# catches a fault that stops both the backups and the VM's own
# backup_stale line, and it also pages during planned reboots and
# maintenance. One metric reference.
resource "google_logging_metric" "recent_backup_completed" {
  project = local.project
  name    = "family_brain/recent_backup_completed"
  filter  = local.recent_backup_filter

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }

  depends_on = [google_project_service.required]
}

resource "google_monitoring_alert_policy" "recent_backup_missing" {
  project               = local.project
  display_name          = "SIM-G ${var.environment}: no recent backup completed"
  combiner              = "OR"
  notification_channels = [google_monitoring_notification_channel.owner.id]

  conditions {
    display_name = "No recent-tier backup_completed for 45 minutes"

    condition_absent {
      filter   = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.recent_backup_completed.name}\" AND resource.type=\"gce_instance\""
      duration = "2700s"

      # One series for the whole project, so replacing the VM does not page
      # for the old instance's series.
      aggregations {
        alignment_period     = "900s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }
}

# Cost alerts at USD 5 and 8 a month (VM design section 11), only when the
# owner supplies the billing account. Budgets alert; they never cap spend.
resource "google_billing_budget" "monthly" {
  count = var.billing_account_id == null ? 0 : 1

  billing_account = var.billing_account_id
  display_name    = "SIM-G ${var.environment} monthly"

  budget_filter {
    projects = ["projects/${data.google_project.this.number}"]
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = "10"
    }
  }

  threshold_rules {
    threshold_percent = 0.5
  }
  threshold_rules {
    threshold_percent = 0.8
  }

  all_updates_rule {
    monitoring_notification_channels = [google_monitoring_notification_channel.owner.id]
    disable_default_iam_recipients   = false
  }

  depends_on = [google_project_service.required]
}
