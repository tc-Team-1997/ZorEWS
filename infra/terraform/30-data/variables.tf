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
