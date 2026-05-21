output "cluster_name" {
  value = aws_eks_cluster.this.name
}

output "cluster_endpoint" {
  value = aws_eks_cluster.this.endpoint
}

output "cluster_certificate_authority" {
  value     = aws_eks_cluster.this.certificate_authority[0].data
  sensitive = true
}

output "oidc_provider_arn" {
  value = aws_iam_openid_connect_provider.this.arn
}

output "irsa_role_arns" {
  description = "Map of service-account name -> IRSA role ARN."
  value       = { for k, v in aws_iam_role.irsa : k => v.arn }
}

###############################################################################
# T4.4 — Karpenter outputs (consumed by infra/k8s/karpenter/ Helm bootstrap)
###############################################################################

output "karpenter_controller_role_arn" {
  description = "ARN of the IRSA role the Karpenter controller pod assumes."
  value       = var.enable_karpenter ? aws_iam_role.karpenter_controller[0].arn : null
}

output "karpenter_node_instance_profile" {
  description = "Instance profile attached to nodes Karpenter launches."
  value       = var.enable_karpenter ? aws_iam_instance_profile.karpenter_node[0].name : null
}

output "karpenter_interruption_queue" {
  description = "SQS queue URL Karpenter polls for spot-interruption + ASG re-balance events."
  value       = var.enable_karpenter ? aws_sqs_queue.karpenter_interruption[0].url : null
}

output "external_secrets_role_arn" {
  description = "IRSA role ARN for the External Secrets Operator (consumed by scripts/bootstrap-cluster.sh)."
  value       = aws_iam_role.eso.arn
}
