variable "region" {
  type    = string
  default = "af-south-1"
}

variable "env" {
  type    = string
  default = "prod"
}

variable "vpc_id" {
  type = string
}

variable "data_subnet_ids" {
  description = "Three data-tier subnet ids."
  type        = list(string)
}

variable "private_subnet_ids" {
  description = "Three private-tier subnet ids (for ElastiCache + MSK clients)."
  type        = list(string)
}

variable "aurora_engine_version" {
  type    = string
  default = "16.2"
}

variable "aurora_writer_instance_class" {
  type    = string
  default = "db.r6g.xlarge"
}

variable "aurora_reader_count" {
  type    = number
  default = 2
}

variable "redis_node_type" {
  type    = string
  default = "cache.r7g.large"
}

variable "msk_kafka_version" {
  type    = string
  default = "3.6.0"
}

variable "msk_broker_instance_type" {
  type    = string
  default = "kafka.m7g.large"
}

###############################################################################
# T5.2 — multi-region DR (Aurora Global DB + S3 CRR + MSK MirrorMaker 2)
###############################################################################

variable "secondary_region" {
  description = "AWS region for DR secondary (e.g. ap-south-1 next to primary af-south-1)."
  type        = string
  default     = "ap-south-1"
}

variable "enable_s3_crr" {
  description = "Enable S3 Cross-Region Replication on audit + raw + curated. Requires secondary buckets pre-provisioned in secondary region with matching names."
  type        = bool
  default     = false
}

variable "secondary_s3_kms_key_arn" {
  description = "KMS key ARN in the secondary region used for CRR object re-encryption. Required when enable_s3_crr=true."
  type        = string
  default     = null
}

variable "enable_msk_mm2" {
  description = "Enable MSK Connect MirrorMaker 2 connector. Requires secondary MSK cluster + uploaded MM2 plugin."
  type        = bool
  default     = false
}

variable "secondary_msk_bootstrap_brokers" {
  description = "SASL_SSL bootstrap brokers of the secondary-region MSK cluster (e.g. b-1.apex-ews-prod-msk-secondary.kafka.ap-south-1.amazonaws.com:9098). Required when enable_msk_mm2=true."
  type        = string
  default     = null
}

variable "msk_mm2_plugin_arn" {
  description = "ARN of the uploaded MSK Connect custom plugin (kafka-connect-mirror-maker-2.zip). Required when enable_msk_mm2=true."
  type        = string
  default     = null
}

variable "msk_mm2_plugin_revision" {
  description = "Revision number of the MM2 custom plugin. Required when enable_msk_mm2=true."
  type        = number
  default     = null
}
