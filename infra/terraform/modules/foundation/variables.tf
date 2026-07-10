variable "environment" {
  description = "Environment label. This module is currently limited to synthetic staging."
  type        = string

  validation {
    condition     = var.environment == "staging-synthetic"
    error_message = "Only staging-synthetic is authorized before the production-region gate passes."
  }
}

variable "synthetic_data_only" {
  description = "Prevents this unapproved foundation from accepting real data."
  type        = bool

  validation {
    condition     = var.synthetic_data_only
    error_message = "The foundation must remain synthetic-only until governance gates pass."
  }
}

variable "encryption_at_rest" {
  description = "Requires encrypted stateful services."
  type        = bool

  validation {
    condition     = var.encryption_at_rest
    error_message = "Encryption at rest is mandatory."
  }
}

variable "database_publicly_accessible" {
  description = "Whether the database has a public network endpoint."
  type        = bool

  validation {
    condition     = !var.database_publicly_accessible
    error_message = "The database must use private networking."
  }
}

variable "kms_key_alias" {
  description = "Provider-neutral KMS key placeholder."
  type        = string

  validation {
    condition     = length(trimspace(var.kms_key_alias)) > 0
    error_message = "A KMS key alias placeholder is required."
  }
}

variable "secret_manager_namespace" {
  description = "Provider-neutral secret-manager namespace placeholder."
  type        = string

  validation {
    condition     = length(trimspace(var.secret_manager_namespace)) > 0
    error_message = "A secret-manager namespace placeholder is required."
  }
}

variable "backup_retention_days" {
  description = "Synthetic staging backup retention used to exercise restore controls."
  type        = number

  validation {
    condition     = var.backup_retention_days >= 7 && var.backup_retention_days <= 35
    error_message = "Backup retention must remain between 7 and 35 days pending policy approval."
  }
}
