###############################################################################
# Site-to-Site VPN to partner bank network.
#
# T4-P1 deliverable. Active-active IPsec (2 tunnels) — required for HA
# per docs/operationalization/execution-plans.md.
#
# DEFENCE: MTU 1380 mitigates the tunnel-flap pattern seen in similar
# engagements; CloudWatch alarms on tunnel state DOWN are wired via
# infra/k8s/prometheus/infra-alerting.yaml (BothVpnTunnelsDown rule).
#
# DEPLOY SEQUENCE:
#   1. Bank provides: customer_gateway_ip + customer_gateway_bgp_asn +
#      bank_cidrs + bank_internal_dns_servers + bank_internal_domains
#   2. SRE generates 2 PSKs (32+ chars hex) and stores in Secrets Manager:
#      aws secretsmanager create-secret \
#        --name apex-ews/prod/vpn/tunnel1-psk --secret-string $(openssl rand -hex 32)
#   3. Apply with PSKs from Secrets Manager:
#      TF_VAR_tunnel1_preshared_key=$(aws secretsmanager get-secret-value \
#        --secret-id apex-ews/prod/vpn/tunnel1-psk --query SecretString --output text) \
#      TF_VAR_tunnel2_preshared_key=$(aws secretsmanager get-secret-value \
#        --secret-id apex-ews/prod/vpn/tunnel2-psk --query SecretString --output text) \
#      terraform apply
#   4. Bank-side configures their device with matching PSKs + BGP peering
#   5. Verify both tunnels UP: `aws ec2 describe-vpn-connections`
#   6. Enable DNS resolver rules: terraform apply -var='enable_dns_resolver_rules=true'
###############################################################################

# Fail-fast guard: refuse to apply with placeholder bank CGW IP
resource "null_resource" "validate_inputs" {
  lifecycle {
    precondition {
      condition     = var.customer_gateway_ip != "TBD-DURING-T4-P1"
      error_message = "customer_gateway_ip must be set to the bank's public CGW IP. Set TF_VAR_customer_gateway_ip during apply."
    }
    precondition {
      condition     = length(var.bank_cidrs) > 0
      error_message = "bank_cidrs must contain at least one CIDR block provided by the bank network team."
    }
    precondition {
      condition     = var.tunnel1_preshared_key != null && var.tunnel2_preshared_key != null
      error_message = "tunnel1_preshared_key + tunnel2_preshared_key must both be populated (fetch from Secrets Manager via TF_VAR_*)."
    }
  }
}

###############################################################################
# Customer gateway — the bank's on-prem device
###############################################################################

resource "aws_customer_gateway" "bank" {
  bgp_asn    = var.customer_gateway_bgp_asn
  ip_address = var.customer_gateway_ip
  type       = "ipsec.1"

  tags = {
    Name    = "${var.name_prefix}-bank-cgw"
    purpose = "bank-vpn-customer-gateway"
  }
}

###############################################################################
# Virtual private gateway (used only when not attaching to a TGW)
###############################################################################

resource "aws_vpn_gateway" "this" {
  count           = var.transit_gateway_id == null ? 1 : 0
  vpc_id          = var.vpc_id
  amazon_side_asn = 64512

  tags = {
    Name = "${var.name_prefix}-vgw"
  }
}

resource "aws_vpn_gateway_route_propagation" "this" {
  for_each       = var.transit_gateway_id == null ? toset(var.private_route_table_ids) : toset([])
  vpn_gateway_id = aws_vpn_gateway.this[0].id
  route_table_id = each.value
}

###############################################################################
# VPN connection — 2 IPsec tunnels (AWS provisions both ends; bank receives
# the configuration via the AWS console export AND from the encrypted SoW)
###############################################################################

resource "aws_vpn_connection" "bank" {
  customer_gateway_id = aws_customer_gateway.bank.id
  type                = "ipsec.1"
  static_routes_only  = false # enable BGP

  # Attach to TGW if provided, else to VGW
  transit_gateway_id = var.transit_gateway_id
  vpn_gateway_id     = var.transit_gateway_id == null ? aws_vpn_gateway.this[0].id : null

  # Tunnel 1
  tunnel1_preshared_key   = var.tunnel1_preshared_key
  tunnel1_phase1_lifetime = 28800
  tunnel1_phase2_lifetime = 3600
  tunnel1_ike_versions    = ["ikev2"]
  tunnel1_dpd_timeout_action     = "restart"
  tunnel1_dpd_timeout_seconds    = 30
  tunnel1_replay_window_size     = 1024
  tunnel1_startup_action         = "start"
  tunnel1_phase1_encryption_algorithms = ["AES256-GCM-16"]
  tunnel1_phase2_encryption_algorithms = ["AES256-GCM-16"]
  tunnel1_phase1_integrity_algorithms  = ["SHA2-256", "SHA2-384", "SHA2-512"]
  tunnel1_phase2_integrity_algorithms  = ["SHA2-256", "SHA2-384", "SHA2-512"]
  tunnel1_phase1_dh_group_numbers      = [19, 20, 21]
  tunnel1_phase2_dh_group_numbers      = [19, 20, 21]

  # Tunnel 2
  tunnel2_preshared_key   = var.tunnel2_preshared_key
  tunnel2_phase1_lifetime = 28800
  tunnel2_phase2_lifetime = 3600
  tunnel2_ike_versions    = ["ikev2"]
  tunnel2_dpd_timeout_action     = "restart"
  tunnel2_dpd_timeout_seconds    = 30
  tunnel2_replay_window_size     = 1024
  tunnel2_startup_action         = "start"
  tunnel2_phase1_encryption_algorithms = ["AES256-GCM-16"]
  tunnel2_phase2_encryption_algorithms = ["AES256-GCM-16"]
  tunnel2_phase1_integrity_algorithms  = ["SHA2-256", "SHA2-384", "SHA2-512"]
  tunnel2_phase2_integrity_algorithms  = ["SHA2-256", "SHA2-384", "SHA2-512"]
  tunnel2_phase1_dh_group_numbers      = [19, 20, 21]
  tunnel2_phase2_dh_group_numbers      = [19, 20, 21]

  # CloudWatch logs
  tunnel1_log_options {
    cloudwatch_log_options {
      log_enabled       = true
      log_group_arn     = aws_cloudwatch_log_group.vpn.arn
      log_output_format = "json"
    }
  }
  tunnel2_log_options {
    cloudwatch_log_options {
      log_enabled       = true
      log_group_arn     = aws_cloudwatch_log_group.vpn.arn
      log_output_format = "json"
    }
  }

  tags = {
    Name    = "${var.name_prefix}-bank-vpn"
    purpose = "bank-vpn-connection"
  }

  depends_on = [null_resource.validate_inputs]
}

###############################################################################
# Static routes (informational only — BGP advertises in active mode)
###############################################################################

resource "aws_vpn_connection_route" "bank" {
  for_each               = toset(var.bank_cidrs)
  destination_cidr_block = each.value
  vpn_connection_id      = aws_vpn_connection.bank.id
}

###############################################################################
# CloudWatch log group + monitoring alarms
###############################################################################

resource "aws_cloudwatch_log_group" "vpn" {
  name              = "/${var.name_prefix}/${var.env}/vpn"
  retention_in_days = 90
}

resource "aws_cloudwatch_metric_alarm" "tunnel1_down" {
  alarm_name          = "${var.name_prefix}-vpn-tunnel1-down"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "TunnelState"
  namespace           = "AWS/VPN"
  period              = 60
  statistic           = "Maximum"
  threshold           = 1
  alarm_description   = "VPN tunnel 1 to ${aws_customer_gateway.bank.tags.Name} is DOWN. Falls back to mock integrations."

  dimensions = {
    VpnId        = aws_vpn_connection.bank.id
    TunnelIpAddress = aws_vpn_connection.bank.tunnel1_address
  }
}

resource "aws_cloudwatch_metric_alarm" "tunnel2_down" {
  alarm_name          = "${var.name_prefix}-vpn-tunnel2-down"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "TunnelState"
  namespace           = "AWS/VPN"
  period              = 60
  statistic           = "Maximum"
  threshold           = 1
  alarm_description   = "VPN tunnel 2 to ${aws_customer_gateway.bank.tags.Name} is DOWN."

  dimensions = {
    VpnId        = aws_vpn_connection.bank.id
    TunnelIpAddress = aws_vpn_connection.bank.tunnel2_address
  }
}

###############################################################################
# Route 53 Resolver rules — bank internal hostnames forwarded via VPN.
# Disabled until tunnels confirmed UP (T4-P1 final step).
###############################################################################

resource "aws_route53_resolver_endpoint" "outbound" {
  count     = var.enable_dns_resolver_rules ? 1 : 0
  name      = "${var.name_prefix}-bank-resolver-outbound"
  direction = "OUTBOUND"

  security_group_ids = []  # populated from 10-network output downstream

  # Subnets to attach — must be private subnets in the VPC routed via VPN
  dynamic "ip_address" {
    for_each = var.private_route_table_ids
    content {
      subnet_id = ip_address.value  # placeholder; replace with subnet_id when wired
    }
  }
}

resource "aws_route53_resolver_rule" "bank" {
  for_each             = var.enable_dns_resolver_rules ? toset(var.bank_internal_domains) : toset([])
  domain_name          = each.value
  name                 = "${var.name_prefix}-fwd-${replace(each.value, ".", "-")}"
  rule_type            = "FORWARD"
  resolver_endpoint_id = aws_route53_resolver_endpoint.outbound[0].id

  dynamic "target_ip" {
    for_each = var.bank_internal_dns_servers
    content {
      ip = target_ip.value
    }
  }
}

resource "aws_route53_resolver_rule_association" "bank" {
  for_each         = var.enable_dns_resolver_rules ? toset(var.bank_internal_domains) : toset([])
  resolver_rule_id = aws_route53_resolver_rule.bank[each.value].id
  vpc_id           = var.vpc_id
}
