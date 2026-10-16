# Feature status — 2026-10-16

Implemented and deployed:

- Automatically restore saved readings and request a fresh reading when opening/selecting a vehicle. Successful data calls are cached for one minute; offline checks are not cached and do not wake the vehicle.
- Retain previous readings with timestamps while the vehicle is asleep/offline. Store up to 200 snapshots per vehicle, subject to session storage bounds, and export CSV.
- Wake after granting Vehicle Commands. Charging start/stop, limits/current, climate start/stop/temperature, lock/unlock, Sentry, charge port, lights, horn through Tesla's official signing SDK in a private Cloudflare Container.
- Added permission-upgrade links and per-vehicle virtual-key pairing; existing optional permissions are preserved in subsequent authorization requests.
- Tire pressures, doors/windows/trunks, outside temperature, software update, charger voltage/current/power/energy/time.
- Recent alerts and software release notes, loaded on demand.
- Optional vehicle location with an external map link after location consent.
- Optional Solar/Powerwall product list and live site status after energy consent.

Remaining potential additions: Fleet Telemetry for continuous history and notifications, charging/preconditioning schedules, navigation destinations, and richer energy history. These are not represented as working features in the app.

Official references:

- [Authentication and scopes](https://developer.tesla.com/docs/fleet-api/authentication/overview)
- [Vehicle endpoints](https://developer.tesla.com/docs/fleet-api/endpoints/vehicle-endpoints)
- [Vehicle commands](https://developer.tesla.com/docs/fleet-api/endpoints/vehicle-commands)
- [Virtual keys](https://developer.tesla.com/docs/fleet-api/virtual-keys/developer-guide)
- [Official command SDK](https://github.com/teslamotors/vehicle-command)
- [Energy endpoints](https://developer.tesla.com/docs/fleet-api/endpoints/energy)
- [Fleet Telemetry](https://developer.tesla.com/docs/fleet-api/fleet-telemetry)
- [Cloudflare Containers](https://developers.cloudflare.com/containers/get-started/)

The dedicated charging-history endpoint documents business-fleet-only availability; personal charging history here is collected from app snapshots rather than assuming access to that endpoint.
