###############################################################################
# AWS Organizations
###############################################################################

resource "aws_organizations_organization" "this" {
  feature_set = "ALL"

  aws_service_access_principals = [
    "cloudtrail.amazonaws.com",
    "config.amazonaws.com",
    "guardduty.amazonaws.com",
    "securityhub.amazonaws.com",
    "sso.amazonaws.com",
  ]

  enabled_policy_types = [
    "SERVICE_CONTROL_POLICY",
    "TAG_POLICY",
  ]
}

resource "aws_organizations_organizational_unit" "ou" {
  for_each  = toset(var.org_member_ous)
  name      = each.value
  parent_id = aws_organizations_organization.this.roots[0].id
}

###############################################################################
# Service Control Policies
###############################################################################

data "aws_iam_policy_document" "deny_non_allowed_regions" {
  statement {
    sid    = "DenyAllOutsideAllowedRegions"
    effect = "Deny"

    not_actions = [
      "iam:*",
      "organizations:*",
      "route53:*",
      "cloudfront:*",
      "waf:*",
      "wafv2:*",
      "shield:*",
      "support:*",
      "sts:*",
      "budgets:*",
    ]

    resources = ["*"]

    condition {
      test     = "StringNotEquals"
      variable = "aws:RequestedRegion"
      values   = var.allowed_regions
    }
  }
}

resource "aws_organizations_policy" "deny_non_allowed_regions" {
  name        = "apex-ews-deny-non-allowed-regions"
  description = "Deny all service calls outside af-south-1 / eu-west-1 (DR)."
  type        = "SERVICE_CONTROL_POLICY"
  content     = data.aws_iam_policy_document.deny_non_allowed_regions.json
}

resource "aws_organizations_policy_attachment" "deny_regions_workloads" {
  policy_id = aws_organizations_policy.deny_non_allowed_regions.id
  target_id = aws_organizations_organizational_unit.ou["Workloads"].id
}

# Require encrypted S3 / EBS / RDS
data "aws_iam_policy_document" "require_encryption" {
  statement {
    sid       = "DenyUnencryptedS3PutObject"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["*"]

    condition {
      test     = "StringNotEqualsIfExists"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms", "AES256"]
    }
  }

  statement {
    sid       = "DenyUnencryptedEBS"
    effect    = "Deny"
    actions   = ["ec2:RunInstances"]
    resources = ["arn:aws:ec2:*:*:volume/*"]

    condition {
      test     = "Bool"
      variable = "ec2:Encrypted"
      values   = ["false"]
    }
  }
}

resource "aws_organizations_policy" "require_encryption" {
  name        = "apex-ews-require-encryption"
  description = "Deny unencrypted S3 puts and unencrypted EBS volumes."
  type        = "SERVICE_CONTROL_POLICY"
  content     = data.aws_iam_policy_document.require_encryption.json
}

resource "aws_organizations_policy_attachment" "require_encryption_workloads" {
  policy_id = aws_organizations_policy.require_encryption.id
  target_id = aws_organizations_organizational_unit.ou["Workloads"].id
}

###############################################################################
# Customer Managed KMS keys
###############################################################################

locals {
  cmk_aliases = {
    aurora = "Encryption for Aurora PG (mart, audit, app schemas)."
    s3     = "Encryption for S3 audit + raw + curated buckets."
    msk    = "Encryption for MSK at-rest + in-transit."
    secret = "Encryption for Secrets Manager + JWT signing key material."
    ebs    = "Encryption for EBS root + data volumes (EKS nodes)."
  }
}

resource "aws_kms_key" "cmk" {
  for_each                = local.cmk_aliases
  description             = each.value
  deletion_window_in_days = 30
  enable_key_rotation     = true
  multi_region            = each.key == "aurora" || each.key == "s3"
}

resource "aws_kms_alias" "cmk" {
  for_each      = aws_kms_key.cmk
  name          = "alias/apex-ews-${each.key}"
  target_key_id = each.value.key_id
}

###############################################################################
# Org-wide CloudTrail
###############################################################################

resource "aws_s3_bucket" "cloudtrail" {
  bucket        = "apex-ews-cloudtrail-${var.env}"
  force_destroy = false
}

resource "aws_s3_bucket_versioning" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.cmk["s3"].arn
    }
  }
}

resource "aws_s3_bucket_public_access_block" "cloudtrail" {
  bucket                  = aws_s3_bucket.cloudtrail.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "cloudtrail_bucket" {
  statement {
    sid     = "AWSCloudTrailAclCheck"
    actions = ["s3:GetBucketAcl"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    resources = [aws_s3_bucket.cloudtrail.arn]
  }

  statement {
    sid     = "AWSCloudTrailWrite"
    actions = ["s3:PutObject"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    resources = ["${aws_s3_bucket.cloudtrail.arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"]

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }
  }
}

resource "aws_s3_bucket_policy" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id
  policy = data.aws_iam_policy_document.cloudtrail_bucket.json
}

resource "aws_cloudtrail" "org" {
  name                          = "apex-ews-org-trail"
  s3_bucket_name                = aws_s3_bucket.cloudtrail.id
  is_multi_region_trail         = true
  is_organization_trail         = true
  enable_log_file_validation    = true
  include_global_service_events = true
  kms_key_id                    = aws_kms_key.cmk["s3"].arn

  event_selector {
    read_write_type           = "All"
    include_management_events = true
  }

  depends_on = [aws_s3_bucket_policy.cloudtrail]
}
