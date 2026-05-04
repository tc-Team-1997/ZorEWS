provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project    = "apex-ews"
      Owner      = "agent-integration"
      Compliance = "DPA2019,ISO27001"
      ManagedBy  = "terraform"
      Layer      = "00-landing-zone"
    }
  }
}
