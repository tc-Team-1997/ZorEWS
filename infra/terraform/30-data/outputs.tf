output "aurora_writer_endpoint" {
  description = "Hostname for Aurora writer — consume in agent-data."
  value       = aws_rds_cluster.aurora.endpoint
}

output "aurora_reader_endpoint" {
  description = "Hostname for Aurora reader pool."
  value       = aws_rds_cluster.aurora.reader_endpoint
}

output "aurora_master_user_secret_arn" {
  description = "Secrets Manager ARN holding the master credentials."
  value       = aws_rds_cluster.aurora.master_user_secret[0].secret_arn
}

output "redis_primary_endpoint" {
  value = aws_elasticache_replication_group.redis.primary_endpoint_address
}

output "redis_reader_endpoint" {
  value = aws_elasticache_replication_group.redis.reader_endpoint_address
}

output "audit_bucket" {
  value = aws_s3_bucket.audit.id
}

output "audit_bucket_arn" {
  value = aws_s3_bucket.audit.arn
}

output "raw_bucket" {
  value = aws_s3_bucket.raw.id
}

output "curated_bucket" {
  value = aws_s3_bucket.curated.id
}

output "msk_cluster_arn" {
  value = aws_msk_cluster.this.arn
}

output "msk_bootstrap_brokers_sasl_iam" {
  value = aws_msk_cluster.this.bootstrap_brokers_sasl_iam
}

output "glue_schema_registry_arn" {
  description = "Glue Schema Registry holding the apex.* topic schemas."
  value       = aws_glue_registry.zorews.arn
}

output "glue_schema_arns" {
  description = "Topic-name → Glue schema ARN map."
  value       = { for k, v in aws_glue_schema.topics : k => v.arn }
}

###############################################################################
# T5.2 — multi-region DR outputs
###############################################################################

output "aurora_global_cluster_arn" {
  description = "ARN of the Aurora Global Cluster — consumed by the secondary-region 30-data application as global_cluster_identifier."
  value       = aws_rds_global_cluster.this.arn
}

output "aurora_global_cluster_identifier" {
  description = "Identifier (not ARN) of the Aurora Global Cluster."
  value       = aws_rds_global_cluster.this.global_cluster_identifier
}

output "s3_crr_iam_role_arn" {
  description = "IAM role assumed by S3 for cross-region replication."
  value       = aws_iam_role.s3_crr.arn
}

output "msk_mm2_iam_role_arn" {
  description = "IAM role assumed by MSK Connect for MirrorMaker 2 — kafkaconnect.amazonaws.com trust."
  value       = aws_iam_role.msk_mm2.arn
}

output "msk_mm2_log_group" {
  description = "CloudWatch log group receiving MM2 worker logs."
  value       = aws_cloudwatch_log_group.msk_mm2.name
}

###############################################################################
# T4.4 — Aurora autoscale + RDS Proxy outputs
###############################################################################

output "rds_proxy_endpoint" {
  description = "RDS Proxy endpoint — applications connect here instead of the cluster writer when proxy is enabled."
  value       = var.enable_aurora_autoscale ? aws_db_proxy.aurora[0].endpoint : null
}

output "rds_proxy_arn" {
  description = "ARN of the RDS Proxy resource."
  value       = var.enable_aurora_autoscale ? aws_db_proxy.aurora[0].arn : null
}

output "aurora_reader_autoscale_target_arn" {
  description = "ARN of the Application Auto Scaling target on the Aurora reader pool."
  value       = var.enable_aurora_autoscale ? aws_appautoscaling_target.aurora_reader[0].arn : null
}
