# Cloudflare deployment — updated 2026-10-16

- URL: https://tesla.dangerously-skipped-permissions.com
- Worker: `tesla-garage`
- Verified deployed version: `f3d831de-de36-42ac-90e9-a8af23636357`
- Routing: Cloudflare custom domain, with workers.dev and preview URLs disabled.
- Browser callback: https://tesla.dangerously-skipped-permissions.com/auth/callback
- Public key: https://tesla.dangerously-skipped-permissions.com/.well-known/appspecific/com.tesla.3p.public-key.pem
- Secret bindings: `CLIENTID`, `CLIENTSECRET`, `SESSION_ENCRYPTION_KEY`. No secret values are included in code, assets, or this note.
- Session storage: separate SQLite Durable Objects, AES-GCM encrypted records, seven-day session expiry, alarms for cleanup, and immediate deletion on disconnect.

Validation completed:

- All 18 automated tests passed, including OAuth security, durable session behavior, specific sanitized sign-in errors, and upstream redirect rejection.
- The actual Worker and Durable Object passed a workerd runtime check covering OAuth exchange, authenticated vehicle list/data, redirect protection, and logout against a simulated Tesla service.
- The deployed OAuth callback reached Tesla and received the expected rejection of an intentionally invalid authorization code. No user token or vehicle access was requested.
- The live HTTPS homepage, configured secret presence, exact callback, and public key were verified.
- Public `.env`, private-key, and source-file paths return 404; unauthenticated vehicle requests return 401; cross-origin logout returns 403.
- Live sign-in initialization returns the Tesla authorization redirect and a Secure/HttpOnly cookie. Invalid callbacks are rejected. Test login sessions were disconnected after verification.
- Desktop and mobile browser checks passed against the public site with no browser console errors. Screenshots are in the ignored `assets/screenshots/` directory.

The deployment initially revealed that Durable Object fetch bindings follow redirects by default. Internal session requests now explicitly use manual redirects, and a regression test covers this. `no-transform` prevents the zone's automatic analytics script injection from conflicting with the app's content security policy; no zone-wide settings were changed.

The user corrected the client secret in `.env`. Tesla accepted the updated credential pair and successfully registered `tesla.dangerously-skipped-permissions.com` in the North America region. The updated credentials were uploaded to Cloudflare while preserving the session encryption key. Live checks passed after the secret deployment. The remaining user step is to start a fresh Connect with Tesla flow and complete account authorization; real vehicle access has not yet been exercised.

References used for deployment: [Cloudflare custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), [secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [Durable Object invocation](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/), and [automatic analytics injection](https://developers.cloudflare.com/web-analytics/faq/).

Sign-in troubleshooting history: the original credential pair failed Tesla's token check with `unauthorized_client`. The live app matched the local client ID and expected callback. Updating the client secret resolved that rejection. The app also now distinguishes known credential, authorization-code, callback, permission, and availability failures using fixed messages, without forwarding provider descriptions. The changes and live smoke checks passed. No secret values were printed or included in source files.

The subsequent `tesla_unreachable` failure was an application/runtime compatibility bug: this Workers runtime rejects `redirect: 'error'` before sending a network request. The shared Tesla HTTP helper now uses `redirect: 'manual'` and explicitly rejects 3xx responses without forwarding credentials. This was reproduced in workerd, fixed, deployed, and verified through the live callback. Existing secrets and the session encryption key were preserved. The user must start a fresh sign-in because prior callback state has already been consumed.

2026-10-16: the user confirmed sign-in is working. Deployed the simplified dashboard: plain white layout, four key readings, one Refresh button, collapsed vehicle details, and setup hidden for connected users. The vehicle picker appears only for multiple vehicles. All 18 existing tests passed. Browser checks passed locally and on the deployed site at desktop and mobile sizes, including refresh, switching, empty lists, and logout with simulated API responses. The production HTTPS/security/session checks also passed. This deployment changes only the interface; existing secret bindings and encrypted sessions are retained.


2026-10-16 feature expansion: the screenshot showed an offline vehicle and no readings. The app now automatically requests readings on vehicle selection, restores retained snapshots, distinguishes current connectivity from saved data, and does not cache offline checks. Added Wake, 14 signed command types, more vehicle/charging details, snapshot history/CSV, alerts, release notes, optional location, and optional energy status. Optional OAuth upgrades preserve earlier granted feature scopes. The app requires users to explicitly enable new Tesla permissions and pair the vehicle key before signed commands can work.

Private command service: `tesla-garage-commands`, deployed version `c54e7f21-2962-469d-be06-75ab0f3b1f68`, container application `a03052e9-1389-4bc1-8de3-a0ee74d695f7`. One basic instance maximum, one-minute idle sleep, no public workers.dev/preview/custom route. The main Worker invokes it through the `COMMANDS` service binding. Tesla's official SDK is pinned and its Apache license is included. `TESLA_PRIVATE_KEY` was uploaded directly from the existing private-key file as a runtime secret; it is not in the image or source.

Validation for this release: all 26 automated tests passed, including input/scope validation, offline snapshot retention, command forwarding, location consent, energy data, and alerts/notes normalization. The actual workerd runtime passed OAuth, reading, snapshot, command-service-binding, redirect, and logout checks. Browser tests passed locally and on production, with simulated vehicle data/actions, at desktop and mobile sizes. Live HTTPS/session/security checks passed. The command container passed local health/auth/allowlist checks and its real Cloudflare health endpoint returned HTTP 200 through a temporary remote service-binding probe. No vehicle command was sent to the user's car during verification. Live vehicle data and commands still require the user's online vehicle and the necessary consent/key pairing.
