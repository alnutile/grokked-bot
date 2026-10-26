variable "name" {
  description = "Prefix for every resource, and the Parameter Store path (/<name>/...). One per server."
  type        = string
  default     = "grokked"
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "grokked_version" {
  description = "Grokked Bot release to install (a vX.Y.Z tag without the v)."
  type        = string
  default     = "0.6.0"
}

variable "instance_type" {
  description = "x86_64 only: the bot computer image is amd64. t3.xlarge runs about 3 busy bots."
  type        = string
  default     = "t3.xlarge"
}

variable "volume_gb" {
  type    = number
  default = 80
}

variable "vpc_id" {
  description = "Leave null for the region's default VPC."
  type        = string
  default     = null
}

variable "subnet_id" {
  description = "A subnet with a route to the internet (the instance needs outbound HTTPS). Leave null to pick one in the VPC."
  type        = string
  default     = null
}

variable "openrouter_key_parameter" {
  description = "Parameter Store name of a SecureString holding the OpenRouter key. Null means /<name>/openrouter-key. Point several servers at one to share a key."
  type        = string
  default     = null
}

variable "webhooks" {
  description = "Put an HTTPS CloudFront URL in front of the webhook listener. Only /public/hooks/* is forwarded."
  type        = bool
  default     = true
}

variable "tags" {
  type    = map(string)
  default = {}
}
