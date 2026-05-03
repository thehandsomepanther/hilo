output "worker_url" {
  description = "URL of the deployed signalling worker"
  value       = "https://${var.worker_name}.${var.workers_subdomain}.workers.dev"
}

output "r2_bucket_name" {
  description = "Name of the R2 bucket bound to the worker"
  value       = cloudflare_r2_bucket.signaling.name
}
