# Haze Tracker SG

A progressive web app showing the 24-hour PSI and 1-hour PSI for each region of Singapore
(central, north, south, east, west), with a configurable alert threshold.

- **Data:** NEA real-time feeds via data.gov.sg (`/v2/real-time/api/psi` and `/pm25`), no API key needed.
- **24-hr PSI:** published by NEA.
- **1-hr PSI:** NEA publishes only the 1-hr PM2.5 concentration, so the 1-hr PSI is an *estimate*
  using NEA's PM2.5-to-PSI breakpoints (12, 55, 150, 250, 350, 500 ug/m3 = PSI 50, 100, 200, 300, 400, 500).
- **Alerts:** pick a region (or "any region"), a measure (24-hr or 1-hr) and a PSI threshold.
  One notification is sent when the value reaches the threshold; it re-arms once it drops below.

## Run / deploy

Static files only. Serve over HTTPS (service workers, install and notifications require it), for example GitHub Pages:
Settings > Pages > Deploy from branch > `main` / root. All paths are relative, so it works under `/haze-tracker/`.

Local: `python3 -m http.server 8000` then open http://localhost:8000 (localhost counts as secure).

## Add to home screen

- **Android (Chrome):** menu > Install app (or use the in-app Install button).
- **iPhone (Safari):** Share > Add to Home Screen. Open it from the Home Screen to enable alerts (iOS 16.4+).

## Notification limits (no push server)

Alerts are evaluated by the app, not a server:

- While the app is open: every 5 minutes and whenever you return to it.
- Android Chrome, installed app: also in the background via Periodic Background Sync, roughly hourly (Chrome decides).
- iPhone: no background checks without a push server, so alerts fire only while the app is open.

Truly reliable background alerts need a small server that polls NEA and sends Web Push.

## Files

`index.html`, `styles.css`, `app.js` (UI), `core.js` (data + alert logic, shared with the service worker),
`sw.js` (offline cache + background check), `manifest.webmanifest`, `icons/`.
