output "control_contract" {
  description = "Validated provider-neutral controls for the synthetic foundation."
  value       = terraform_data.control_contract.output
}
