# Network Map

## Goal
Visualize and manage the network topology of your containerized environment.

## Key Functions
- **Visualization**: Shows connections between the Router, Nginx Proxy, and Containers.
- **Manual Connections**: Drag and drop to create manual connections between services.
- **Orphan Detection**: Identifies containers that are running but not connected to the gateway.
- **Status Monitoring**: Color-coded indicators for service health (Green = Up, Red = Down).
- **Node Layers**: Toggle individual nodes to isolate remote infrastructures or focus on Local-only services.
- **Route Metadata**: Select any edge to view the underlying proxy rule or port mapping pulled from the Digital Twin snapshot.

> Tip: Use the mini-map to screenshot your topology after running a fresh System Backup so you have visual documentation alongside the archive.
