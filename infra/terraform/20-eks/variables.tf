variable "region" {
  type    = string
  default = "af-south-1"
}

variable "env" {
  type    = string
  default = "prod"
}

variable "cluster_version" {
  type    = string
  default = "1.30"
}

variable "vpc_id" {
  description = "VPC id from 10-network outputs."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet ids from 10-network outputs."
  type        = list(string)
}

variable "general_node_instance_types" {
  type    = list(string)
  default = ["m6i.xlarge"]
}

variable "ai_node_instance_types" {
  type    = list(string)
  default = ["g5.xlarge"]
}

variable "general_node_desired" {
  type    = number
  default = 3
}

variable "ai_node_desired" {
  type    = number
  default = 0
}

variable "service_accounts" {
  description = "Map of microservice -> namespace for IRSA roles."
  type        = map(string)
  default = {
    "auth-svc"         = "platform"
    "audit-svc"        = "platform"
    "pipeline-svc"     = "data"
    "regulatory-svc"   = "regulatory"
    "ai-copilot-svc"   = "ai"
    "notification-svc" = "platform"
    "analytics-svc"    = "analytics"
  }
}

###############################################################################
# T4.4 — Karpenter (just-in-time node provisioning)
###############################################################################

variable "enable_karpenter" {
  description = "Enable Karpenter just-in-time node provisioning (replaces manual node group scaling). Requires Helm + kubectl bootstrap in infra/k8s/karpenter/."
  type        = bool
  default     = false
}
