###############################################################################
# External Secrets Operator — IRSA role (T3-P3).
#
# Allows the ESO controller pod (ServiceAccount external-secrets/external-secrets)
# to read from AWS Secrets Manager via OIDC web identity. KMS-Decrypt scoped
# to apex-ews-secrets CMK only.
#
# Consumed by scripts/bootstrap-cluster.sh:
#   ESO_ROLE_ARN=$(terraform -chdir=20-eks output -raw external_secrets_role_arn)
###############################################################################

data "aws_iam_policy_document" "eso_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.this.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${replace(aws_iam_openid_connect_provider.this.url, "https://", "")}:sub"
      values   = ["system:serviceaccount:external-secrets:external-secrets"]
    }

    condition {
      test     = "StringEquals"
      variable = "${replace(aws_iam_openid_connect_provider.this.url, "https://", "")}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "eso" {
  name               = "apex-ews-${var.env}-external-secrets"
  assume_role_policy = data.aws_iam_policy_document.eso_assume.json

  tags = {
    Name = "apex-ews-${var.env}-external-secrets"
  }
}

data "aws_iam_policy_document" "eso_secrets_read" {
  statement {
    sid    = "ReadApexEwsSecrets"
    effect = "Allow"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
      "secretsmanager:ListSecretVersionIds",
    ]
    resources = [
      "arn:aws:secretsmanager:${var.region}:*:secret:apex-ews/${var.env}/*",
    ]
  }

  statement {
    sid       = "ListAllSecrets"
    effect    = "Allow"
    actions   = ["secretsmanager:ListSecrets"]
    resources = ["*"]
  }

  statement {
    sid     = "DecryptViaSecretsManagerKMS"
    effect  = "Allow"
    actions = ["kms:Decrypt", "kms:DescribeKey"]
    resources = [
      var.secrets_kms_key_arn,
    ]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_policy" "eso" {
  name        = "apex-ews-${var.env}-external-secrets"
  description = "Read apex-ews/<env>/* secrets via the secrets-manager KMS key"
  policy      = data.aws_iam_policy_document.eso_secrets_read.json
}

resource "aws_iam_role_policy_attachment" "eso" {
  role       = aws_iam_role.eso.name
  policy_arn = aws_iam_policy.eso.arn
}
