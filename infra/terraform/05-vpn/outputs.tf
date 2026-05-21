output "vpn_connection_id" {
  description = "VPN connection ID."
  value       = aws_vpn_connection.bank.id
}

output "tunnel1_address" {
  description = "Public IP of tunnel 1 (provided to bank network team)."
  value       = aws_vpn_connection.bank.tunnel1_address
}

output "tunnel2_address" {
  description = "Public IP of tunnel 2 (provided to bank network team)."
  value       = aws_vpn_connection.bank.tunnel2_address
}

output "customer_gateway_id" {
  description = "Customer gateway ID."
  value       = aws_customer_gateway.bank.id
}

output "vpn_log_group" {
  description = "CloudWatch log group for VPN tunnel logs."
  value       = aws_cloudwatch_log_group.vpn.name
}
