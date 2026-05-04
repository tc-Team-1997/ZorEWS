provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "apex-ews"
      Owner     = "agent-integration"
      ManagedBy = "terraform"
      Layer     = "40-edge"
    }
  }
}

# CloudFront + WAF (CLOUDFRONT scope) require us-east-1 provider alias.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project   = "apex-ews"
      Owner     = "agent-integration"
      ManagedBy = "terraform"
      Layer     = "40-edge"
    }
  }
}
