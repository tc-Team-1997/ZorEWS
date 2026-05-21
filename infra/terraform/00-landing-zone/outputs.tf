output "organization_id" {
  description = "AWS Organizations ID."
  value       = aws_organizations_organization.this.id
}

output "ou_ids" {
  description = "Map of OU name -> id."
  value       = { for k, v in aws_organizations_organizational_unit.ou : k => v.id }
}

output "kms_key_arns" {
  description = "Map of CMK alias -> ARN."
  value       = { for k, v in aws_kms_key.cmk : k => v.arn }
}

output "cloudtrail_bucket" {
  description = "Org-wide CloudTrail bucket name."
  value       = aws_s3_bucket.cloudtrail.id
}

output "config_bucket" {
  description = "AWS Config bucket name."
  value       = aws_s3_bucket.config.id
}

output "deploy_role_arn" {
  description = "Role assumed by GitHub Actions OIDC for production deploys."
  value       = aws_iam_role.deploy.arn
}

output "readonly_role_arn" {
  description = "Role for on-call diagnostics (MFA required)."
  value       = aws_iam_role.readonly.arn
}

output "security_admin_role_arn" {
  description = "Break-glass role for security service management."
  value       = aws_iam_role.security_admin.arn
}
