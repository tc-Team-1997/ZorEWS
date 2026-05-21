# Layer 05 — VPN to partner bank

**Phase:** T4-P1 (per [`docs/operationalization/execution-plans.md`](../../../docs/operationalization/execution-plans.md))
**Owner:** INT + SRE + bank-side network team
**Status:** Skeleton (placeholder bank inputs; populate during T4-P1)

> Site-to-Site VPN connection from the EWS VPC (`af-south-1`) to the partner bank's on-premise network. Active-active IPsec (2 tunnels) per `docs/dr-runbook.md` HA requirements.

## Prerequisites

1. **`10-network` applied** — VPC ID + private route table IDs required
2. **Bank network team provides** (during T4-P1 kickoff):
   - `customer_gateway_ip` — public IP of bank's CGW device
   - `customer_gateway_bgp_asn` — BGP ASN (typically 65000-65534 private range)
   - `bank_cidrs` — CIDR blocks owned by the bank (for routing)
   - `bank_internal_dns_servers` — bank DNS resolver IPs (for Route 53 forwarding)
   - `bank_internal_domains` — internal hostnames to forward (e.g. `cbs.bank.internal`)

## Apply sequence

```bash
# 1. Generate 2 PSKs (32-char hex), store in Secrets Manager
aws secretsmanager create-secret \
  --name apex-ews/prod/vpn/tunnel1-psk \
  --secret-string "$(openssl rand -hex 32)" \
  --kms-key-id alias/apex-ews-secrets

aws secretsmanager create-secret \
  --name apex-ews/prod/vpn/tunnel2-psk \
  --secret-string "$(openssl rand -hex 32)" \
  --kms-key-id alias/apex-ews-secrets

# 2. Apply with PSKs from Secrets Manager (DO NOT commit them)
export TF_VAR_tunnel1_preshared_key=$(aws secretsmanager get-secret-value \
  --secret-id apex-ews/prod/vpn/tunnel1-psk --query SecretString --output text)

export TF_VAR_tunnel2_preshared_key=$(aws secretsmanager get-secret-value \
  --secret-id apex-ews/prod/vpn/tunnel2-psk --query SecretString --output text)

export TF_VAR_customer_gateway_ip="x.x.x.x"   # from bank
export TF_VAR_bank_cidrs='["10.20.0.0/16","10.21.0.0/16"]'
export TF_VAR_vpc_id="$(terraform -chdir=../10-network output -raw vpc_id)"
export TF_VAR_private_route_table_ids="$(terraform -chdir=../10-network output -json private_route_table_ids)"

terraform init
terraform plan
terraform apply
```

## Validation

```bash
# Check tunnel state — both should be UP
aws ec2 describe-vpn-connections --vpn-connection-ids \
  $(terraform output -raw vpn_connection_id) \
  --query 'VpnConnections[0].VgwTelemetry[].[OutsideIpAddress,Status]'
# Expected: 2 rows, both Status=UP

# BGP session check (after bank-side configures their device)
# (look at tunnel logs in /apex-ews/prod/vpn log group)
aws logs tail /apex-ews/prod/vpn --since 10m | grep BGP
```

## Validation gate (T4-P1)

- `aws ec2 describe-vpn-connections` shows 2 tunnels Status=UP
- BGP peering established with bank-side device
- `traceroute cbs.bank.internal` from a BFF pod resolves over VPN
- Bank's network ops signs off on both tunnel BGP sessions in writing
- CloudWatch alarm `BothVpnTunnelsDown` quiet for 24h

## Rollback

```bash
# Disable VPN routes (preserves config; allows rapid re-enable)
terraform apply -var='enable_dns_resolver_rules=false'

# BFF falls back to mock integrations via env-flag:
kubectl set env deployment/bff INTEGRATIONS_MODE=mock -n apex-ews
```

Full teardown: `terraform destroy` — affects `customer_gateway`, `vpn_connection`, route propagations, CloudWatch log group. ~5 min destruction time.

## Cost

- VPN connection: $0.05/hr × 24 × 30 = $36/mo
- Data transfer outbound to bank: ~$0.09/GB (estimated <100GB/mo = $9/mo)
- CloudWatch logs (90d retention): negligible
- **Total: ~$50/mo**

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| MTU mismatch causes tunnel flap every 2-4h | Set `tunnel_mtu=1380` (default); bank-side device must mirror. CloudWatch alarm fires on flap. |
| BGP ASN collision with bank | AWS side uses 64512 by default; coordinate with bank to pick non-overlapping ASN |
| Both tunnels DOWN simultaneously | CloudWatch alarm `BothVpnTunnelsDown` (P0 paging); BFF falls back to mock via env-flag |
| PSK leak | Stored in Secrets Manager + KMS-encrypted; never written to terraform.tfstate (sensitive=true); rotated quarterly per BAU runbook |
| Bank-side device fails | Standard SLA in SoW with bank; secondary tunnel takes 100% of traffic |
