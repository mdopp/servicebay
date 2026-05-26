---
lucide_icon: "bot"
tagline: "Chat with your home server's local LLM — same look as ChatGPT, but the conversations never leave your house."
recommended_apps:
  - name: "Open WebUI — installable web app"
    url: "https://docs.openwebui.com/getting-started/quick-start/"
    platforms: [browser, ios, android, desktop]
    note: "Add to home screen on iOS / Android (PWA) for a native-feeling app icon. No download required."
---

# Family chat

Talk to the home server's AI from any device in the house. Same
familiar chat interface as ChatGPT or Claude — except the
conversation goes through your own server, the model runs on your
own GPU, and nothing leaves the network unless you explicitly ask
for it.

## First time

1. Open `https://chat.<your-domain>/` on any phone or laptop on the
   home network.
2. Log in with your family-server account (the same one you use for
   Photos, Files, etc).
3. Pick a model from the dropdown — the default Gemma 4 (26B) is a
   good all-rounder and runs entirely on the household GPU.
4. Start chatting.

## What's good for what

- **Quick questions, drafts, summaries**: `gemma4:26b` or whatever
  the household admin picked as the default.
- **Long stories, coding help**: ask the admin to pull a bigger or
  more specialised model; it'll show up in your dropdown.
- **Sensitive notes** (health, family planning, finances): this is
  *the* path designed for those — the chat never leaves the box.

## What it can't do

- It doesn't know things that happened after the model's training
  cut-off.
- It doesn't browse the web by default. Ask the admin to enable the
  web-search add-on if you want that.
- It can't see attachments unless the admin set up a vision-capable
  model. The dropdown will tell you which.

## Privacy

Conversations are stored on the home server only. The household
admin can read them if they specifically need to (e.g. troubleshooting
a stuck response). There's no analytics, no telemetry, no third
party in the loop.
