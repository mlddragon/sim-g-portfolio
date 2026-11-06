module "host" {
  source = "../vm-host"
}

# PostgreSQL data and the ingress certificate state; never deleted with the VM.
resource "google_compute_disk" "data" {
  project = local.project
  name    = "${local.name}-data"
  zone    = var.zone
  type    = "pd-standard"
  size    = 10
  labels  = local.labels

  deletion_policy = local.protection

  depends_on = [google_project_service.required]
}

# The workload identity attached to the VM; its grants are in identity.tf.
resource "google_service_account" "runtime" {
  project      = local.project
  account_id   = "fbg-runtime"
  display_name = "Family Brain Gateway runtime (${var.environment})"

  depends_on = [google_project_service.required]
}

resource "google_compute_instance" "gateway" {
  project             = local.project
  name                = local.name
  zone                = var.zone
  machine_type        = "e2-micro"
  tags                = ["sim-g-edge"]
  labels              = local.labels
  deletion_protection = local.production

  boot_disk {
    auto_delete = true

    initialize_params {
      image = var.boot_image
      type  = "pd-standard"
      size  = 10
    }
  }

  attached_disk {
    source      = google_compute_disk.data.id
    device_name = "sim-g-data"
  }

  network_interface {
    subnetwork = google_compute_subnetwork.gateway.id

    # Production keeps its static address; development's is ephemeral. The
    # public IPv4 is the approved design (no load balancer or NAT): only 443
    # (and optional 80) is open, and every Brain operation is authenticated.
    #trivy:ignore:AVD-GCP-0031
    access_config {
      nat_ip       = local.production ? google_compute_address.ingress[0].address : null
      network_tier = "STANDARD"
    }
  }

  # Free Tier needs a non-Spot VM; host maintenance live-migrates.
  scheduling {
    preemptible         = false
    provisioning_model  = "STANDARD"
    automatic_restart   = true
    on_host_maintenance = "MIGRATE"
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  # Every process on the VM can read these; they hold no secrets. user-data
  # is the host layer from deploy/vm/host (cloud-init, rewritten every boot).
  metadata = {
    user-data              = module.host.user_data
    enable-oslogin         = "TRUE"
    enable-oslogin-2fa     = "TRUE"
    block-project-ssh-keys = "TRUE"
    serial-port-enable     = "FALSE"
    google-logging-enabled = "true"
  }

  service_account {
    email  = google_service_account.runtime.email
    scopes = ["cloud-platform"]
  }
}
