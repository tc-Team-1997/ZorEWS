###############################################################################
# T5.2 — Aurora Global DB + S3 CRR + MSK MirrorMaker 2 (multi-region DR)
#
# Source-of-truth: docs/dr-runbook.md.
#
# Topology:
#   - Primary region (e.g. af-south-1) — provisioned by main.tf in this layer.
#   - Secondary region (var.secondary_region, default ap-south-1) — added here.
#
# Resources:
#   1. Aurora Global Cluster wrapping the primary cluster + headless secondary.
#   2. S3 Cross-Region Replication on audit + raw + curated buckets.
#   3. MSK MirrorMaker 2 connector — replicates topic-level data from primary
#      MSK cluster to a secondary MSK cluster (declared in the secondary
#      region's own 30-data Terraform application; this file produces the
#      connector definition only).
#
# RTO/RPO targets per docs/dr-runbook.md §1:
#   - Aurora: 15min/5min
#   - Audit S3: N/A/0 (CRR-synced)
#   - Raw + curated S3: 240min/15min
#   - MSK MM2 lag: <2min (per docs/slos.md tier-2)
###############################################################################

###############################################################################
# Secondary-region provider alias
###############################################################################

provider "aws" {
  alias  = "secondary"
  region = var.secondary_region

  default_tags {
    tags = {
      Project   = "apex-ews"
      Owner     = "agent-integration"
      ManagedBy = "terraform"
      Layer     = "30-data"
      Region    = "secondary"
    }
  }
}

###############################################################################
# Aurora Global Cluster
#
# `aws_rds_global_cluster` wraps the primary cluster created in main.tf and
# declares the topology. The secondary cluster is created within a SEPARATE
# Terraform application in the secondary region (it needs its own VPC + subnet
# group + security groups) — referenced here by ARN via the
# `aurora_secondary_cluster_arn` variable.
#
# When `aurora_secondary_cluster_arn` is null (default), only the global
# cluster wrapper is created — the secondary cluster joins later via
# `aws_rds_cluster_member` after the secondary region's stack is applied.
###############################################################################

resource "aws_rds_global_cluster" "this" {
  global_cluster_identifier    = "apex-ews-${var.env}-global"
  source_db_cluster_identifier = aws_rds_cluster.aurora.arn
  engine                       = aws_rds_cluster.aurora.engine
  engine_version               = aws_rds_cluster.aurora.engine_version
  storage_encrypted            = true
  deletion_protection          = true

  lifecycle {
    ignore_changes = [
      # Engine version is patched in-place by AWS; ignore drift to avoid
      # spurious replacement.
      engine_version,
    ]
  }
}

###############################################################################
# S3 Cross-Region Replication — audit bucket
#
# Object Lock COMPLIANCE mode applies in both regions. Replication preserves
# the lock metadata. KMS encryption uses the source KMS key for re-encryption
# at the destination (CRR re-encrypts in flight; destination must have its own
# KMS key with grant from the source key).
###############################################################################

# IAM role assumed by S3 to perform replication. Trust policy = s3 service.
resource "aws_iam_role" "s3_crr" {
  name = "apex-ews-${var.env}-s3-crr"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "s3.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "s3_crr" {
  name = "apex-ews-${var.env}-s3-crr-policy"
  role = aws_iam_role.s3_crr.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetReplicationConfiguration",
          "s3:ListBucket",
        ]
        Resource = [
          aws_s3_bucket.audit.arn,
          aws_s3_bucket.raw.arn,
          aws_s3_bucket.curated.arn,
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "s3:GetObjectVersionForReplication",
          "s3:GetObjectVersionAcl",
          "s3:GetObjectVersionTagging",
          "s3:GetObjectRetention",
          "s3:GetObjectLegalHold",
        ]
        Resource = [
          "${aws_s3_bucket.audit.arn}/*",
          "${aws_s3_bucket.raw.arn}/*",
          "${aws_s3_bucket.curated.arn}/*",
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "s3:ReplicateObject",
          "s3:ReplicateDelete",
          "s3:ReplicateTags",
          "s3:ObjectOwnerOverrideToBucketOwner",
        ]
        # Destination bucket ARNs are produced in the secondary region's
        # Terraform application; allow all S3 objects under the project name
        # pattern. Production should narrow to known destination ARNs.
        Resource = "arn:aws:s3:::apex-ews-${var.env}-*/*"
      },
    ]
  })
}

# Audit bucket replication. Object Lock retention + legal hold replicate
# because the source role has `GetObjectRetention` + `GetObjectLegalHold`.
resource "aws_s3_bucket_replication_configuration" "audit" {
  count  = var.enable_s3_crr ? 1 : 0
  role   = aws_iam_role.s3_crr.arn
  bucket = aws_s3_bucket.audit.id

  rule {
    id     = "audit-crr-all"
    status = "Enabled"

    filter {}

    delete_marker_replication {
      status = "Enabled"
    }

    destination {
      bucket        = "arn:aws:s3:::apex-ews-${var.env}-audit-${var.secondary_region}-${random_id.suffix.hex}"
      storage_class = "STANDARD"

      encryption_configuration {
        replica_kms_key_id = var.secondary_s3_kms_key_arn
      }

      # Preserve Object Lock retention/legal-hold in the destination.
      replication_time {
        status = "Enabled"
        time {
          minutes = 15
        }
      }

      metrics {
        status = "Enabled"
        event_threshold {
          minutes = 15
        }
      }
    }

    source_selection_criteria {
      sse_kms_encrypted_objects {
        status = "Enabled"
      }
    }
  }

  # The bucket must have versioning enabled (already true; see main.tf).
  depends_on = [aws_s3_bucket_versioning.audit]
}

# Raw bucket replication — looser RPO (240 min per dr-runbook.md), no Object
# Lock so configuration is simpler.
resource "aws_s3_bucket_replication_configuration" "raw" {
  count  = var.enable_s3_crr ? 1 : 0
  role   = aws_iam_role.s3_crr.arn
  bucket = aws_s3_bucket.raw.id

  rule {
    id     = "raw-crr-all"
    status = "Enabled"

    filter {}

    delete_marker_replication {
      status = "Enabled"
    }

    destination {
      bucket        = "arn:aws:s3:::apex-ews-${var.env}-raw-${var.secondary_region}-${random_id.suffix.hex}"
      storage_class = "STANDARD_IA"

      encryption_configuration {
        replica_kms_key_id = var.secondary_s3_kms_key_arn
      }
    }

    source_selection_criteria {
      sse_kms_encrypted_objects {
        status = "Enabled"
      }
    }
  }

  depends_on = [aws_s3_bucket_versioning.raw]
}

# Curated bucket replication — same shape as raw.
resource "aws_s3_bucket_replication_configuration" "curated" {
  count  = var.enable_s3_crr ? 1 : 0
  role   = aws_iam_role.s3_crr.arn
  bucket = aws_s3_bucket.curated.id

  rule {
    id     = "curated-crr-all"
    status = "Enabled"

    filter {}

    delete_marker_replication {
      status = "Enabled"
    }

    destination {
      bucket        = "arn:aws:s3:::apex-ews-${var.env}-curated-${var.secondary_region}-${random_id.suffix.hex}"
      storage_class = "STANDARD"

      encryption_configuration {
        replica_kms_key_id = var.secondary_s3_kms_key_arn
      }
    }

    source_selection_criteria {
      sse_kms_encrypted_objects {
        status = "Enabled"
      }
    }
  }

  depends_on = [aws_s3_bucket_versioning.curated]
}

###############################################################################
# MSK MirrorMaker 2 — primary → secondary topic replication
#
# Realized as an MSK Connect connector running the MirrorMaker 2 plugin.
# This file declares the connector definition + IAM role; the secondary MSK
# cluster (the replication target) is provisioned in the secondary region's
# 30-data application — its bootstrap brokers are referenced here via
# `secondary_msk_bootstrap_brokers`.
#
# RPO: <2min (per docs/slos.md tier-2 SLO).
###############################################################################

resource "aws_iam_role" "msk_mm2" {
  name = "apex-ews-${var.env}-msk-mm2"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "kafkaconnect.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "msk_mm2" {
  name = "apex-ews-${var.env}-msk-mm2-policy"
  role = aws_iam_role.msk_mm2.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "kafka-cluster:Connect",
          "kafka-cluster:AlterCluster",
          "kafka-cluster:DescribeCluster",
          "kafka-cluster:WriteData",
          "kafka-cluster:ReadData",
          "kafka-cluster:DescribeTopic",
          "kafka-cluster:CreateTopic",
          "kafka-cluster:AlterTopic",
          "kafka-cluster:WriteTopic",
          "kafka-cluster:DescribeGroup",
          "kafka-cluster:AlterGroup",
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogStreams",
        ]
        Resource = "${aws_cloudwatch_log_group.msk_mm2.arn}:*"
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "msk_mm2" {
  name              = "/apex-ews/${var.env}/msk-connect/mm2"
  retention_in_days = 30
}

# MSK Connect worker config — JSON converter + AWS MSK IAM client.
resource "aws_mskconnect_worker_configuration" "mm2" {
  name                    = "apex-ews-${var.env}-mm2-worker"
  properties_file_content = <<-EOT
    key.converter=org.apache.kafka.connect.converters.ByteArrayConverter
    value.converter=org.apache.kafka.connect.converters.ByteArrayConverter
    key.converter.schemas.enable=false
    value.converter.schemas.enable=false
  EOT
}

# Custom plugin ARN for MM2 — uploaded out-of-band as the
# `kafka-connect-mirror-maker-2.zip` artefact and referenced here. The
# variable is null in dev/lab so the connector resource is skipped.
resource "aws_mskconnect_connector" "mm2" {
  count = var.enable_msk_mm2 ? 1 : 0

  name = "apex-ews-${var.env}-mm2"

  kafkaconnect_version = "2.7.1"

  capacity {
    autoscaling {
      max_worker_count = 4
      mcu_count        = 1
      min_worker_count = 1

      scale_in_policy {
        cpu_utilization_percentage = 20
      }

      scale_out_policy {
        cpu_utilization_percentage = 80
      }
    }
  }

  connector_configuration = {
    "connector.class"             = "org.apache.kafka.connect.mirror.MirrorSourceConnector"
    "tasks.max"                   = "4"
    "source.cluster.alias"        = "primary"
    "target.cluster.alias"        = "secondary"
    "source.cluster.bootstrap.servers" = aws_msk_cluster.this.bootstrap_brokers_sasl_iam
    "target.cluster.bootstrap.servers" = var.secondary_msk_bootstrap_brokers
    "topics"                      = "apex\\.cbs\\.events|apex\\.indicator\\.values|apex\\.regulatory\\.events|apex\\.case\\.events|apex\\.audit\\.events"
    "replication.factor"          = "3"
    "checkpoints.topic.replication.factor"     = "3"
    "heartbeats.topic.replication.factor"      = "3"
    "offset-syncs.topic.replication.factor"    = "3"
    "sync.topic.acls.enabled"     = "false"
    "refresh.topics.interval.seconds" = "60"
    "emit.heartbeats.interval.seconds" = "5"
    "emit.checkpoints.interval.seconds" = "30"
    # IAM auth on both clusters
    "source.cluster.security.protocol" = "SASL_SSL"
    "source.cluster.sasl.mechanism"    = "AWS_MSK_IAM"
    "source.cluster.sasl.jaas.config"  = "software.amazon.msk.auth.iam.IAMLoginModule required;"
    "source.cluster.sasl.client.callback.handler.class" = "software.amazon.msk.auth.iam.IAMClientCallbackHandler"
    "target.cluster.security.protocol" = "SASL_SSL"
    "target.cluster.sasl.mechanism"    = "AWS_MSK_IAM"
    "target.cluster.sasl.jaas.config"  = "software.amazon.msk.auth.iam.IAMLoginModule required;"
    "target.cluster.sasl.client.callback.handler.class" = "software.amazon.msk.auth.iam.IAMClientCallbackHandler"
  }

  kafka_cluster {
    apache_kafka_cluster {
      bootstrap_servers = aws_msk_cluster.this.bootstrap_brokers_sasl_iam

      vpc {
        security_groups = [aws_security_group.msk.id]
        subnets         = var.data_subnet_ids
      }
    }
  }

  kafka_cluster_client_authentication {
    authentication_type = "IAM"
  }

  kafka_cluster_encryption_in_transit {
    encryption_type = "TLS"
  }

  plugin {
    custom_plugin {
      arn      = var.msk_mm2_plugin_arn
      revision = var.msk_mm2_plugin_revision
    }
  }

  worker_configuration {
    arn      = aws_mskconnect_worker_configuration.mm2.arn
    revision = aws_mskconnect_worker_configuration.mm2.latest_revision
  }

  service_execution_role_arn = aws_iam_role.msk_mm2.arn

  log_delivery {
    worker_log_delivery {
      cloudwatch_logs {
        enabled   = true
        log_group = aws_cloudwatch_log_group.msk_mm2.name
      }
    }
  }
}
