locals {
  # The project is dedicated to this one VM, so its gce_instance logs are ours.
  instance_filter = "resource.type=\"gce_instance\""

  # One log-based metric per telemetry metric the gateway emits
  # (src/ports/telemetry-sink.ts). Counters count entries (value 1);
  # durations and gauges are distributions.
  telemetry_metrics = {
    "request.total"           = { field = "" }
    "error.total"             = { field = "" }
    "provider.timeout"        = { field = "" }
    "search.partial"          = { field = "" }
    "request.duration"        = { field = "jsonPayload.milliseconds" }
    "authentication.duration" = { field = "jsonPayload.milliseconds" }
    "policy.duration"         = { field = "jsonPayload.milliseconds" }
    "routing.duration"        = { field = "jsonPayload.milliseconds" }
    "provider.duration"       = { field = "jsonPayload.milliseconds" }
    "database.duration"       = { field = "jsonPayload.milliseconds" }
    "approval.pending_count"  = { field = "jsonPayload.value" }
    "approval.oldest_age"     = { field = "jsonPayload.value" }
  }
  telemetry_labels = ["operation", "outcome", "code", "provider"]
}

resource "google_logging_project_bucket_config" "audit" {
  project        = local.project
  location       = var.region
  bucket_id      = "family-brain-audit"
  retention_days = var.audit_retention_days
  description    = "Family Brain Gateway audit events (${var.environment}); metadata only."

  deletion_policy = local.protection

  depends_on = [google_project_service.required]
}

# Final filter is confirmed on the real VM (VM design section 7, F13d check).
resource "google_logging_project_sink" "audit" {
  project                = local.project
  name                   = "family-brain-audit"
  destination            = "logging.googleapis.com/${google_logging_project_bucket_config.audit.id}"
  filter                 = "${local.instance_filter} AND jsonPayload.logType=\"family_brain_audit\""
  unique_writer_identity = true
}

resource "google_logging_metric" "telemetry" {
  for_each = local.telemetry_metrics

  project = local.project
  name    = "family_brain/${replace(each.key, ".", "_")}"
  filter  = "${local.instance_filter} AND jsonPayload.logType=\"family_brain_telemetry\" AND jsonPayload.metric=\"${each.key}\""

  value_extractor = each.value.field == "" ? null : "EXTRACT(${each.value.field})"

  label_extractors = {
    for label in local.telemetry_labels :
    label => "EXTRACT(jsonPayload.labels.${label})"
  }

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = each.value.field == "" ? "INT64" : "DISTRIBUTION"

    dynamic "labels" {
      for_each = local.telemetry_labels

      content {
        key        = labels.value
        value_type = "STRING"
      }
    }
  }

  dynamic "bucket_options" {
    for_each = each.value.field == "" ? [] : [1]

    content {
      exponential_buckets {
        num_finite_buckets = 32
        growth_factor      = 2
        scale              = 1
      }
    }
  }

  depends_on = [google_project_service.required]
}
