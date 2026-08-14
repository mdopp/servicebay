---
title: Connect a local MQTT device to Home Assistant (no vendor cloud)
whenToUse: A device speaks MQTT natively (smart lock, plug, relay, sensor, Zigbee/Tasmota bridge) and you want it in Home Assistant over the local network, with no manufacturer cloud and no bridge hardware.
kind: recipe
tags: [mqtt, mosquitto, home-assistant, iot, discovery, local-control, broker, devices]
---

# Connecting a local MQTT device to Home Assistant

Many home devices can publish straight to an MQTT broker on your own network
instead of the manufacturer's cloud, and most of those also ship
**Home-Assistant discovery** — they announce themselves, and the entities
appear with no YAML. That path needs three things in place, in this order:

1. a broker running on the box, with credentials;
2. Home Assistant pointed at the broker;
3. the device pointed at the broker.

Do them in that order. Each step is verifiable on its own, and a failure at
step 3 is unambiguous once 1 and 2 are known good.

## 0. Check the device actually speaks MQTT natively

Look in the device's own app or web UI for an MQTT section (host, port,
username, password). If it is there, no bridge hardware and no cloud account
is needed. Some vendors gate it behind a firmware version or an "advanced"
toggle — check before buying a bridge you do not need.

Caveat worth knowing up front: enabling native MQTT on some devices **disables
the vendor's own app integration** while it is on. Read the device's own note
on that before flipping it.

## 1. Stand up the broker

Install the MQTT broker template (`mosquitto`). It is infrastructure, not an
accessory — one broker serves every MQTT device you will ever add, so do not
install one per device.

Two things to get right at install time:

- **Credentials are mandatory; anonymous access stays off.** This is not
  ceremony. Whoever can reach an open broker can command whatever publishes on
  it, and that list may include a door lock. Express them as `type: "secret"`
  variables so the wizard generates and injects them — never a literal in a
  committed file.
- **The port must be published on the LAN.** Devices connect *inward*, from
  Wi-Fi to the broker. A loopback-only bind means no device can ever connect.
  Per ADR 0007 that means an isolated network namespace plus a `hostPort` — not
  `hostNetwork`.

Save the generated username and password from the credentials banner. You will
type them twice more.

**If Home Assistant runs as a container** (not Home Assistant OS), there is no
add-on store, so every "install the Mosquitto add-on" guide on the internet is
inapplicable. The broker is its own service. This trips people for an hour.

## 2. Point Home Assistant at the broker

Settings → Devices & Services → Add integration → MQTT. Broker host, port,
username, password; leave discovery enabled.

**The host is the part everyone gets wrong.** From inside a container,
`localhost` is that container — not the box. On a ServiceBay box, one
container reaches another through `host.containers.internal` (ADR 0007
Decision 3), which Podman writes into every container's `/etc/hosts`. Never a
hardcoded IP, never the LAN-IP variable: rootless Podman refuses the host's own
LAN address from an isolated pod, and a hardcoded IP breaks the day DHCP moves
the box.

Success here looks like the integration going green immediately. If it does
not, stop — do not start configuring the device. Check the broker's logs
(`get_logs`); a wrong password shows up there as a rejected connection, which
distinguishes "bad credentials" from "cannot reach the host" cleanly.

## 3. Point the device at the broker

In the device's MQTT settings, enter **the box's LAN address** (not
`host.containers.internal` — that name only exists inside containers), the
port, and the same username and password. Turn on its "Home Assistant
discovery" switch if it has one.

Within seconds the device should appear in Home Assistant as a device with
entities. If it connects but nothing appears, discovery is off on one of the
two sides.

## Verifying, in order

Work outside-in; each step rules out everything before it.

1. **Broker up?** The service's health check is a TCP connect to its port.
2. **Home Assistant connected?** The MQTT integration reports connected.
3. **Device connected?** The broker log shows a *new client connected* line
   with the device's client ID. This is the single most useful signal — it
   separates "the device never reached the broker" (network/host wrong) from
   "it connected but published nothing useful" (discovery/topic issue).
4. **Discovery arrived?** In Home Assistant, MQTT integration →
   **Listen to a topic** → subscribe to `homeassistant/#`. Discovery payloads
   scroll past. Nothing there means the device is not announcing itself.
5. **Device talking?** Subscribe to `#` briefly to see every topic. Useful
   once; noisy as a habit.

## The traps

- **`localhost` from inside a container.** It is the container. Use
  `host.containers.internal` for container→host, and the box's LAN address for
  device→box. The two are different answers to the same-sounding question.
- **Loopback-binding the broker port.** Fine for a service the reverse proxy
  fronts; fatal here, because the traffic originates on the device side.
- **A broker with anonymous access "just to test".** It never gets turned back
  on, and the blast radius is device control, not data.
- **Two clients sharing a client ID.** MQTT allows exactly one connection per
  client ID; the second kicks the first, and they flap forever. Symptom: a
  device that connects and drops in a loop.
- **No persistence.** Device state lives in *retained messages* the broker
  holds. Without a persistent store, every restart blanks them, and Home
  Assistant shows `unknown` until each device happens to publish again — hours,
  for a battery device. Enable persistence and put its directory on a host
  path that outlives the container.
- **Assuming TLS is available.** Encrypting MQTT only helps if the device can
  be made to trust the certificate, and consumer IoT firmware usually offers no
  way to install a private CA. If you run plain MQTT, say so plainly to the
  operator: the broker password crosses the LAN in the clear, so it must not be
  a password reused anywhere else. Do not ship a TLS listener the devices will
  silently bypass and call it secure.
- **Deleting the device in Home Assistant does not remove it.** Discovery
  re-creates it from the retained announcement. To really remove it, publish an
  empty retained message to its discovery topic (or turn discovery off on the
  device first).

## Where the credentials live

One broker username/password is shared by Home Assistant and every device — a
per-device account is possible but rarely worth the management. Treat it as a
device password: written into several devices' configs, potentially readable on
the wire, and therefore never reused for anything else. Rotating it means
re-entering it everywhere, so generate a strong one once rather than a
memorable one you will want to change.
