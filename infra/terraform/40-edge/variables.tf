variable "region" {
  type    = string
  default = "af-south-1"
}

variable "env" {
  type    = string
  default = "prod"
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "domain_name" {
  description = "Apex domain (e.g. apex-ews.example.co.ke)."
  type        = string
  default     = "apex-ews.example.co.ke"
}

variable "spa_domain_name" {
  description = "Sub-domain for the SPA (CloudFront)."
  type        = string
  default     = "app.apex-ews.example.co.ke"
}

variable "enable_shield_advanced" {
  description = "Toggle Shield Advanced (cost ~3k USD/month)."
  type        = bool
  default     = false
}
