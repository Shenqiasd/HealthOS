terraform {
  required_version = ">= 1.10, < 2.0"
}

resource "terraform_data" "control_contract" {
  input = {
    environment                  = var.environment
    synthetic_data_only          = var.synthetic_data_only
    encryption_at_rest           = var.encryption_at_rest
    database_publicly_accessible = var.database_publicly_accessible
    kms_key_alias                = var.kms_key_alias
    secret_manager_namespace     = var.secret_manager_namespace
    backup_retention_days        = var.backup_retention_days
  }

  lifecycle {
    precondition {
      condition     = var.synthetic_data_only && var.encryption_at_rest && !var.database_publicly_accessible
      error_message = "Synthetic-only, encryption, and private database networking are mandatory."
    }
  }
}
