provider "aws" {
  region = var.primary_region
  default_tags {
    tags = {
      cost-center = "risk-it"
      environment = var.env
      managed-by  = "terraform"
      layer       = "05-vpn"
    }
  }
}
