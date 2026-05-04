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
