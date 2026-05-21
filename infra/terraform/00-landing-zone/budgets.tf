###############################################################################
# AWS Budgets — production cost guardrails per `docs/charter.md` $25k/mo
# envelope (compute) + $2k/mo (third-party + DR). Alarms trigger at
# 50% / 80% / 100% / 120% MTD.
#
# Owner: SRE-lead + FinOps. Phase: T1-P5.
###############################################################################

locals {
  budget_subscribers = [
    "finops@apex-ews.example",
    "sre-lead@apex-ews.example",
    "cto@apex-ews.example",
  ]
}

###############################################################################
# Overall monthly account budget — hard cap at $30k (env vars allow tuning).
###############################################################################

resource "aws_budgets_budget" "monthly_total" {
  name              = "${var.name_prefix}-monthly-total"
  budget_type       = "COST"
  limit_amount      = var.monthly_budget_usd
  limit_unit        = "USD"
  time_unit         = "MONTHLY"
  time_period_start = "2026-05-01_00:00"

  cost_filter {
    name   = "TagKeyValue"
    values = ["aws:CreatedBy$apex-ews-deploy", "user:Project$apex-ews"]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = local.budget_subscribers
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = local.budget_subscribers
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = local.budget_subscribers
  }

  # Forecast-based — fires when current trajectory will exceed budget.
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = local.budget_subscribers
  }

  tags = {
    purpose = "cost-guardrail"
  }
}

###############################################################################
# Per-service category budgets (illustrative for the 4 highest-spend services).
# Tuning happens after 30-day baseline per FinOps T5.5 dashboard.
###############################################################################

resource "aws_budgets_budget" "category" {
  for_each = {
    aurora    = { limit = "9000", services = ["Amazon Relational Database Service"] }
    msk       = { limit = "5000", services = ["Managed Streaming for Apache Kafka"] }
    eks       = { limit = "6000", services = ["Amazon Elastic Container Service for Kubernetes", "Amazon Elastic Compute Cloud - Compute"] }
    s3        = { limit = "2000", services = ["Amazon Simple Storage Service"] }
  }

  name              = "${var.name_prefix}-${each.key}-monthly"
  budget_type       = "COST"
  limit_amount      = each.value.limit
  limit_unit        = "USD"
  time_unit         = "MONTHLY"
  time_period_start = "2026-05-01_00:00"

  cost_filter {
    name   = "Service"
    values = each.value.services
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = local.budget_subscribers
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = local.budget_subscribers
  }

  tags = {
    category = each.key
    purpose  = "per-service-cost-guardrail"
  }
}

###############################################################################
# Cost anomaly detection — flags sudden cost spikes (e.g. runaway loop).
###############################################################################

resource "aws_ce_anomaly_monitor" "this" {
  name              = "${var.name_prefix}-anomaly-monitor"
  monitor_type      = "DIMENSIONAL"
  monitor_dimension = "SERVICE"

  tags = {
    purpose = "cost-anomaly-detection"
  }
}

resource "aws_ce_anomaly_subscription" "this" {
  name      = "${var.name_prefix}-anomaly-subscription"
  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      values        = ["200"] # $200 anomaly threshold
      match_options = ["GREATER_THAN_OR_EQUAL"]
    }
  }
  frequency = "DAILY"
  monitor_arn_list = [aws_ce_anomaly_monitor.this.arn]

  dynamic "subscriber" {
    for_each = local.budget_subscribers
    content {
      type    = "EMAIL"
      address = subscriber.value
    }
  }

  tags = {
    purpose = "cost-anomaly-alarm"
  }
}
