###############################################################################
# T4.4 — Aurora reader autoscale + RDS Proxy
#
# Aurora's `reader_endpoint` already round-robins across the static reader
# instances declared in main.tf via `aws_rds_cluster_instance.reader[*]`.
# This file adds Application Auto Scaling so the reader pool grows on
# CPU + connection pressure + shrinks during off-hours.
#
# Two scaling axes:
#   1. Reader count — `aws_appautoscaling_target.aurora_reader` with policies
#      on CPU + connection count.
#   2. RDS Proxy — connection pooling so application reconnect-storms +
#      Lambda cold-starts don't blow Aurora's max_connections limit.
#
# Activation: `var.enable_aurora_autoscale` (default false) so existing
# `terraform plan` doesn't require new arguments. Set true once monitoring
# is in place + the workload has a 30-day baseline.
###############################################################################

###############################################################################
# Application Auto Scaling — reader replica count
###############################################################################

resource "aws_appautoscaling_target" "aurora_reader" {
  count = var.enable_aurora_autoscale ? 1 : 0

  service_namespace  = "rds"
  resource_id        = "cluster:${aws_rds_cluster.aurora.id}"
  scalable_dimension = "rds:cluster:ReadReplicaCount"
  min_capacity       = var.aurora_reader_min
  max_capacity       = var.aurora_reader_max
}

# CPU-based scaling — target 65% across the reader pool.
resource "aws_appautoscaling_policy" "aurora_reader_cpu" {
  count = var.enable_aurora_autoscale ? 1 : 0

  name               = "apex-ews-${var.env}-aurora-reader-cpu"
  service_namespace  = aws_appautoscaling_target.aurora_reader[0].service_namespace
  resource_id        = aws_appautoscaling_target.aurora_reader[0].resource_id
  scalable_dimension = aws_appautoscaling_target.aurora_reader[0].scalable_dimension
  policy_type        = "TargetTrackingScaling"

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "RDSReaderAverageCPUUtilization"
    }
    target_value       = 65.0
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}

# Connection-count scaling — target 700 average connections / reader.
resource "aws_appautoscaling_policy" "aurora_reader_connections" {
  count = var.enable_aurora_autoscale ? 1 : 0

  name               = "apex-ews-${var.env}-aurora-reader-conn"
  service_namespace  = aws_appautoscaling_target.aurora_reader[0].service_namespace
  resource_id        = aws_appautoscaling_target.aurora_reader[0].resource_id
  scalable_dimension = aws_appautoscaling_target.aurora_reader[0].scalable_dimension
  policy_type        = "TargetTrackingScaling"

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "RDSReaderAverageDatabaseConnections"
    }
    target_value       = 700.0
    scale_in_cooldown  = 600
    scale_out_cooldown = 120
  }
}

###############################################################################
# RDS Proxy — connection pooling
#
# Sits between the application + the cluster. Reduces reconnect storms when
# pods restart + smooths Lambda cold-start traffic. Uses Secrets Manager for
# credentials (Aurora's managed master user secret is reused).
###############################################################################

resource "aws_iam_role" "rds_proxy" {
  count = var.enable_aurora_autoscale ? 1 : 0

  name = "apex-ews-${var.env}-rds-proxy"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "rds.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "rds_proxy" {
  count = var.enable_aurora_autoscale ? 1 : 0

  name = "apex-ews-${var.env}-rds-proxy-policy"
  role = aws_iam_role.rds_proxy[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
        ]
        Resource = aws_rds_cluster.aurora.master_user_secret[0].secret_arn
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = data.aws_kms_alias.aurora.target_key_arn
        Condition = {
          StringEquals = {
            "kms:ViaService" = "secretsmanager.${var.region}.amazonaws.com"
          }
        }
      },
    ]
  })
}

resource "aws_db_proxy" "aurora" {
  count = var.enable_aurora_autoscale ? 1 : 0

  name                   = "apex-ews-${var.env}-aurora-proxy"
  engine_family          = "POSTGRESQL"
  role_arn               = aws_iam_role.rds_proxy[0].arn
  vpc_subnet_ids         = var.data_subnet_ids
  vpc_security_group_ids = [aws_security_group.aurora.id]
  require_tls            = true
  idle_client_timeout    = 1800
  debug_logging          = false

  auth {
    auth_scheme = "SECRETS"
    iam_auth    = "REQUIRED"
    secret_arn  = aws_rds_cluster.aurora.master_user_secret[0].secret_arn
  }
}

resource "aws_db_proxy_default_target_group" "aurora" {
  count = var.enable_aurora_autoscale ? 1 : 0

  db_proxy_name = aws_db_proxy.aurora[0].name

  connection_pool_config {
    connection_borrow_timeout    = 120
    max_connections_percent      = 80
    max_idle_connections_percent = 50
    session_pinning_filters      = ["EXCLUDE_VARIABLE_SETS"]
  }
}

resource "aws_db_proxy_target" "aurora" {
  count = var.enable_aurora_autoscale ? 1 : 0

  db_cluster_identifier = aws_rds_cluster.aurora.id
  db_proxy_name         = aws_db_proxy.aurora[0].name
  target_group_name     = aws_db_proxy_default_target_group.aurora[0].name
}
