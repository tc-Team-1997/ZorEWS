output "alb_dns_name" {
  value = aws_lb.this.dns_name
}

output "alb_arn" {
  value = aws_lb.this.arn
}

output "cloudfront_domain_name" {
  value = aws_cloudfront_distribution.spa.domain_name
}

output "spa_bucket" {
  value = aws_s3_bucket.spa.id
}

output "route53_zone_id" {
  value = aws_route53_zone.this.zone_id
}
