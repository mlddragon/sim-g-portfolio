# A custom VPC with no automatic subnets or rules. Removing the project's
# `default` network is an F13d precondition (README).
resource "google_compute_network" "gateway" {
  project                 = local.project
  name                    = local.name
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"

  depends_on = [google_project_service.required]
}

resource "google_compute_subnetwork" "gateway" {
  project       = local.project
  name          = local.name
  region        = var.region
  network       = google_compute_network.gateway.id
  ip_cidr_range = "10.30.0.0/28"
}

# Public HTTPS only; every Brain operation is authenticated by the gateway.
resource "google_compute_firewall" "https" {
  project       = local.project
  name          = "${local.name}-https"
  network       = google_compute_network.gateway.id
  direction     = "INGRESS"
  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["sim-g-edge"]

  allow {
    protocol = "tcp"
    ports    = ["443"]
  }
}

# Port 80 only for HTTPS redirects and the ACME HTTP-01 challenge (owner
# decision 2026-10-27); nginx serves nothing else on it.
resource "google_compute_firewall" "http" {
  project       = local.project
  name          = "${local.name}-http"
  network       = google_compute_network.gateway.id
  direction     = "INGRESS"
  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["sim-g-edge"]

  allow {
    protocol = "tcp"
    ports    = ["80"]
  }
}

# SSH only through IAP TCP forwarding.
resource "google_compute_firewall" "iap_ssh" {
  project       = local.project
  name          = "${local.name}-iap-ssh"
  network       = google_compute_network.gateway.id
  direction     = "INGRESS"
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["sim-g-edge"]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

# Production's one static IPv4 (the largest cost), on the Standard tier. A
# reserved address left unattached is billed at a higher rate, so development
# reserves none.
resource "google_compute_address" "ingress" {
  count = local.production ? 1 : 0

  project      = local.project
  name         = local.name
  region       = var.region
  network_tier = "STANDARD"
  labels       = local.labels

  deletion_policy = "PREVENT"

  depends_on = [google_project_service.required]
}
