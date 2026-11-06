# Owner inputs (VM design section 14); none of these has a default.
variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "zone" {
  type = string
}

variable "boot_image" {
  description = "An exact cos-cloud COS image: an LTS build (cos-<milestone>-<build>) or cos-stable."
  type        = string
}

variable "audit_retention_days" {
  type = number
}

variable "domain" {
  description = "The gateway's host name."
  type        = string
}

variable "operator_email" {
  description = "The one human operator (OS Login and IAP)."
  type        = string
}

variable "alert_email" {
  description = "The alert recipient, from approved configuration."
  type        = string
}

variable "github_repository" {
  type = string
}

variable "github_repository_id" {
  type = string
}


variable "billing_account_id" {
  description = "Optional, for the cost-alert budget; never committed."
  type        = string
  default     = null
}
