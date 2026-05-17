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
