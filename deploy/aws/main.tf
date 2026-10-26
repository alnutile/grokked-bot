# Grokked Bot on one EC2 instance: an XFCE desktop streamed by Amazon DCV, the
# Grokked app on it, Docker for the bot computers. No inbound ports for people:
# you reach the desktop through a Session Manager port forward. Webhooks, if on,
# come in through CloudFront (HTTPS) and only from CloudFront's own addresses.

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws    = { source = "hashicorp/aws", version = ">= 5.60" }
    random = { source = "hashicorp/random", version = ">= 3.6" }
  }
}

provider "aws" {
  region = var.region
  default_tags { tags = merge({ Project = var.name }, var.tags) }
}

data "aws_caller_identity" "me" {}

data "aws_vpc" "this" {
  id      = var.vpc_id
  default = var.vpc_id == null ? true : null
}

data "aws_subnets" "public" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.this.id]
  }
  filter {
    name   = "map-public-ip-on-launch"
    values = ["true"]
  }
}

locals {
  subnet_id = coalesce(var.subnet_id, try(sort(data.aws_subnets.public.ids)[0], null))
  param     = "arn:aws:ssm:${var.region}:${data.aws_caller_identity.me.account_id}:parameter/${var.name}/*"
  key_param = coalesce(var.openrouter_key_parameter, "/${var.name}/openrouter-key")
}

data "aws_ssm_parameter" "ubuntu" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

# ---------------------------------------------------------------- identity

resource "aws_iam_role" "instance" {
  name = "${var.name}-ec2"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "instance" {
  name = "dcv-license-and-own-parameters"
  role = aws_iam_role.instance.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # DCV on EC2 is free; it checks that by reading this AWS-owned bucket.
      { Effect = "Allow", Action = "s3:GetObject", Resource = "arn:aws:s3:::dcv-license.${var.region}/*" },
      # Its desktop password and (if you add it) the OpenRouter key.
      { Effect = "Allow", Action = "ssm:GetParameter", Resource = [
        local.param, "arn:aws:ssm:${var.region}:${data.aws_caller_identity.me.account_id}:parameter/${trimprefix(local.key_param, "/")}",
      ] },
    ]
  })
}

resource "aws_iam_instance_profile" "instance" {
  name = "${var.name}-ec2"
  role = aws_iam_role.instance.name
}

# The desktop (DCV) password for the ubuntu user. It's in Terraform state too,
# so keep the state somewhere private.
resource "random_password" "desktop" {
  length  = 24
  special = false
}

resource "aws_ssm_parameter" "desktop_password" {
  name  = "/${var.name}/desktop-password"
  type  = "SecureString"
  value = random_password.desktop.result
}

# ---------------------------------------------------------------- network

data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_security_group" "instance" {
  name        = "${var.name}-instance"
  description = "Grokked: nothing inbound except webhooks from CloudFront"
  vpc_id      = data.aws_vpc.this.id

  dynamic "ingress" {
    for_each = var.webhooks ? [1] : []
    content {
      description     = "Grokked webhook listener, from CloudFront only"
      from_port       = 8798
      to_port         = 8798
      protocol        = "tcp"
      prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront.id]
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ---------------------------------------------------------------- the machine

resource "aws_instance" "this" {
  ami                    = data.aws_ssm_parameter.ubuntu.value
  instance_type          = var.instance_type
  subnet_id              = local.subnet_id
  vpc_security_group_ids = [aws_security_group.instance.id]
  iam_instance_profile   = aws_iam_instance_profile.instance.name

  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    name            = var.name
    region          = var.region
    grokked_version = var.grokked_version
    webhooks        = var.webhooks
    key_param       = local.key_param
  })
  user_data_replace_on_change = true

  root_block_device {
    volume_size = var.volume_gb
    volume_type = "gp3"
    encrypted   = true
  }

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }

  tags = { Name = var.name }

  # A newer Ubuntu image shouldn't replace a server full of bots and logins.
  lifecycle { ignore_changes = [ami] }

  depends_on = [aws_ssm_parameter.desktop_password, aws_iam_role_policy.instance]
}

# A fixed address, so CloudFront's origin doesn't change on stop/start.
resource "aws_eip" "this" {
  count    = var.webhooks ? 1 : 0
  instance = aws_instance.this.id
  domain   = "vpc"
}

# ---------------------------------------------------------------- webhooks

# Everything but /public/hooks/* gets a 404 at the edge, so neither the main API
# nor hooks you haven't marked Public can be reached through this URL.
resource "aws_cloudfront_function" "only_public_hooks" {
  count   = var.webhooks ? 1 : 0
  name    = "${var.name}-only-public-hooks"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = <<-JS
    function handler(event) {
      var r = event.request;
      if (r.uri.indexOf('/public/hooks/') === 0) return r;
      return { statusCode: 404, statusDescription: 'Not Found' };
    }
  JS
}

resource "aws_cloudfront_distribution" "hooks" {
  count       = var.webhooks ? 1 : 0
  enabled     = true
  comment     = "${var.name} webhooks"
  price_class = "PriceClass_100"

  origin {
    origin_id   = "grokked"
    domain_name = aws_eip.this[0].public_dns
    custom_origin_config {
      http_port              = 8798
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      origin_read_timeout    = 60
    }
  }

  default_cache_behavior {
    target_origin_id       = "grokked"
    viewer_protocol_policy = "https-only"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    # Managed policies: CachingDisabled, AllViewerExceptHostHeader (keeps Authorization).
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.only_public_hooks[0].arn
    }
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate { cloudfront_default_certificate = true }
}
