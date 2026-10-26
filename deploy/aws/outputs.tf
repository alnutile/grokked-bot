output "instance_id" {
  value = aws_instance.this.id
}

output "desktop_password_command" {
  description = "Prints the DCV password for the ubuntu user."
  value       = "aws ssm get-parameter --region ${var.region} --name ${aws_ssm_parameter.desktop_password.name} --with-decryption --query Parameter.Value --output text"
}

output "desktop_tunnel_command" {
  description = "Run this, then open https://localhost:18443 (or dcvviewer localhost:18443) and sign in as ubuntu."
  value       = "aws ssm start-session --region ${var.region} --target ${aws_instance.this.id} --document-name AWS-StartPortForwardingSession --parameters '{\"portNumber\":[\"8443\"],\"localPortNumber\":[\"18443\"]}'"
}

output "webhook_base_url" {
  description = "Public hooks answer at <this>/public/hooks/<id>. Mark a hook Public in the bot's Triggers tab."
  value       = var.webhooks ? "https://${aws_cloudfront_distribution.hooks[0].domain_name}" : null
}
