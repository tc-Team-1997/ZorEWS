###############################################################################
# Lookups for KMS aliases provisioned in 00-landing-zone
###############################################################################

data "aws_kms_alias" "aurora" {
  name = "alias/apex-ews-aurora"
}

data "aws_kms_alias" "s3" {
  name = "alias/apex-ews-s3"
}

data "aws_kms_alias" "msk" {
  name = "alias/apex-ews-msk"
}

resource "random_id" "suffix" {
  byte_length = 4
}

###############################################################################
# Aurora PostgreSQL 16 — Multi-AZ (writer + 2 readers across 3 AZs)
###############################################################################

resource "aws_db_subnet_group" "aurora" {
  name       = "apex-ews-${var.env}-aurora"
  subnet_ids = var.data_subnet_ids
}

resource "aws_security_group" "aurora" {
  name        = "apex-ews-${var.env}-aurora-sg"
  description = "Aurora PG access from EKS private subnets only."
  vpc_id      = var.vpc_id
}

resource "aws_security_group_rule" "aurora_ingress_eks" {
  type              = "ingress"
  from_port         = 5432
  to_port           = 5432
  protocol          = "tcp"
  security_group_id = aws_security_group.aurora.id
  cidr_blocks       = ["10.0.16.0/20", "10.0.32.0/20", "10.0.48.0/20"]
  description       = "PG from EKS private subnets."
}

resource "aws_rds_cluster" "aurora" {
  cluster_identifier                  = "apex-ews-${var.env}-aurora"
  engine                              = "aurora-postgresql"
  engine_version                      = var.aurora_engine_version
  database_name                       = "zorews"
  master_username                     = "zorews_user"
  manage_master_user_password         = true
  master_user_secret_kms_key_id       = data.aws_kms_alias.aurora.target_key_arn
  db_subnet_group_name                = aws_db_subnet_group.aurora.name
  vpc_security_group_ids              = [aws_security_group.aurora.id]
  storage_encrypted                   = true
  kms_key_id                          = data.aws_kms_alias.aurora.target_key_arn
  backup_retention_period             = 35
  preferred_backup_window             = "02:00-04:00"
  preferred_maintenance_window        = "sun:04:30-sun:05:30"
  deletion_protection                 = true
  copy_tags_to_snapshot               = true
  enabled_cloudwatch_logs_exports     = ["postgresql"]
  iam_database_authentication_enabled = true
}

resource "aws_rds_cluster_instance" "writer" {
  identifier           = "apex-ews-${var.env}-aurora-writer"
  cluster_identifier   = aws_rds_cluster.aurora.id
  engine               = aws_rds_cluster.aurora.engine
  engine_version       = aws_rds_cluster.aurora.engine_version
  instance_class       = var.aurora_writer_instance_class
  db_subnet_group_name = aws_db_subnet_group.aurora.name

  performance_insights_enabled    = true
  performance_insights_kms_key_id = data.aws_kms_alias.aurora.target_key_arn
}

resource "aws_rds_cluster_instance" "reader" {
  count                = var.aurora_reader_count
  identifier           = "apex-ews-${var.env}-aurora-reader-${count.index + 1}"
  cluster_identifier   = aws_rds_cluster.aurora.id
  engine               = aws_rds_cluster.aurora.engine
  engine_version       = aws_rds_cluster.aurora.engine_version
  instance_class       = var.aurora_writer_instance_class
  db_subnet_group_name = aws_db_subnet_group.aurora.name

  performance_insights_enabled    = true
  performance_insights_kms_key_id = data.aws_kms_alias.aurora.target_key_arn
}

###############################################################################
# ElastiCache Redis 7.2 — alert smart-queue + session cache
###############################################################################

resource "aws_elasticache_subnet_group" "redis" {
  name       = "apex-ews-${var.env}-redis"
  subnet_ids = var.data_subnet_ids
}

resource "aws_security_group" "redis" {
  name        = "apex-ews-${var.env}-redis-sg"
  description = "Redis access from EKS private subnets only."
  vpc_id      = var.vpc_id
}

resource "aws_security_group_rule" "redis_ingress_eks" {
  type              = "ingress"
  from_port         = 6379
  to_port           = 6379
  protocol          = "tcp"
  security_group_id = aws_security_group.redis.id
  cidr_blocks       = ["10.0.16.0/20", "10.0.32.0/20", "10.0.48.0/20"]
  description       = "Redis from EKS private subnets."
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id       = "apex-ews-${var.env}-redis"
  description                = "APEX EWS Redis 7.2 — alert smart-queue + session cache."
  engine                     = "redis"
  engine_version             = "7.2"
  node_type                  = var.redis_node_type
  num_node_groups            = 1
  replicas_per_node_group    = 2
  automatic_failover_enabled = true
  multi_az_enabled           = true
  port                       = 6379
  parameter_group_name       = "default.redis7"
  subnet_group_name          = aws_elasticache_subnet_group.redis.name
  security_group_ids         = [aws_security_group.redis.id]
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token_update_strategy = "ROTATE"
}

###############################################################################
# S3 buckets — audit (Object Lock), raw, curated
###############################################################################

resource "aws_s3_bucket" "audit" {
  bucket              = "apex-ews-${var.env}-audit-${random_id.suffix.hex}"
  object_lock_enabled = true
  force_destroy       = false
}

resource "aws_s3_bucket_versioning" "audit" {
  bucket = aws_s3_bucket.audit.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = data.aws_kms_alias.s3.target_key_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_object_lock_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id

  rule {
    default_retention {
      mode  = "COMPLIANCE"
      years = 7
    }
  }
}

resource "aws_s3_bucket_public_access_block" "audit" {
  bucket                  = aws_s3_bucket.audit.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket" "raw" {
  bucket        = "apex-ews-${var.env}-raw-${random_id.suffix.hex}"
  force_destroy = false
}

resource "aws_s3_bucket_versioning" "raw" {
  bucket = aws_s3_bucket.raw.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "raw" {
  bucket = aws_s3_bucket.raw.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = data.aws_kms_alias.s3.target_key_arn
    }
  }
}

resource "aws_s3_bucket_public_access_block" "raw" {
  bucket                  = aws_s3_bucket.raw.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket" "curated" {
  bucket        = "apex-ews-${var.env}-curated-${random_id.suffix.hex}"
  force_destroy = false
}

resource "aws_s3_bucket_versioning" "curated" {
  bucket = aws_s3_bucket.curated.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "curated" {
  bucket = aws_s3_bucket.curated.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = data.aws_kms_alias.s3.target_key_arn
    }
  }
}

resource "aws_s3_bucket_public_access_block" "curated" {
  bucket                  = aws_s3_bucket.curated.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

###############################################################################
# MSK — 3-broker Kafka 3.6
###############################################################################

resource "aws_security_group" "msk" {
  name        = "apex-ews-${var.env}-msk-sg"
  description = "MSK broker SG — access from EKS private subnets only."
  vpc_id      = var.vpc_id
}

resource "aws_security_group_rule" "msk_ingress_eks" {
  type              = "ingress"
  from_port         = 9092
  to_port           = 9098
  protocol          = "tcp"
  security_group_id = aws_security_group.msk.id
  cidr_blocks       = ["10.0.16.0/20", "10.0.32.0/20", "10.0.48.0/20"]
  description       = "MSK from EKS private subnets (TLS + IAM)."
}

resource "aws_cloudwatch_log_group" "msk" {
  name              = "/apex-ews/${var.env}/msk/broker"
  retention_in_days = 90
}

resource "aws_msk_configuration" "this" {
  name              = "apex-ews-${var.env}-msk-cfg"
  kafka_versions    = [var.msk_kafka_version]
  server_properties = <<-EOT
    auto.create.topics.enable=false
    default.replication.factor=3
    min.insync.replicas=2
    num.partitions=6
    log.retention.hours=168
    unclean.leader.election.enable=false
  EOT
}

resource "aws_msk_cluster" "this" {
  cluster_name           = "apex-ews-${var.env}-msk"
  kafka_version          = var.msk_kafka_version
  number_of_broker_nodes = 3

  broker_node_group_info {
    instance_type   = var.msk_broker_instance_type
    client_subnets  = var.data_subnet_ids
    security_groups = [aws_security_group.msk.id]

    storage_info {
      ebs_storage_info {
        volume_size = 1000
      }
    }
  }

  encryption_info {
    encryption_at_rest_kms_key_arn = data.aws_kms_alias.msk.target_key_arn
    encryption_in_transit {
      client_broker = "TLS"
      in_cluster    = true
    }
  }

  client_authentication {
    sasl {
      iam = true
    }
    tls {}
  }

  configuration_info {
    arn      = aws_msk_configuration.this.arn
    revision = aws_msk_configuration.this.latest_revision
  }

  logging_info {
    broker_logs {
      cloudwatch_logs {
        enabled   = true
        log_group = aws_cloudwatch_log_group.msk.name
      }
    }
  }
}

###############################################################################
# Glue Schema Registry — APEX EWS Kafka contracts (T3.8)
#
# Source-of-truth JSON Schema files live in `infra/schema-registry/` and are
# version-checked for BACKWARD compatibility on every PR by
# `.github/workflows/schema-compat.yml`. The CI guarantee is what gives this
# registry its compatibility-mode promise; the resource below is the runtime
# half — Kafka producers + consumers consult the registry over IAM-auth.
###############################################################################

resource "aws_glue_registry" "zorews" {
  registry_name = "apex-ews-${var.env}"
  description   = "ZorEWS canonical event contracts. Schemas registered here mirror infra/schema-registry/*.json with BACKWARD compatibility enforced in CI."

  tags = {
    project = "apex-ews"
    env     = var.env
    layer   = "30-data"
  }
}

# Each schema file under infra/schema-registry/ is registered as a single
# AWS Glue schema with compatibility mode = BACKWARD. We keep the AWS schema
# name = the file's `title` field so Kafka clients can reference the canonical
# topic name directly.
locals {
  registry_schema_files = fileset("${path.module}/../../schema-registry", "*.json")

  # Read each file once and parse the title for the AWS schema name.
  registry_schemas = {
    for f in local.registry_schema_files :
    jsondecode(file("${path.module}/../../schema-registry/${f}")).title => {
      file_path = "${path.module}/../../schema-registry/${f}"
      content   = file("${path.module}/../../schema-registry/${f}")
    }...
  }
}

# Pick the latest version of each topic's file for the initial registration —
# subsequent versions are uploaded by CI as new revisions of the same schema.
resource "aws_glue_schema" "topics" {
  for_each = {
    for title, files in local.registry_schemas :
    title => files[length(files) - 1]
  }

  registry_arn      = aws_glue_registry.zorews.arn
  schema_name       = each.key
  data_format       = "JSON"
  compatibility     = "BACKWARD"
  schema_definition = each.value.content
  description       = "Registered from ${basename(each.value.file_path)}. CI in .github/workflows/schema-compat.yml gates BACKWARD compatibility on every PR."

  tags = {
    project = "apex-ews"
    env     = var.env
  }
}
