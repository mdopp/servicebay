# Installation & Startup Documentation

## 1. FCOS Installation: Build Pipeline

```mermaid
flowchart TD
    subgraph "Developer Workstation"
        A[run install-fedora-coreos.sh] --> B[Interactive Prompts]
        B --> C[Generate SSH Keypair<br/>RSA 4096]
        B --> D[Hash Console Password<br/>openssl passwd -6]
        B --> E[Render config.json<br/>auth + gateway + email + registries]

        C --> F[envsubst: Render Butane Template]
        D --> F
        E --> F

        F --> G[butane → Ignition JSON]
        G --> H[Download FCOS ISO<br/>cached in build/fcos/]
        H --> I["coreos-installer iso customize<br/>bake Ignition + scripts into ISO"]
        I --> J[Patch GRUB Label<br/>'ServiceBay Installer']
        J --> K[Write to USB<br/>sudo dd]
    end

    style A fill:#e1f5fe
    style K fill:#c8e6c9
```

## 2. FCOS Installer Prompts

```
┌─────────────┬──────────────────────────────┬────────────┬────────────┐
│ Section     │ Prompt                       │ Default    │ Persisted? │
├─────────────┼──────────────────────────────┼────────────┼────────────┤
│ User        │ Host username                │ core       │ ✓          │
│             │ SSH public key               │ —          │ ✓          │
│             │ Console password             │ —          │ ✗ secret   │
├─────────────┼──────────────────────────────┼────────────┼────────────┤
│ Network     │ Interface name               │ enp1s0     │ ✓          │
│             │ Static IP                    │ —          │ ✓          │
│             │ Prefix length                │ 24         │ ✓          │
│             │ Gateway IP                   │ —          │ ✓          │
│             │ DNS servers (;-separated)    │ gateway IP │ ✓          │
├─────────────┼──────────────────────────────┼────────────┼────────────┤
│ ServiceBay  │ Port                         │ 3000       │ ✓          │
│             │ Update channel               │ stable     │ ✓          │
│             │ Admin username               │ admin      │ ✓          │
│             │ Admin password               │ —          │ ✗ secret   │
├─────────────┼──────────────────────────────┼────────────┼────────────┤
│ Gateway     │ FritzBox host (optional)     │ —          │ ✓          │
│             │ FritzBox username            │ —          │ ✓          │
│             │ FritzBox password            │ —          │ ✗ secret   │
├─────────────┼──────────────────────────────┼────────────┼────────────┤
│ Registries  │ Enable servicebay-templates  │ y          │ ✓          │
│ Email       │ SMTP host/port/user/pass/TLS │ —          │ partial    │
│ Backup      │ Restore .tar.gz path         │ —          │ ✗          │
└─────────────┴──────────────────────────────┴────────────┴────────────┘
```

Non-secret values saved to `build/fcos/install-settings.env` — reused on next run.

## 3. What the Butane Template Provisions

```mermaid
flowchart LR
    subgraph "Ignition writes to disk"
        direction TB
        U[User Account<br/>SSH key + password hash<br/>loginctl enable-linger]
        N[NetworkManager<br/>Static IP keyfile]
        S[Storage Layout<br/>/mnt/data/servicebay/]
        Q[Quadlet File<br/>servicebay.container]
        CF[Config Files<br/>config.json + nodes.json<br/>SSH keypair]
        SU[First-Boot Units<br/>4 oneshot services]
    end

    style U fill:#e3f2fd
    style N fill:#e3f2fd
    style S fill:#e3f2fd
    style Q fill:#fff3e0
    style CF fill:#fff3e0
    style SU fill:#fce4ec
```

## 4. FCOS First Boot Sequence

```mermaid
sequenceDiagram
    participant BIOS
    participant FCOS as Fedora CoreOS
    participant Ign as Ignition
    participant SYS as Systemd (system)
    participant USR as Systemd (user)
    participant SB as ServiceBay Container
    participant API as ServiceBay API

    BIOS->>FCOS: Boot from USB
    FCOS->>FCOS: Auto-select smallest non-USB disk
    FCOS->>FCOS: Install CoreOS to disk
    FCOS->>FCOS: Set disk as first boot device
    FCOS->>BIOS: Reboot

    BIOS->>FCOS: Boot from disk
    FCOS->>Ign: Apply Ignition config

    Ign->>SYS: Write user, network, storage, units
    Ign->>USR: Write servicebay.container Quadlet

    SYS->>SYS: setup-raid.service
    Note right of SYS: Find largest disk → mdadm RAID1<br/>Format XFS → mount /mnt/data<br/>Restore Quadlet backup if exists

    SYS->>SYS: install-python.service
    Note right of SYS: rpm-ostree install --apply-live python3

    SYS->>SYS: restore-usb-boot.service
    Note right of SYS: Set USB as first boot device

    USR->>SB: Start servicebay.container
    Note right of SB: Podman pulls image<br/>ghcr.io/mdopp/servicebay:TAG

    SB->>API: API ready on :3000

    USR->>API: install-nginx.service
    Note right of USR: Wait ≤180s for API health<br/>Wait for agent connection<br/>POST /api/system/nginx/install<br/>(3 retries, skip if exists)
```

## 5. Docker Image Build

```mermaid
flowchart TD
    subgraph "Multi-Stage Dockerfile"
        B[base<br/>node:20-slim<br/>+ python3, make, g++]
        D[deps<br/>npm ci]
        BU[builder<br/>npm run build<br/>Next.js production]
        P[prod-deps<br/>npm ci --omit=dev<br/>+ tsx, typescript]
        R[runner<br/>node:20-slim]
    end

    B --> D --> BU
    B --> P

    BU -->|.next/standalone<br/>.next/static<br/>public/| R
    P -->|node_modules/| R

    subgraph "Also copied into runner"
        direction LR
        T[templates/ stacks/]
        SRC[server.ts src/]
    end
    T --> R
    SRC --> R

    subgraph "Runtime apt packages"
        direction LR
        PKG[openssh-client  python3  python3-paramiko<br/>procps  iproute2  ca-certificates]
    end
    PKG --> R

    style R fill:#c8e6c9
    style BU fill:#e3f2fd
```

**Environment baked into image:**

```
NODE_ENV=production    PORT=3000    HOSTNAME=0.0.0.0
HOST_SSH=host.containers.internal   SSH_KEY_PATH=/root/.ssh/id_rsa
```

Container runs as root internally — `UserNS=keep-id` maps to host's rootless user.

## 6. Startup Procedure

```mermaid
flowchart TD
    subgraph "Phase 1 — Config"
        A1[Load .env files] --> A2[Generate session ID<br/>servicebay-DATE-HEX]
        A2 --> A3[migrateConfig<br/>encrypt sensitive fields]
        A3 --> A4[Read + decrypt config.json]
        A4 --> A5[Set log level]
    end

    subgraph "Phase 2 — Server"
        B1[Init Next.js handler]
        B2[Create Socket.IO server<br/>twin:state · node:status<br/>log:entry · term I/O]
    end

    subgraph "Phase 3 — Agents"
        C1[Read nodes.json] --> C2{For each node}
        C2 --> C3[SSH connect<br/>15s timeout · 10s keepalive]
        C3 --> C4["Deploy agent.py via SSH<br/>base64-encoded Python script"]
        C4 --> C5["systemctl --user enable --now podman.socket"]
        C5 --> C6[Agent pushes state<br/>containers · services · files · resources]
    end

    subgraph "Phase 4 — Background"
        D1[Init PTY sessions]
        D2[Start MonitoringService<br/>gateway · podman.socket · services · agents]
        D3[Start GatewayPoller<br/>every 60s]
        D4[Agent health sync<br/>every 30s]
        D5[Registry sync]
        D6[Schedule agent restart<br/>if configured]
    end

    subgraph "Phase 5"
        E1[Listen on :3000]
    end

    A5 --> B1
    B1 --> B2
    B2 --> C1
    C6 --> D1
    D1 --> D2 --> D3 --> D4 --> D5 --> D6
    D6 --> E1

    style E1 fill:#c8e6c9
    style C4 fill:#fff3e0
    style C5 fill:#fce4ec
```

## 7. Agent Connection Detail

```mermaid
sequenceDiagram
    participant SB as ServiceBay (Node.js)
    participant SSH as SSH Connection
    participant Agent as Python Agent (remote)
    participant Sys as systemd --user
    participant Pod as Podman

    SB->>SSH: Open SSH channel
    SB->>SSH: Send base64(agent.py)
    SSH->>Agent: python3 -u -c 'exec(base64.b64decode(...))'

    Agent->>Sys: systemctl --user enable --now podman.socket
    Agent->>Pod: podman events --format json (stream)
    Agent->>Sys: Watch ~/.config/containers/systemd/ (inotify)

    loop Push on change (debounced 1s)
        Agent->>SB: SYNC_PARTIAL {containers, services, files}
    end

    loop Every 5s (when UI connected)
        Agent->>SB: SYNC_PARTIAL {resources: cpu, ram, disk, net}
    end
```

## 8. System Modifications

```mermaid
flowchart TD
    subgraph "On Every Agent Connection"
        M1["systemctl --user enable --now podman.socket"]
    end

    subgraph "On Service Deploy"
        M2["Write .kube + .yml → ~/.config/containers/systemd/"]
        M3["systemctl --user daemon-reload"]
        M4["systemctl --user start NAME.service"]
        M5["Backup Quadlets → DATA_DIR/quadlet-backup/"]
    end

    subgraph "Only if hostNetwork: true"
        M6["sysctl -w net.ipv4.ip_unprivileged_port_start=0"]
        M7["Persist → /etc/sysctl.d/99-unprivileged-ports.conf"]
    end

    subgraph "FCOS First Boot Only"
        F1["setup-raid: RAID1 + XFS on /mnt/data"]
        F2["install-python: rpm-ostree install python3"]
        F3["install-nginx: Deploy nginx-web template via API"]
        F4["restore-usb-boot: Set USB as first boot device"]
    end

    subgraph "Never Touched"
        N1[Firewall rules]
        N2[SELinux policies]
        N3[System-scope systemd units]
        N4[Root-owned files]
    end

    style M1 fill:#fff3e0
    style M6 fill:#fce4ec
    style M7 fill:#fce4ec
    style F1 fill:#e3f2fd
    style F2 fill:#e3f2fd
    style F3 fill:#e3f2fd
    style F4 fill:#e3f2fd
    style N1 fill:#e8f5e9
    style N2 fill:#e8f5e9
    style N3 fill:#e8f5e9
    style N4 fill:#e8f5e9
```

## 9. Nginx Install Detail (FCOS)

```mermaid
sequenceDiagram
    participant Unit as install-nginx.service
    participant API as ServiceBay API
    participant SM as ServiceManager
    participant Node as Target Node

    Unit->>API: GET /api/system/health (poll ≤180s)
    API-->>Unit: 200 OK

    Unit->>API: GET /api/services (wait for agent)
    API-->>Unit: [...services]

    Unit->>API: POST /api/system/nginx/install
    API->>API: Fetch nginx-web template from registry
    API->>API: Render variables

    Note right of API: PORT=8080  SSL_PORT=8443<br/>ADMIN_PORT=8081<br/>DATA_DIR=/mnt/data

    API->>SM: deployKubeService()
    SM->>Node: Write .kube + .yml files
    SM->>Node: systemctl --user daemon-reload
    SM->>Node: systemctl --user start nginx-web
    SM->>API: Clean up install-nginx oneshot unit
```

## 10. Directory Layout

```
Host filesystem (after FCOS install)
├── /mnt/data/                        ← Persistent storage (RAID)
│   └── servicebay/                   ← DATA_DIR
│       ├── config.json               ← Encrypted app config
│       ├── nodes.json                ← SSH node definitions
│       ├── ssh/
│       │   ├── id_rsa                ← Container→Host SSH key
│       │   └── id_rsa.pub
│       ├── backups/                  ← System backup archives
│       └── quadlet-backup/           ← Quadlet file backup (survives reinstall)
│
└── ~/.config/containers/systemd/     ← Quadlet directory
    ├── servicebay.container          ← ServiceBay itself
    ├── nginx-web.kube                ← Nginx Quadlet
    ├── nginx-web.yml                 ← Nginx Pod YAML
    └── ...                           ← Other deployed services
```

## 11. Container Volumes

```
┌─────────────────────────────────────────────────────────────────┐
│ ServiceBay Container                                            │
│                                                                 │
│  /app/data  ←──────── /mnt/data/servicebay                     │
│                                                                 │
│  /run/user/1000/podman/podman.sock  ←── Host Podman API socket │
│                                                                 │
│  Network: host  (shares host network stack)                     │
│  UserNS: keep-id  (root in container = user on host)           │
└─────────────────────────────────────────────────────────────────┘
```
