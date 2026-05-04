# 40-edge

Public ingress + edge security.

- Route53 hosted zone for `apex-ews.example.co.ke`.
- ACM certificates: regional (ALB, `af-south-1`) and CloudFront (`us-east-1`).
- WAF v2 ACLs:
  - Regional (ALB): AWS Common managed rules + 2000 req/5min IP rate limit.
  - CloudFront: AWS Common managed rules.
- Public ALB (drop_invalid_header_fields, deletion protection).
- CloudFront distribution for the SPA, S3 origin via OAC, TLS 1.2_2021 minimum.
- Optional Shield Advanced toggle (defaults to off for prototype cost).

The ALB is the single ingress for the API surface and is consumed by the EKS AWS Load Balancer Controller via shared SG when wired in `infra/k8s/`.
