variable "region" {
  description = "Primary AWS region for APEX EWS."
  type        = string
  default     = "af-south-1"
}

variable "env" {
  description = "Environment name (dev/staging/prod)."
  type        = string
  default     = "prod"
}

variable "allowed_regions" {
  description = "Regions permitted by SCP. All others denied."
  type        = list(string)
  default     = ["af-south-1", "eu-west-1"] # eu-west-1 reserved for DR (Phase 5)
}

variable "org_member_ous" {
  description = "OU names under the root."
  type        = list(string)
  default     = ["Security", "Workloads", "Sandbox"]
}
