---
lucide_icon: "calendar-days"
tagline: "Calendar and contacts that sync between every device — no separate app, just your phone's built-in Calendar and Contacts."
setup_assets:
  - kind: "ios_calendar_profile"
    label: "One-tap iOS setup"
    description: "Downloads an Apple-standard configuration profile that adds CalDAV + CardDAV accounts. iOS prompts for your username and password during install."
recommended_apps:
  - name: "iOS Calendar / Contacts"
    url: "https://support.apple.com/guide/iphone/use-multiple-calendars-iph3d1110d4/ios"
    platforms: ["ios"]
    note: "Built-in. Add a CalDAV / CardDAV account in Settings — events appear in the native app."
  - name: "DAVx⁵"
    url: "https://www.davx5.com/"
    platforms: ["android"]
    note: "Required CalDAV / CardDAV bridge for Android — once set up, calendars + contacts sync to the stock Calendar and Contacts apps."
  - name: "Thunderbird"
    url: "https://www.thunderbird.net/"
    platforms: ["desktop"]
    note: "Best desktop CalDAV / CardDAV client — works on Windows, macOS, Linux."
---

# Getting started with Calendar & Contacts

Radicale uses standard CalDAV / CardDAV — the same protocols Apple, Google, and Outlook calendars all speak. So you don't install a new app: you tell your phone's existing **Calendar** and **Contacts** apps to talk to your server.

## On iPhone / iPad

1. Open **Settings → Calendar → Accounts → Add Account → Other**.
2. Tap **Add CalDAV Account**.
3. Server: the URL from the *Open* button on this card without the protocol (e.g. `cal.home.arpa`).
4. Username / password: the family ones.
5. Save. Repeat for Contacts via *Settings → Contacts → Accounts → Add Account → Other → Add CardDAV Account*.

Your shared calendars and contacts now appear in the native Calendar and Contacts apps. Any event you add on the phone syncs back to the server (and to every other family device) within a minute.

## On Android

Android's native Calendar app doesn't speak CalDAV directly — install **DAVx⁵** from F-Droid or the Play Store as a one-time bridge:

1. Install **[DAVx⁵](https://play.google.com/store/apps/details?id=at.bitfire.davdroid)**.
2. Open it, tap *+* → *Login with URL and username*.
3. Server URL: same as above (e.g. `https://cal.home.arpa`).
4. Family username + password.
5. Tap *Login*. DAVx⁵ discovers calendars and contacts and asks which to sync.

Now the stock Calendar and Contacts apps see them like any other account.

## On macOS / Windows

Both have native CalDAV / CardDAV support. macOS: *System Settings → Internet Accounts → Add Other Account → CalDAV Account*. Windows: similar via Outlook → *Add Account → Other (CalDAV/CardDAV)*.

## Tips

- **Per-user calendars are separate.** Each family member has their own calendar; shared calendars (e.g. "Family Events") are visible to everyone.
- **Offline-first.** Your phone's Calendar app caches everything locally. Adding events offline works; they sync when the network is back.
- **Privacy.** No data leaves your home — invitations to non-family-members go through email like normal, but the events themselves never touch a cloud calendar.
