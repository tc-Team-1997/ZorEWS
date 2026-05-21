variable "region" {
  description = "Primary AWS region for APEX EWS."
  type        = string
  default     = "af-south-1"
}

variable "primary_region" {
  description = "Primary deployment region (alias for region; used by some resources)."
  type        = string
  default     = "af-south-1"
}

variable "env" {
  description = "Environment name (dev/staging/prod)."
  type        = string
  default     = "prod"
}

variable "name_prefix" {
  description = "Prefix for resource names (e.g. apex-ews)."
  type        = string
  default     = "apex-ews"
}

variable "allowed_regions" {
  description = "Regions permitted by SCP. All others denied."
  type        = list(string)
  default     = ["af-south-1", "ap-south-1"] # ap-south-1 reserved for DR (Phase 5 T5.2)
}

variable "org_member_ous" {
  description = "OU names under the root."
  type        = list(string)
  default     = ["Security", "Workloads", "Sandbox"]
}

variable "enable_aws_config" {
  description = "Enable AWS Config recorder. Set false during initial bootstrap to avoid race conditions; flip to true after first apply."
  type        = bool
  default     = false
}

variable "enable_guardduty" {
  description = "Enable GuardDuty threat detection."
  type        = bool
  default     = true
}

variable "enable_security_hub" {
  description = "Enable Security Hub posture aggregator + CIS + AWS FSBP standards."
  type        = bool
  default     = true
}
