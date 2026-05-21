###############################################################################
# Account baseline — Config + GuardDuty + Security Hub + Tag Policy +
# additional SCPs (deny-root, require-MFA, deny-CloudTrail-disable).
#
# Applied AFTER the Org + initial SCPs in main.tf. Run order:
#   terraform apply -target=aws_organizations_organization.this
#   terraform apply       # everything else
#
# Owner: SRE-lead + CISO. Operationalization phase: T1-P2.
###############################################################################

###############################################################################
# Additional Service Control Policies (defence-in-depth)
###############################################################################

# Deny root account usage org-wide (root should only be used for break-glass)
data "aws_iam_policy_document" "deny_root" {
  statement {
    sid       = "DenyRootAccountUsage"
    effect    = "Deny"
    actions   = ["*"]
    resources = ["*"]

    condition {
      test     = "StringLike"
      variable = "aws:PrincipalArn"
      values   = ["arn:aws:iam::*:root"]
    }
  }
}

resource "aws_organizations_policy" "deny_root" {
  name        = "${var.name_prefix}-deny-root"
  description = "Deny all actions from the AWS account root user (break-glass via assume-role only)"
  type        = "SERVICE_CONTROL_POLICY"
  content     = data.aws_iam_policy_document.deny_root.json
}

resource "aws_organizations_policy_attachment" "deny_root_workloads" {
  for_each  = toset(var.org_member_ous)
  policy_id = aws_organizations_policy.deny_root.id
  target_id = aws_organizations_organizational_unit.ou[each.value].id
}

# Deny disabling CloudTrail, Config, or GuardDuty
data "aws_iam_policy_document" "protect_security_services" {
  statement {
    sid    = "DenyCloudTrailDisable"
    effect = "Deny"
    actions = [
      "cloudtrail:DeleteTrail",
      "cloudtrail:StopLogging",
      "cloudtrail:UpdateTrail",
      "cloudtrail:PutEventSelectors",
    ]
    resources = ["*"]

    condition {
      test     = "StringNotEquals"
      variable = "aws:PrincipalARN"
      values   = ["arn:aws:iam::*:role/${var.name_prefix}-security-admin"]
    }
  }

  statement {
    sid    = "DenyConfigDisable"
    effect = "Deny"
    actions = [
      "config:DeleteConfigurationRecorder",
      "config:DeleteDeliveryChannel",
      "config:StopConfigurationRecorder",
    ]
    resources = ["*"]

    condition {
      test     = "StringNotEquals"
      variable = "aws:PrincipalARN"
      values   = ["arn:aws:iam::*:role/${var.name_prefix}-security-admin"]
    }
  }

  statement {
    sid    = "DenyGuardDutyDisable"
    effect = "Deny"
    actions = [
      "guardduty:DeleteDetector",
      "guardduty:DisassociateMembers",
      "guardduty:UpdateDetector",
    ]
    resources = ["*"]

    condition {
      test     = "StringNotEquals"
      variable = "aws:PrincipalARN"
      values   = ["arn:aws:iam::*:role/${var.name_prefix}-security-admin"]
    }
  }
}

resource "aws_organizations_policy" "protect_security_services" {
  name        = "${var.name_prefix}-protect-security-services"
  description = "Prevent disabling CloudTrail / Config / GuardDuty except via security-admin break-glass role"
  type        = "SERVICE_CONTROL_POLICY"
  content     = data.aws_iam_policy_document.protect_security_services.json
}

resource "aws_organizations_policy_attachment" "protect_security_workloads" {
  for_each  = toset(var.org_member_ous)
  policy_id = aws_organizations_policy.protect_security_services.id
  target_id = aws_organizations_organizational_unit.ou[each.value].id
}

# Require MFA for IAM actions (defence vs stolen access keys)
data "aws_iam_policy_document" "require_mfa_for_iam" {
  statement {
    sid    = "DenyIamWithoutMFA"
    effect = "Deny"
    actions = [
      "iam:CreateAccessKey",
      "iam:DeleteAccessKey",
      "iam:UpdateAccessKey",
      "iam:CreateLoginProfile",
      "iam:UpdateLoginProfile",
      "iam:DeleteVirtualMFADevice",
      "iam:DeactivateMFADevice",
    ]
    resources = ["*"]

    condition {
      test     = "BoolIfExists"
      variable = "aws:MultiFactorAuthPresent"
      values   = ["false"]
    }
  }
}

resource "aws_organizations_policy" "require_mfa_for_iam" {
  name        = "${var.name_prefix}-require-mfa-iam"
  description = "Require MFA for sensitive IAM operations"
  type        = "SERVICE_CONTROL_POLICY"
  content     = data.aws_iam_policy_document.require_mfa_for_iam.json
}

resource "aws_organizations_policy_attachment" "require_mfa_workloads" {
  for_each  = toset(var.org_member_ous)
  policy_id = aws_organizations_policy.require_mfa_for_iam.id
  target_id = aws_organizations_organizational_unit.ou[each.value].id
}

###############################################################################
# Tag Policy — every taggable resource MUST carry cost-center + environment
###############################################################################

resource "aws_organizations_policy" "tag_policy" {
  name        = "${var.name_prefix}-tag-policy"
  description = "Mandatory cost-center + environment tags on all resources"
  type        = "TAG_POLICY"

  content = jsonencode({
    tags = {
      cost-center = {
        tag_key = {
          "@@assign" = "cost-center"
        }
        tag_value = {
          "@@assign" = ["risk-it", "shared-platform", "data-platform", "ml-platform", "loadtest"]
        }
        enforced_for = {
          "@@assign" = [
            "ec2:instance",
            "ec2:volume",
            "rds:db",
            "rds:cluster",
            "s3:bucket",
            "ecs:cluster",
            "eks:cluster",
            "kafka:cluster",
          ]
        }
      }
      environment = {
        tag_key = {
          "@@assign" = "environment"
        }
        tag_value = {
          "@@assign" = ["dev", "staging", "prod", "loadtest", "dr"]
        }
        enforced_for = {
          "@@assign" = [
            "ec2:instance",
            "ec2:volume",
            "rds:db",
            "rds:cluster",
            "s3:bucket",
            "eks:cluster",
            "kafka:cluster",
          ]
        }
      }
    }
  })
}

resource "aws_organizations_policy_attachment" "tag_policy_workloads" {
  for_each  = toset(var.org_member_ous)
  policy_id = aws_organizations_policy.tag_policy.id
  target_id = aws_organizations_organizational_unit.ou[each.value].id
}

###############################################################################
# AWS Config — continuous compliance recording
###############################################################################

resource "aws_iam_role" "config" {
  name = "${var.name_prefix}-aws-config"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "config.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = {
    cost-center = "risk-it"
    environment = "prod"
  }
}

resource "aws_iam_role_policy_attachment" "config" {
  role       = aws_iam_role.config.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWS_ConfigRole"
}

resource "aws_s3_bucket" "config" {
  bucket        = "${var.name_prefix}-aws-config-${data.aws_caller_identity.current.account_id}"
  force_destroy = false

  tags = {
    cost-center = "risk-it"
    environment = "prod"
    purpose     = "aws-config-compliance"
  }
}

resource "aws_s3_bucket_versioning" "config" {
  bucket = aws_s3_bucket.config.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "config" {
  bucket = aws_s3_bucket.config.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.cmk["s3"].arn
    }
  }
}

resource "aws_s3_bucket_public_access_block" "config" {
  bucket                  = aws_s3_bucket.config.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_config_configuration_recorder" "this" {
  count    = var.enable_aws_config ? 1 : 0
  name     = "${var.name_prefix}-config-recorder"
  role_arn = aws_iam_role.config.arn

  recording_group {
    all_supported                 = true
    include_global_resource_types = true
  }
}

resource "aws_config_delivery_channel" "this" {
  count          = var.enable_aws_config ? 1 : 0
  name           = "${var.name_prefix}-delivery-channel"
  s3_bucket_name = aws_s3_bucket.config.bucket

  snapshot_delivery_properties {
    delivery_frequency = "TwentyFour_Hours"
  }

  depends_on = [aws_config_configuration_recorder.this]
}

resource "aws_config_configuration_recorder_status" "this" {
  count      = var.enable_aws_config ? 1 : 0
  name       = aws_config_configuration_recorder.this[0].name
  is_enabled = true
  depends_on = [aws_config_delivery_channel.this]
}

###############################################################################
# GuardDuty — continuous threat detection
###############################################################################

resource "aws_guardduty_detector" "this" {
  count                        = var.enable_guardduty ? 1 : 0
  enable                       = true
  finding_publishing_frequency = "FIFTEEN_MINUTES"

  datasources {
    s3_logs { enable = true }
    kubernetes {
      audit_logs { enable = true }
    }
    malware_protection {
      scan_ec2_instance_with_findings {
        ebs_volumes { enable = true }
      }
    }
  }

  tags = {
    cost-center = "risk-it"
    environment = "prod"
  }
}

###############################################################################
# Security Hub — compliance posture aggregator (CIS + AWS FSBP + PCI optional)
###############################################################################

resource "aws_securityhub_account" "this" {
  count                     = var.enable_security_hub ? 1 : 0
  enable_default_standards  = true
  control_finding_generator = "SECURITY_CONTROL"
  auto_enable_controls      = true
}

resource "aws_securityhub_standards_subscription" "cis" {
  count         = var.enable_security_hub ? 1 : 0
  standards_arn = "arn:aws:securityhub:${var.primary_region}::standards/aws-foundational-security-best-practices/v/1.0.0"
  depends_on    = [aws_securityhub_account.this]
}

resource "aws_securityhub_standards_subscription" "fsbp" {
  count         = var.enable_security_hub ? 1 : 0
  standards_arn = "arn:aws:securityhub:${var.primary_region}::standards/cis-aws-foundations-benchmark/v/1.4.0"
  depends_on    = [aws_securityhub_account.this]
}

###############################################################################
# IAM baseline — deploy + readonly + break-glass roles
###############################################################################

# Cross-account deploy role (assumed by GitHub Actions OIDC)
data "aws_iam_policy_document" "deploy_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/token.actions.githubusercontent.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "repo:tc-Team-1997/ZorEWS:ref:refs/heads/main",
        "repo:tc-Team-1997/ZorEWS:environment:production",
      ]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name               = "${var.name_prefix}-deploy"
  description        = "Assumed by GitHub Actions OIDC for production deploys (gated on environment:production)"
  assume_role_policy = data.aws_iam_policy_document.deploy_trust.json

  tags = {
    cost-center = "risk-it"
    environment = "prod"
  }
}

# Read-only role for on-call diagnostics
data "aws_iam_policy_document" "readonly_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
    condition {
      test     = "Bool"
      variable = "aws:MultiFactorAuthPresent"
      values   = ["true"]
    }
  }
}

resource "aws_iam_role" "readonly" {
  name               = "${var.name_prefix}-readonly"
  description        = "Read-only access for on-call diagnostics. MFA required."
  assume_role_policy = data.aws_iam_policy_document.readonly_trust.json
  tags               = { cost-center = "risk-it", environment = "prod" }
}

resource "aws_iam_role_policy_attachment" "readonly" {
  role       = aws_iam_role.readonly.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

# Security-admin role (the only role that can disable security services via SCPs)
resource "aws_iam_role" "security_admin" {
  name        = "${var.name_prefix}-security-admin"
  description = "Break-glass role for security service management. CISO + SRE-lead only."

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
      }
      Action = "sts:AssumeRole"
      Condition = {
        Bool = { "aws:MultiFactorAuthPresent" = "true" }
        StringEquals = { "aws:RequestTag/break-glass-justification" = "approved" }
      }
    }]
  })

  max_session_duration = 3600 # 1h cap on break-glass sessions

  tags = { cost-center = "risk-it", environment = "prod" }
}
