provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "apex-ews"
      Owner     = "agent-integration"
      ManagedBy = "terraform"
      Layer     = "20-eks"
    }
  }
}
