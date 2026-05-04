# 10-network

Three-tier VPC in `af-south-1`:

- `10.0.0.0/16` VPC.
- 3 AZs × 3 tiers = 9 subnets.
  - **public** (`/22`) — ALB / NAT EIPs only.
  - **private** (`/20`) — EKS worker nodes + microservices.
  - **data** (`/22`) — Aurora, ElastiCache, MSK; isolated route table, no NAT.
- 1 NAT/AZ for HA and to minimise cross-AZ data charges.
- VPC Flow Logs to CloudWatch (365-day retention) — feeds NFR-OBS + DPA breach forensics.
- Gateway endpoint for S3 to keep traffic off NAT.

Subnet IDs are exposed via `outputs.tf` for the EKS and data layers.
