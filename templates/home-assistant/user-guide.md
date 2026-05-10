---
lucide_icon: "lightbulb"
tagline: "Control lights, sensors, and smart-home devices from one app — and keep all the data on your home server."
recommended_apps:
  - name: "Home Assistant Companion"
    url: "https://companion.home-assistant.io/"
    platforms: ["ios", "android"]
    note: "Official app — exposes your phone's sensors (location, battery) to HA so automations can react to who's home."
---

# Getting started with Home Assistant

Home Assistant connects to lights, switches, motion sensors, weather stations, and pretty much anything that talks Wi-Fi, Zigbee, Z-Wave, or Matter. Once devices are connected, you can:

- Turn things on/off from your phone or laptop.
- Build automations ("turn on the porch light at sunset").
- See sensor history (temperature, humidity, energy use) over time.

## On your phone (one-time setup)

1. Install **Home Assistant** from the App Store or Play Store (links above).
2. The app asks for a server URL — paste the URL from the *Open* button on this card (e.g. `http://home.home.arpa`).
3. Log in with the family password.
4. The app asks if you want to enable **Location** (so HA knows when you're home), **Sensors** (battery, network, etc.), and **Notifications** — turn on what you're comfortable with.

## In the browser

The web UI has the same dashboard as the app, plus the full configuration interface. The mobile app is for quick "turn off the lights" actions; the browser is where you'd build a new automation or add a new device integration.

## Adding devices

Home Assistant auto-discovers most things on the network. Open *Settings → Devices & Services* and you'll likely see your smart speakers, TVs, robot vacuums, and so on already listed — click to add.

For Z-Wave / Zigbee devices, the admin already plugged the USB stick into the server. Go to *Settings → Devices & Services → Add Integration* and search "Z-Wave JS" or "Zigbee2MQTT".

## Tips

- **Everything stays on the server.** Voice commands, sensor history, automations — none of it goes to a cloud.
- **Voice control via mobile app.** Tap the mic in the iOS / Android app and you can say "turn off the kitchen lights" without picking a device manually.
- **Companion app sensors.** The mobile app exposes *your* phone's sensors (battery, location, motion) to Home Assistant — useful for automations like "turn on the porch light when my phone connects to home Wi-Fi."
