terraform {
  required_version = ">= 1.10, < 2.0"
}

module "foundation" {
  source = "../../modules/foundation"

  environment                  = "staging-synthetic"
  synthetic_data_only          = true
  encryption_at_rest           = true
  database_publicly_accessible = false
  kms_key_alias                = "alias/healthos/staging-synthetic"
  secret_manager_namespace     = "healthos/staging-synthetic"
  backup_retention_days        = 7
}

output "foundation_control_contract" {
  value = module.foundation.control_contract
}
