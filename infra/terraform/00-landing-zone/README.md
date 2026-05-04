# 00-landing-zone

Provisions:

- AWS Organizations + 3 OUs (`Security`, `Workloads`, `Sandbox`).
- SCPs:
  - `apex-ews-deny-non-allowed-regions` (only `af-south-1` + `eu-west-1` permitted; global services excepted).
  - `apex-ews-require-encryption` (S3 PutObject must be SSE-KMS/AES256, EBS volumes must be encrypted).
- 5 multi-region-aware customer-managed KMS keys (aurora, s3, msk, secret, ebs).
- Org-wide CloudTrail with log-file validation, multi-region, KMS-encrypted, into versioned + locked S3 bucket.

Outputs feed `30-data/` (KMS), `10-network/` (none), and audit-svc (S3 ARNs).
