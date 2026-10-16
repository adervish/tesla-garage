# Tesla Garage

A personal Tesla Fleet API dashboard with vehicle readings, saved snapshots, charging and climate controls, alerts, software notes, optional location, and Solar/Powerwall status. Includes a clearly labeled sample view.

The interface is a compact, plain dashboard with four readings and a Refresh button. Vehicle details are collapsed, connection settings are hidden after sign-in, and the vehicle picker appears only when multiple vehicles are available.

The main dashboard uses Node.js 22.16+ and browser JavaScript without runtime packages. The separate command service uses Tesla’s official Go SDK and Cloudflare Containers. Your existing `CLIENTID` and `CLIENTSECRET` variables in `.env` are supported.

## Cloudflare deployment

The Cloudflare target is https://tesla.dangerously-skipped-permissions.com. Its Tesla allowed origin is that URL, and its allowed redirect URI is:

```text
https://tesla.dangerously-skipped-permissions.com/auth/callback
```

The hosted app runs as a Worker with static assets and one SQLite-backed Durable Object per browser session. Session records, including access/refresh tokens and cached readings, are encrypted with AES-GCM before storage. Sessions survive Worker restarts and deploys, expire after seven days, and are erased on disconnect. API and sign-in requests have an IP rate limit. The alternate workers.dev and preview hostnames are disabled.

To publish updates using the already authenticated Wrangler CLI:

```sh
node --test
node scripts/deploy.mjs
```

The deployment script publishes the Worker, static files, and custom domain from `wrangler.jsonc`, then uploads `CLIENTID`, `CLIENTSECRET`, and the session encryption key as Cloudflare secrets. The `.env` and private key are never included in the static upload. `data/cloudflare-secrets.json` is a private local backup; retain its encryption key across deployments so existing sessions remain readable. Restore that file before deploying from a different checkout.

The signed command backend is the private `tesla-garage-commands` Worker and one Cloudflare Container, reached only through the main Worker's `COMMANDS` service binding. It sleeps after one minute of inactivity. The image contains Tesla's official SDK pinned to commit `a4b43c1eff0e09d77deb9f2dce97031141fe8c8a`. The command key enters as a Cloudflare secret at runtime and is never built into the image. Command logs are disabled. Only the implemented commands are allowed; there is no generic proxy route.

To update the command service with Docker running:

```sh
npm install --prefix command-proxy
wrangler deploy --config command-proxy/wrangler.jsonc
wrangler secret put TESLA_PRIVATE_KEY --config command-proxy/wrangler.jsonc < data/private-key.pem
```

The existing deployed command key is already configured. Preserve the same key pair used for Tesla registration and vehicle pairing. Main dashboard code changes can be published with `wrangler deploy`, which retains all secret bindings.

The public registration key is served at:

```text
https://tesla.dangerously-skipped-permissions.com/.well-known/appspecific/com.tesla.3p.public-key.pem
```

After the Tesla app has the matching allowed origin and callback, run `node scripts/tesla.mjs register` to register the domain, then sign in on the hosted app. Deployment does not bypass Tesla's credential validation or user consent.

## Run locally

```sh
node server.mjs
```

Open http://localhost:3000. Choose **View sample** to preview the dashboard without contacting Tesla. `npm start` also works when npm is configured normally, but npm is not required.

For development with automatic server restarts: `node --watch server.mjs`. Restart the server after editing `.env`.

## Connect a real Tesla

Client credentials identify the application. Personal vehicle access also requires Tesla account authorization and application domain registration.

1. Keep the existing `.env`; do not replace your credentials. `APP_URL` is configured for the Cloudflare address above. For a separate self-hosted deployment, use a domain you control through an HTTPS reverse proxy or tunnel. The local process listens on `127.0.0.1:3000` by default. Keep the original Host header when proxying. Use the public URL in your browser when signing in.
2. In the Tesla developer portal, set the allowed origin to that same origin and the allowed redirect URI to `https://your-domain.example/auth/callback`. Enable **Vehicle Information**. The app requests only `openid offline_access vehicle_device_data`.
3. Generate the registration key pair:

   ```sh
   node scripts/tesla.mjs keys
   ```

   The private key is stored in `data/private-key.pem` with restrictive permissions; `data/` is ignored by Git. Only the public key is served, at `/.well-known/appspecific/com.tesla.3p.public-key.pem`. Re-running this command preserves an existing key pair. Keep this public URL accessible after registration.

4. Check the credentials and register the domain once its public key is reachable:

   ```sh
   node scripts/tesla.mjs check
   node scripts/tesla.mjs register
   ```

   The registration command verifies the hosted public key matches before contacting Tesla. It registers in the configured API region. If the app is already registered with another key pair, restore that existing pair instead of replacing it.

5. Review the API billing setup and limit in your Tesla developer account. Open the app at `APP_URL` and click **Connect with Tesla**. Complete Tesla's sign-in and consent screen. Selecting a vehicle now restores saved readings and checks for new readings automatically. **Refresh** requests another update, with successful reads cached for 60 seconds.
6. For Wake and remote controls, enable **Vehicle Commands** and **Vehicle Charging Management** in the Tesla developer portal. Open **Vehicle controls → Enable controls** and grant the added permissions. Use **Pair vehicle key** in the Tesla mobile app for the selected vehicle, then **Check setup**. Wake only runs when pressed. A car without connectivity may remain offline.
7. Location and energy have separate **Enable** links and require **Vehicle Location** or **Energy Product Information** to be enabled in the Tesla developer portal. Optional permission upgrades retain already granted feature scopes in the authorization request. Reconnecting begins a new app session, so download history before reconnecting if you want to keep it.

`TESLA_REGION=na` is the default for North America and Asia-Pacific excluding China. Use `eu` for Europe, Middle East, and Africa; register in that region too. China requires a separate Tesla application and is not implemented in this starter.

The localhost page works for preview. Live sign-in uses your registered origin and an exactly matching callback; this project does not assume Tesla accepts localhost callbacks. `.env.example` documents the configuration without any real credentials.

## Behavior and limits

- Secrets and OAuth tokens remain on the server. Browser cookies contain random session credentials with HttpOnly and SameSite protection; HTTPS cookies are Secure. Sessions last up to seven days. Cloudflare sessions persist in encrypted Durable Object storage; the local Node server uses memory, so restarting the local process disconnects its accounts. Disconnect removes the app session; revoke the app in your Tesla account to remove Tesla's consent permanently.
- Vehicle lists and successful readings are cached for 60 seconds per browser session. Repeated concurrent requests are combined. Opening or switching vehicles requests one refresh; there is no continuous polling or automatic wake-up. Offline checks are not cached, so Refresh can immediately detect a car that has woken. The vehicle list displays the first API page (up to 100 vehicles).
- Last successful readings survive offline checks and Cloudflare restarts until disconnect or session expiry. Current connectivity and the received timestamp are displayed separately. Up to 200 snapshots per vehicle (25 vehicles, with an additional overall storage bound) are retained in the encrypted session. Saved readings can be viewed and downloaded as CSV. They are not continuous telemetry or a complete trip log.
- Tokens refresh automatically, with concurrent refreshes combined and replacement refresh tokens kept in the session. Network and API errors are shown without exposing provider response bodies or credentials.
- Supported commands: wake, start/stop charging, charge limit/current, start/stop climate, temperature, lock/unlock, Sentry on/off, charge-port open/close, flash lights, and horn. The server validates command names, parameters, and granted scope. Unconfirmed command requests are not automatically retried by the dashboard. Unlock, horn, and disabling Sentry have explicit UI confirmation.
- Extra information includes tire pressure, door/window/trunk openings, outside temperature, charging power/energy/current, recent alerts, and software release notes. Unavailable measurements remain unknown. Location opens a map only after explicit location consent; energy status requires separate energy consent. Fleet Telemetry, continuous trip logging, automatic notifications, and schedules are not implemented.
- The local server is a single-process starter. The Cloudflare deployment adds persistent encrypted sessions and request rate limits. Only the explicitly listed public assets are served; `.env`, source files, and private keys cannot be downloaded through the app.

## Verification

```sh
node --test
node scripts/runtime-check.mjs
```

The automated tests use fake credentials and a simulated Tesla server to cover OAuth state validation, token rotation, request isolation, caching, sleeping vehicles, and Cloudflare persistence, encryption, and expiry. They do not call Tesla or affect a vehicle. Real account authorization must be completed in a browser.

The runtime check requires Wrangler (or Miniflare) and runs the actual Worker and Durable Object in workerd with a simulated Tesla service. It verifies OAuth exchange, vehicle requests, redirect rejection, and logout using the configured compatibility date.

After deployment, run `node scripts/live-check.mjs` for HTTPS, configuration, and session checks. Run `node scripts/auth-check.mjs` to verify that the deployed callback can reach Tesla: it sends an intentionally invalid authorization code and requires Tesla's explicit rejection, without obtaining a user token or accessing vehicles. Both scripts disconnect their own test sessions afterward.

The optional `scripts/browser-check.mjs` uses an isolated Chrome instance on debugging port 9228. It checks sample mode, refresh, vehicle switching, collapsed details, empty lists, logout, and mobile layout. Connected browser checks intercept API requests with fabricated data and do not access a real vehicle.

## References

- [Tesla third-party OAuth](https://developer.tesla.com/docs/fleet-api/authentication/third-party-tokens)
- [Partner authentication](https://developer.tesla.com/docs/fleet-api/authentication/partner-tokens)
- [Domain registration](https://developer.tesla.com/docs/fleet-api/endpoints/partner-endpoints)
- [Virtual key setup](https://developer.tesla.com/docs/fleet-api/virtual-keys/developer-guide)
- [Vehicle endpoints](https://developer.tesla.com/docs/fleet-api/endpoints/vehicle-endpoints)
- [Usage guidance](https://developer.tesla.com/docs/fleet-api/getting-started/best-practices)
- [Regions](https://developer.tesla.com/docs/fleet-api/getting-started/regions-countries)
