variable "primary_region" {
  description = "Primary deployment region."
  type        = string
  default     = "af-south-1"
}

variable "env" {
  description = "Environment name."
  type        = string
  default     = "prod"
}

variable "name_prefix" {
  description = "Resource name prefix."
  type        = string
  default     = "apex-ews"
}

variable "vpc_id" {
  description = "VPC id from infra/terraform/10-network outputs."
  type        = string
}

variable "transit_gateway_id" {
  description = "Transit Gateway id (optional — set to non-null to attach VPN to TGW instead of VGW). The TGW pattern is preferred for multi-VPC futures."
  type        = string
  default     = null
}

variable "private_route_table_ids" {
  description = "Private subnet route table ids that should route the bank CIDR via the VPN."
  type        = list(string)
}

variable "bank_cidrs" {
  description = "List of CIDR blocks owned by the partner bank that should route via the VPN tunnels. Provided by bank-side network team."
  type        = list(string)
  # Placeholders to be set per T4-P1 SoW with bank network ops:
  default = []
}

variable "customer_gateway_ip" {
  description = "Public IP of the bank's on-premise customer gateway device. Provided by bank-side network team during T4-P1."
  type        = string
  # Use a sentinel until bank provides — fail fast in apply if not overridden.
  default = "TBD-DURING-T4-P1"
}

variable "customer_gateway_bgp_asn" {
  description = "BGP ASN of the bank's customer gateway device. Provided by bank during T4-P1. Default = 65000 (private ASN range)."
  type        = number
  default     = 65000
}

variable "tunnel_mtu" {
  description = "MTU for IPsec tunnels. 1380 mitigates the bank-side MTU mismatch pattern observed in similar engagements."
  type        = number
  default     = 1380
}

variable "tunnel1_preshared_key" {
  description = "Tunnel-1 PSK. **DO NOT commit; populate via TF_VAR or terraform.tfvars (gitignored).**"
  type        = string
  sensitive   = true
  default     = null
}

variable "tunnel2_preshared_key" {
  description = "Tunnel-2 PSK. **DO NOT commit; populate via TF_VAR or terraform.tfvars (gitignored).**"
  type        = string
  sensitive   = true
  default     = null
}

variable "enable_dns_resolver_rules" {
  description = "Create Route 53 Resolver rules to forward bank internal hostnames (cbs.bank.internal, etc.) via the VPN. Enable AFTER tunnels are confirmed UP."
  type        = bool
  default     = false
}

variable "bank_internal_dns_servers" {
  description = "Bank-side DNS resolver IPs. Populated during T4-P1."
  type        = list(string)
  default     = []
}

variable "bank_internal_domains" {
  description = "Bank internal hostnames to forward via VPN (e.g. ['bank.internal', 'cbs.bank.private'])."
  type        = list(string)
  default     = []
}
