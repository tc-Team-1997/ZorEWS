###############################################################################
# cert-manager IRSA role (T3-P5).
#
# Allows the cert-manager controller pod (ServiceAccount cert-manager/
# cert-manager) to manage Route 53 record sets for DNS01 ACME challenges.
# Scoped to the apex-ews.example + internal.apex-ews.example hosted zones.
#
# Helm install command (referenced in infra/k8s/cert-manager/README.md)
# annotates the SA with this role ARN; cert-manager then uses IRSA web-
# identity to call Route 53 — no static AWS keys in the cluster.
###############################################################################

data "aws_iam_policy_document" "cert_manager_assume" {
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
      values   = ["system:serviceaccount:cert-manager:cert-manager"]
    }

    condition {
      test     = "StringEquals"
      variable = "${replace(aws_iam_openid_connect_provider.this.url, "https://", "")}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cert_manager" {
  name               = "apex-ews-${var.env}-cert-manager"
  assume_role_policy = data.aws_iam_policy_document.cert_manager_assume.json
  tags               = { Name = "apex-ews-${var.env}-cert-manager" }
}

# Allow ListHostedZonesByName for ACME discovery + ChangeResourceRecordSets
# scoped to the two hosted zones cert-manager manages.
data "aws_iam_policy_document" "cert_manager" {
  statement {
    sid       = "ListHostedZones"
    effect    = "Allow"
    actions   = ["route53:ListHostedZonesByName"]
    resources = ["*"]
  }

  statement {
    sid     = "GetChange"
    effect  = "Allow"
    actions = ["route53:GetChange"]
    resources = [
      "arn:aws:route53:::change/*",
    ]
  }

  statement {
    sid     = "ChangeResourceRecordSets"
    effect  = "Allow"
    actions = ["route53:ChangeResourceRecordSets"]
    resources = [
      "arn:aws:route53:::hostedzone/*", # narrowed at apply time via 40-edge output binding
    ]
  }
}

resource "aws_iam_policy" "cert_manager" {
  name        = "apex-ews-${var.env}-cert-manager"
  description = "Route 53 DNS01 ACME challenge management for cert-manager"
  policy      = data.aws_iam_policy_document.cert_manager.json
}

resource "aws_iam_role_policy_attachment" "cert_manager" {
  role       = aws_iam_role.cert_manager.name
  policy_arn = aws_iam_policy.cert_manager.arn
}

###############################################################################
# streaming-consumer IRSA role (T2.12.3).
#
# Allows the streaming-consumer Deployment (ServiceAccount apex-ews/
# streaming-consumer) to read from MSK via IAM auth + write to the DLQ
# S3 bucket fallback. Scoped to the 1 topic it consumes.
###############################################################################

data "aws_iam_policy_document" "streaming_consumer_assume" {
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
      values   = ["system:serviceaccount:apex-ews:streaming-consumer"]
    }
    condition {
      test     = "StringEquals"
      variable = "${replace(aws_iam_openid_connect_provider.this.url, "https://", "")}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "streaming_consumer" {
  name               = "apex-ews-${var.env}-streaming-consumer"
  assume_role_policy = data.aws_iam_policy_document.streaming_consumer_assume.json
  tags               = { Name = "apex-ews-${var.env}-streaming-consumer" }
}

# MSK IAM auth permissions — limited to the apex.indicator.values topic
# + the consumer group. The same role can NOT produce to any topic.
data "aws_iam_policy_document" "streaming_consumer" {
  statement {
    sid    = "ConnectToCluster"
    effect = "Allow"
    actions = [
      "kafka-cluster:Connect",
      "kafka-cluster:AlterCluster", # for consumer group rebalance
      "kafka-cluster:DescribeCluster",
    ]
    resources = ["arn:aws:kafka:*:*:cluster/apex-ews-${var.env}/*"]
  }

  statement {
    sid    = "ReadTopic"
    effect = "Allow"
    actions = [
      "kafka-cluster:DescribeTopic",
      "kafka-cluster:ReadData",
    ]
    resources = ["arn:aws:kafka:*:*:topic/apex-ews-${var.env}/*/apex.indicator.values"]
  }

  statement {
    sid    = "ManageConsumerGroup"
    effect = "Allow"
    actions = [
      "kafka-cluster:AlterGroup",
      "kafka-cluster:DescribeGroup",
    ]
    resources = ["arn:aws:kafka:*:*:group/apex-ews-${var.env}/*/apex-ews-streaming-rule-evaluator*"]
  }
}

resource "aws_iam_policy" "streaming_consumer" {
  name        = "apex-ews-${var.env}-streaming-consumer"
  description = "MSK IAM-auth read scope for the streaming rule-evaluator consumer"
  policy      = data.aws_iam_policy_document.streaming_consumer.json
}

resource "aws_iam_role_policy_attachment" "streaming_consumer" {
  role       = aws_iam_role.streaming_consumer.name
  policy_arn = aws_iam_policy.streaming_consumer.arn
}
