# Grokked Bot on AWS

One EC2 instance running Grokked Bot the same way it runs on your own computer: a
light Ubuntu desktop (XFCE) streamed by [Amazon DCV](https://aws.amazon.com/hpc/dcv/),
the Grokked app on it, and Docker for the bots' computers. Use it when bots need to
work on a schedule, take webhooks, or live in a client's AWS account instead of your
laptop.

```
you ── Session Manager tunnel (no open ports) ──▶ DCV desktop :8443 ──▶ Grokked app
other apps ── HTTPS ──▶ CloudFront ── /public/hooks/* only ──▶ webhook listener :8798
Slack ◀── outbound WebSocket ── Grokked (no inbound needed)
```

- **No inbound ports for people.** You reach the desktop through an AWS Systems
  Manager port forward: access is by AWS login, and every session is logged.
- **Webhooks** come in through CloudFront over HTTPS. The edge returns 404 for
  everything except `/public/hooks/*`, and the security group only accepts CloudFront's
  addresses. Each hook still needs its own bearer token.
- **The app starts with the desktop at boot**, so schedules, webhooks and Slack keep
  working after a reboot without anyone signing in.

## What you need

- An AWS account and a CLI profile that can create EC2, IAM, SSM and CloudFront
  resources.
- [Terraform](https://developer.hashicorp.com/terraform/install) 1.6+, the
  [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
  and the [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html).
- An [OpenRouter](https://openrouter.ai/keys) key. Use a separate key per client so
  spending stays separate.

## 1. Put the OpenRouter key in Parameter Store

It never goes in Terraform or its state. This asks for it without echoing it:

```bash
read -rsp "OpenRouter key: " K; echo
aws ssm put-parameter --name /grokked/openrouter-key --type SecureString --value "$K"; unset K
```

(`/grokked` is the default `name`. Several servers can share one key with
`-var openrouter_key_parameter=/some/other/name`.)

## 2. Create the server

```bash
cd deploy/aws
terraform init
terraform plan -out=grokked.plan        # look it over: 11 resources
terraform apply grokked.plan
```

CloudFront takes about 3 minutes; the server sets itself up in about 10 (log:
`/var/log/grokked-setup.log`, ending with `GROKKED-SETUP-DONE`).

Variables worth knowing (`-var name=value`):

| | default | |
|---|---|---|
| `name` | `grokked` | Prefix for everything. Use one per server. |
| `region` | `us-east-1` | |
| `instance_type` | `t3.xlarge` | x86_64 only. About 3 busy bots; `m7i.2xlarge` for more. |
| `volume_gb` | `80` | |
| `grokked_version` | `0.6.0` | Release to install. |
| `vpc_id`, `subnet_id` | default VPC | The subnet needs outbound internet. |
| `webhooks` | `true` | `false` skips CloudFront and keeps the instance fully closed. |

## 3. Open the desktop

```bash
$(terraform output -raw desktop_password_command)   # the password for user ubuntu
$(terraform output -raw desktop_tunnel_command)     # keep this running
```

Open <https://localhost:18443> and sign in as **ubuntu** (the certificate is
self-signed, so the browser warns once). If the browser says **WebGL not available**,
use the native [DCV client](https://docs.aws.amazon.com/dcv/latest/userguide/client.html) instead: `dcvviewer localhost:18443`.
It's smoother anyway.

Grokked Bot is already open on the desktop. From here it works exactly like on your
own computer: make bots, sign them into sites, set up Slack, SSH, Env and triggers.

The tunnel drops after 20 idle minutes (Session Manager's default); run it again, or
raise the idle timeout in Session Manager's preferences.

## 4. Webhooks

In a bot's **Triggers** tab, add a webhook and mark it **Public**. Then:

```bash
curl -X POST "$(terraform output -raw webhook_base_url)/public/hooks/<id>" \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"prompt": "…", "wait": 55}'
```

CloudFront waits at most 60 seconds for an answer, so keep `wait` at 55 or less. For
longer jobs, leave `wait` out: you get `202` and a status URL to poll
(`GET …/public/hooks/<id>/runs/<run_id>`).

Hooks not marked Public don't answer here (404 at the edge).

## Notes

- **The CloudFront → instance leg is plain HTTP** to a port only CloudFront can reach.
  For traffic that must be encrypted end to end, put your own domain and certificate
  on the instance or an ALB and point CloudFront at that over HTTPS.
- The desktop password is a random value in Parameter Store, and also in Terraform
  state: keep the state private (a remote backend with encryption, or local and
  backed up).
- `terraform destroy` removes the server and everything on it: bots, logins,
  conversations. The OpenRouter key parameter stays, since Terraform didn't make it.
- Upgrading Grokked: download the new `.deb` on the desktop and install it, or change
  `grokked_version` and re-create the server (which starts from scratch).
