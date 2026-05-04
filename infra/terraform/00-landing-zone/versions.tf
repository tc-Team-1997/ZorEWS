terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.50"
    }
  }

  # backend "s3" {
  #   bucket         = "apex-ews-tfstate"
  #   key            = "00-landing-zone/terraform.tfstate"
  #   region         = "af-south-1"
  #   dynamodb_table = "apex-ews-tflock"
  #   encrypt        = true
  # }
}
