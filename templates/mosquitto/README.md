# Mosquitto — MQTT Broker

A message broker for the small devices in your home. Smart locks, plugs,
relays, sensors and Zigbee/Z-Wave bridges publish their state to a broker and
take commands back from it; Home Assistant subscribes to the same broker and
picks the devices up — many of them fully automatically, via MQTT discovery.

The point of running one yourself is that the devices talk to **your box**
instead of the manufacturer's cloud: no vendor account in the loop, and the
devices keep working when your internet does not.

This is infrastructure, not an accessory for one device. One broker serves
every MQTT device you will ever add.

> **Home Assistant here is a container, not Home Assistant OS.** There is no
> add-on store, so the usual "install the Mosquitto add-on" instructions do not
> apply — the broker is its own ServiceBay service, which is this template.

## Variables

| Variable | Description | Default |
|---|---|---|
| `MQTT_PORT` | TCP port the broker listens on | `1883` |
| `MQTT_USERNAME` | Broker username — auto-generated, editable before deploy | generated |
| `MQTT_PASSWORD` | Broker password — auto-generated, shown once in the credentials banner | generated |

Both credentials appear in the **SAVE-THESE-NOW** banner (and the Bitwarden CSV)
right after install. You need them again for every device you add, so save them.

Both are generated **device-safe**: letters and digits only, 24 characters. The
strength is in the length (~142 bits — nothing brute-forces that), not in
punctuation, because these values have to survive being typed into a smart
lock's app. Device firmware routinely rejects symbols or silently cuts a long
password short, and then reports your perfectly correct credentials as *wrong
username or password*. If you replace them with your own, keep to letters and
digits and stay around this length.

## Which host do I enter?

This is the question that eats an evening. There are two right answers,
depending on who is connecting:

| Connecting from | Host to enter | Port |
|---|---|---|
| A device on your Wi-Fi (lock, plug, sensor, Zigbee bridge) | your box's LAN address | `1883` |
| Home Assistant, or any other container on this box | `host.containers.internal` | `1883` |

`host.containers.internal` is the name Podman writes into every container's
`/etc/hosts` for the host itself. It is the address ServiceBay standardises on
for container-to-container traffic (ADR 0007) — it keeps working if the box's
LAN address changes and if a service later moves between host and isolated
networking, which a hardcoded IP does not.

## Connecting Home Assistant

Settings → Devices & Services → **Add integration** → MQTT:

```
Broker  : host.containers.internal
Port    : 1883
Username: <MQTT_USERNAME from the credentials banner>
Password: <MQTT_PASSWORD from the credentials banner>
```

Leave **Enable discovery** on. Devices that ship Home-Assistant discovery (most
modern MQTT devices do) then appear as entities on their own, with no YAML.

## Connecting a device

In the device's own app or web UI, find its MQTT settings and enter the box's
LAN address, port `1883`, and the same username and password. Devices that
support discovery usually have a "Home Assistant discovery" switch — turn it on
and the entities show up in Home Assistant within a few seconds.

If the device offers a *client ID*, any unique name is fine; if it offers a
*topic prefix*, keep the device's own default unless you have a reason.

## Security: credentials are mandatory, and there is no TLS

**Anonymous access is off and cannot be switched on from the wizard.** Every
client must send the username and password. That matters more here than for a
typical web app: whoever can talk to a broker can send commands to whatever
publishes on it — and that may be your front door lock. A broker with
`allow_anonymous true` on a home LAN is an open remote control for your house.

**This broker does not use TLS, and that is a deliberate decision.**

Why: TLS on MQTT only helps if the *device* can be made to trust the
certificate. There is no publicly-trusted certificate for a name or IP on your
LAN, so the alternative is a private certificate authority that must be
installed on every device — and consumer IoT firmware (smart locks, plugs,
sensors) generally offers no way to install one. Shipping a TLS listener that
most devices cannot use would not make anything safer; it would produce a
broker where the important devices silently fall back to the plain port, plus
a confusing second port and a certificate to renew. So the template ships one
honest plain listener rather than a half-usable encrypted one.

**What that costs you, plainly:** the broker password, and everything your
devices say to each other, travel your home network unencrypted. Someone who
is already on your Wi-Fi and can capture traffic could read the password and
then command your devices. Someone outside your network cannot: the port is
published on your LAN only, and nothing forwards it through your router.

So: run this on a network you control, keep untrusted guests on a guest Wi-Fi,
and **do not reuse this password anywhere else** — treat it as a device
password that could one day be read off the wire, not as a secret.

If you do have devices that support TLS and you are willing to manage a
certificate authority for them, add a second `listener 8883` with
`cafile`/`certfile`/`keyfile` to the config block in `template.yml` and mount
the certificates in. That is a deliberate local change, not a supported
variable — and it does not remove the plain listener the other devices need.

## Restarts and retained messages

MQTT devices publish their current state as a *retained message*: the broker
keeps the last one per topic and hands it to whoever subscribes next. That is
how Home Assistant knows a lock is locked without waiting for it to say so
again.

Persistence is on (`persistence true`, saved every 30 s), and the store lives
on a host path outside the container, so retained messages and queued QoS 1/2
messages survive a container restart, a re-deploy, and a box reboot. Without
it, every reboot would leave each device's state unknown until it happened to
publish again — which for a battery device can be hours.

## Data layout

```
{{DATA_DIR}}/mosquitto/data/mosquitto.db   ← retained messages + queued QoS state
```

The config and the password file are **not** on the host: they are rendered
into the pod from this template on every deploy, so they can never drift out of
sync with the wizard's variables. Changing the username or password means
re-deploying from the wizard (and re-entering them on your devices) — editing a
file inside the container is lost on the next re-render.

## Networking

The pod runs in its own network namespace (ADR 0007 Decision 1), and publishes
`1883` on every interface via `hostPort`. That is required rather than
incidental: devices open connections *to* the broker from the Wi-Fi, so a
loopback-only bind would mean no device could ever connect. The broker's own
credentials are what protects the port.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Service won't start, log says credentials are required | The username or password variable is empty. Re-run the wizard; the broker refuses to start without auth rather than come up open. |
| Home Assistant: "unable to connect" | Wrong host. From a container it is `host.containers.internal`, not `localhost` — `localhost` inside a container is that container. |
| Device says the username or password is wrong, but Home Assistant connects with the same ones | Believe the broker, not the device: its log shows `disconnected: not authorised` for that client. The credentials are fine — the device is mangling them, usually by cutting an over-long password short. Give it a shorter, letters-and-digits-only password (24 characters is plenty) and re-enter it everywhere. |
| Device connects, then drops repeatedly | Two clients using the same client ID. Give each device a unique one. |
| Device connects but nothing appears in Home Assistant | Discovery is off on the device, or Home Assistant's MQTT integration was added with discovery disabled. |
| State is wrong or "unknown" right after a reboot | Expected only until the device republishes — if it persists, check that `{{DATA_DIR}}/mosquitto/data` is writable. |
