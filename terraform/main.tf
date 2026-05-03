terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
  required_version = ">= 1.0"
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# ─── R2 bucket (p2pcf signalling state) ──────────────────────────────────────

resource "cloudflare_r2_bucket" "signaling" {
  account_id = var.cloudflare_account_id
  name       = var.r2_bucket_name
}

# ─── Worker ───────────────────────────────────────────────────────────────────

resource "cloudflare_workers_script" "hilo" {
  account_id = var.cloudflare_account_id
  name       = var.worker_name
  content    = file("${path.module}/../worker.js")
  module     = true

  r2_bucket_binding {
    name        = "BUCKET"
    bucket_name = cloudflare_r2_bucket.signaling.name
  }

  secret_text_binding {
    name = "METERED_USERNAME"
    text = var.metered_username
  }

  secret_text_binding {
    name = "METERED_CREDENTIAL"
    text = var.metered_credential
  }
}

# ─── Pages project (static site) ─────────────────────────────────────────────

resource "cloudflare_pages_project" "hilo" {
  account_id        = var.cloudflare_account_id
  name              = var.pages_project_name
  production_branch = "main"

  build_config {
    build_command   = "pnpm install && pnpm build"
    destination_dir = "docs"
  }
}
