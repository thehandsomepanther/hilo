variable "cloudflare_api_token" {
  description = "Cloudflare API token with Workers, Pages, and R2 permissions"
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "metered_username" {
  description = "Metered.ca TURN username"
  type        = string
  sensitive   = true
}

variable "metered_credential" {
  description = "Metered.ca TURN credential"
  type        = string
  sensitive   = true
}

variable "worker_name" {
  description = "Name for the Cloudflare Worker"
  type        = string
  default     = "hilo-worker"
}

variable "pages_project_name" {
  description = "Name for the Cloudflare Pages project"
  type        = string
  default     = "hilo"
}

variable "r2_bucket_name" {
  description = "Name for the R2 bucket used by the signalling worker"
  type        = string
  default     = "hilo-signaling"
}

variable "workers_subdomain" {
  description = "Your account's workers.dev subdomain (Account Settings → Workers & Pages → Your subdomain)"
  type        = string
}
