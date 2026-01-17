# Home Assistant Stack

This stack combines the three core components of a modern smart home into a single, highly integrated Unit:

1.  **Home Assistant**: The core automation hub.
2.  **Z-Wave JS UI**: The driver for your Z-Wave USB Stick.
3.  **Matter Server**: The connectivity layer for Matter devices.

## Features
*   **Host Network**: All services run on the host network for optimal auto-discovery (mDNS, UPnP, Thread).
*   **Integrated Storage**: All data is persisted under `${DATA_DIR}/home-assistant/` (see template settings).
*   **USB Passthrough**: The Z-Wave stick is mapped via the `ZWAVE_DEVICE` variable.

## Configuration
*   **DATA_DIR**: Base directory for stack data (default: `/mnt/data`). Changes apply to new deployments.
*   **ZWAVE_SECRET**: A random string for session security.
*   **ZWAVE_DEVICE**: The absolute path to the USB device (e.g., `/dev/serial/by-id/usb-0658_0200-if00`).

## Usage
Deploy this stack via ServiceBay. The services will be available at:
*   Home Assistant: `http://<server-ip>:8123`
*   Z-Wave JS UI: `http://<server-ip>:8091`
*   Matter Server: (WebSocket only)
