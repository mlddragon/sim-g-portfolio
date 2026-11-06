variable "project_id" {
  description = "Existing project for this environment. The module creates no project and touches no billing account."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be a Google Cloud project ID."
  }
}

variable "region" {
  description = "A Free Tier e2-micro region (owner decision)."
  type        = string

  validation {
    condition     = contains(["us-west1", "us-central1", "us-east1"], var.region)
    error_message = "region must be us-west1, us-central1 or us-east1 (the e2-micro Free Tier regions)."
  }
}

variable "zone" {
  description = "A zone inside the region."
  type        = string

  validation {
    condition     = startswith(var.zone, "${var.region}-") && can(regex("^[a-z]+-[a-z]+[0-9]+-[a-z]$", var.zone))
    error_message = "zone must be a zone of the selected region."
  }
}

variable "environment" {
  description = "Gateway environment this project serves."
  type        = string

  validation {
    condition     = contains(["development", "production"], var.environment)
    error_message = "environment must be development or production."
  }
}

variable "boot_image" {
  description = "An exact Container-Optimized OS image (not a family), so the boot disk is reproducible: an LTS build such as cos-129-19506-578-21, or cos-stable."
  type        = string

  # Patching replaces the VM from a newly pinned image (owner decision
  # 2026-10-30): never a family, a beta or dev build, or another project.
  validation {
    condition     = can(regex("^projects/cos-cloud/global/images/cos-(stable-)?[0-9]{2,3}-[0-9]+-[0-9]+-[0-9]+$", var.boot_image))
    error_message = "boot_image must be an exact cos-cloud LTS or cos-stable image."
  }
}

variable "audit_retention_days" {
  description = "Audit log retention (owner decision); deliberately no default."
  type        = number

  validation {
    condition     = var.audit_retention_days >= 1 && var.audit_retention_days <= 3650 && floor(var.audit_retention_days) == var.audit_retention_days
    error_message = "audit_retention_days must be a whole number from 1 to 3650."
  }
}

variable "domain" {
  description = "The gateway's host name (owner decision: brain.example.invalid in production)."
  type        = string

  validation {
    condition     = length(var.domain) <= 253 && can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$", var.domain))
    error_message = "domain must be a lowercase DNS name."
  }
}

variable "operator_email" {
  description = "The one human operator (OS Login, IAP and acting as the runtime for OS Login); deliberately no default."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[a-z]{2,}$", var.operator_email))
    error_message = "operator_email must be an email address."
  }
}

variable "alert_email" {
  description = "The alert recipient (owner decision: Operator's Workspace account, read from approved configuration); no default."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[a-z]{2,}$", var.alert_email))
    error_message = "alert_email must be an email address."
  }
}

variable "github_repository" {
  description = "The repository allowed to deploy, as owner/name."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$", var.github_repository))
    error_message = "github_repository must be owner/name."
  }
}

variable "github_repository_id" {
  description = "The repository's immutable numeric ID, so a renamed or recreated repository cannot deploy."
  type        = string

  validation {
    condition     = can(regex("^[1-9][0-9]{0,19}$", var.github_repository_id))
    error_message = "github_repository_id must be the numeric repository ID."
  }
}

variable "billing_account_id" {
  description = "Optional: the billing account for the cost-alert budget (never committed; null creates no budget). Budgets alert only; Compute Engine has no spend cap."
  type        = string
  default     = null

  validation {
    condition     = var.billing_account_id == null || can(regex("^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$", var.billing_account_id))
    error_message = "billing_account_id must look like 000000-000000-000000."
  }
}
