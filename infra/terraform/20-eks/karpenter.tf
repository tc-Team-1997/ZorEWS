###############################################################################
# T4.4 — Karpenter for ZorEWS EKS cluster
#
# Karpenter replaces the manually-scaled `aws_eks_node_group` resources with
# just-in-time node provisioning driven by unscheduled Pod resource requests.
# Compared to cluster-autoscaler:
#   - Per-Pod node selection (cheaper instance type fit per workload).
#   - Spot-instance fleet by default for non-critical workloads.
#   - Faster scale-out (no Auto Scaling Group cool-down).
#
# This file provisions Karpenter's IAM prerequisites:
#   1. KarpenterController IRSA role (controller pod assumes it).
#   2. KarpenterNode role + instance profile (worker nodes assume it).
#   3. SQS interruption queue (spot-termination + scheduled maintenance).
#
# The Karpenter controller itself + EC2NodeClass + NodePool resources are
# deployed via Helm + kubectl from `infra/k8s/karpenter/` (kept out of
# Terraform to keep the chart upgrade path simple).
#
# Activation: `var.enable_karpenter` (default false) so existing
# `terraform plan` on the 20-eks layer doesn't require new arguments. When
# true, the controller can spin up replacement capacity; the manual node
# groups can then be scaled to a minimal floor.
###############################################################################

###############################################################################
# Interruption queue — receives spot-termination + ASG re-balance signals.
###############################################################################

resource "aws_sqs_queue" "karpenter_interruption" {
  count = var.enable_karpenter ? 1 : 0

  name                      = "apex-ews-${var.env}-karpenter"
  message_retention_seconds = 300
  sqs_managed_sse_enabled   = true
}

# EventBridge rules forwarding spot-interruption + ASG re-balance + scheduled
# maintenance events into the queue. Karpenter consumes these to gracefully
# drain affected nodes.
resource "aws_cloudwatch_event_rule" "karpenter_spot_interruption" {
  count = var.enable_karpenter ? 1 : 0

  name        = "apex-ews-${var.env}-karpenter-spot"
  description = "Spot-instance interruption warning for Karpenter."

  event_pattern = jsonencode({
    source      = ["aws.ec2"]
    detail-type = ["EC2 Spot Instance Interruption Warning"]
  })
}

resource "aws_cloudwatch_event_target" "karpenter_spot_target" {
  count = var.enable_karpenter ? 1 : 0

  rule = aws_cloudwatch_event_rule.karpenter_spot_interruption[0].name
  arn  = aws_sqs_queue.karpenter_interruption[0].arn
}

resource "aws_cloudwatch_event_rule" "karpenter_rebalance" {
  count = var.enable_karpenter ? 1 : 0

  name        = "apex-ews-${var.env}-karpenter-rebalance"
  description = "EC2 instance re-balance recommendation."

  event_pattern = jsonencode({
    source      = ["aws.ec2"]
    detail-type = ["EC2 Instance Rebalance Recommendation"]
  })
}

resource "aws_cloudwatch_event_target" "karpenter_rebalance_target" {
  count = var.enable_karpenter ? 1 : 0

  rule = aws_cloudwatch_event_rule.karpenter_rebalance[0].name
  arn  = aws_sqs_queue.karpenter_interruption[0].arn
}

# SQS policy allowing EventBridge to deliver.
resource "aws_sqs_queue_policy" "karpenter_interruption" {
  count = var.enable_karpenter ? 1 : 0

  queue_url = aws_sqs_queue.karpenter_interruption[0].url
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = ["events.amazonaws.com", "sqs.amazonaws.com"] }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.karpenter_interruption[0].arn
    }]
  })
}

###############################################################################
# KarpenterController IRSA role — assumed by the controller pod.
###############################################################################

data "aws_iam_policy_document" "karpenter_controller_assume" {
  count = var.enable_karpenter ? 1 : 0

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    effect  = "Allow"

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.this.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${replace(aws_iam_openid_connect_provider.this.url, "https://", "")}:sub"
      values   = ["system:serviceaccount:karpenter:karpenter"]
    }

    condition {
      test     = "StringEquals"
      variable = "${replace(aws_iam_openid_connect_provider.this.url, "https://", "")}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "karpenter_controller" {
  count = var.enable_karpenter ? 1 : 0

  name               = "apex-ews-${var.env}-karpenter-controller"
  assume_role_policy = data.aws_iam_policy_document.karpenter_controller_assume[0].json
}

resource "aws_iam_role_policy" "karpenter_controller" {
  count = var.enable_karpenter ? 1 : 0

  name = "apex-ews-${var.env}-karpenter-controller-policy"
  role = aws_iam_role.karpenter_controller[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # EC2 fleet + spot + instance lifecycle.
      {
        Effect = "Allow"
        Action = [
          "ec2:CreateFleet",
          "ec2:CreateLaunchTemplate",
          "ec2:CreateTags",
          "ec2:DeleteLaunchTemplate",
          "ec2:DescribeAvailabilityZones",
          "ec2:DescribeImages",
          "ec2:DescribeInstances",
          "ec2:DescribeInstanceTypeOfferings",
          "ec2:DescribeInstanceTypes",
          "ec2:DescribeLaunchTemplates",
          "ec2:DescribeSecurityGroups",
          "ec2:DescribeSpotPriceHistory",
          "ec2:DescribeSubnets",
          "ec2:RunInstances",
          "ec2:TerminateInstances",
        ]
        Resource = "*"
      },
      # SQS interruption queue.
      {
        Effect = "Allow"
        Action = [
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
          "sqs:GetQueueUrl",
          "sqs:ReceiveMessage",
        ]
        Resource = aws_sqs_queue.karpenter_interruption[0].arn
      },
      # IAM: pass the node role to launched instances.
      {
        Effect = "Allow"
        Action = "iam:PassRole"
        Resource = aws_iam_role.node.arn
      },
      # EKS cluster discovery.
      {
        Effect = "Allow"
        Action = [
          "eks:DescribeCluster",
          "pricing:GetProducts",
        ]
        Resource = "*"
      },
      # SSM for AMI lookups.
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = "arn:aws:ssm:*::parameter/aws/service/eks/optimized-ami/*"
      },
    ]
  })
}

###############################################################################
# KarpenterNode instance profile — attached to nodes Karpenter launches.
# Reuses the existing `aws_iam_role.node` (already has worker + CNI + ECR + SSM).
###############################################################################

resource "aws_iam_instance_profile" "karpenter_node" {
  count = var.enable_karpenter ? 1 : 0

  name = "apex-ews-${var.env}-karpenter-node"
  role = aws_iam_role.node.name
}
