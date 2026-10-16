export const TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
export const AUTHORIZE_URL = 'https://auth.tesla.com/oauth2/v3/authorize';

export class AppError extends Error {
  constructor(status, message, code = 'request_failed') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const tokenFailures = new Map([
  ['unauthorized_client', ['credentials', 'Tesla rejected the app credentials (unauthorized_client). Check the matching CLIENTID and CLIENTSECRET in the Tesla developer portal.']],
  ['invalid_client', ['credentials', 'Tesla rejected the app credentials (invalid_client). Check the matching CLIENTID and CLIENTSECRET in the Tesla developer portal.']],
  ['invalid_auth_code', ['authorization_code', 'Tesla did not accept the sign-in code. Start a new sign-in from the app.']],
  ['invalid_grant', ['authorization_code', 'Tesla did not accept this authorization. Start a new sign-in from the app.']],
  ['invalid_redirect_url', ['redirect_uri', 'Tesla rejected the callback URL. Check that the allowed redirect URI exactly matches the app callback.']],
  ['invalid_redirect_uri', ['redirect_uri', 'Tesla rejected the callback URL. Check that the allowed redirect URI exactly matches the app callback.']],
  ['invalid_scope', ['permissions', 'Tesla rejected the requested permissions. Enable Vehicle Information for this Tesla application.']],
  ['login_required', ['login_required', 'Tesla requires a new sign-in. Connect your account again.']],
]);
const callbackCodes = new Set([...tokenFailures.values()].map(([code]) => code));
callbackCodes.add('tesla_unavailable');
callbackCodes.add('tesla_unreachable');

export function oauthCallbackCode(error) {
  return error instanceof AppError && callbackCodes.has(error.code) ? error.code : 'authorization';
}

const fleetErrors = {
  401: 'Your Tesla session has expired. Connect your Tesla account again.',
  402: 'Review payment and the API spending limit in your Tesla developer account.',
  403: 'Tesla denied access. Enable the required permissions in the Tesla developer portal, then reconnect and grant access to this vehicle.',
  404: 'Tesla could not find this vehicle.',
  408: 'The vehicle is unavailable. Open the Tesla app to check its status, then try again.',
  412: 'Register your app domain with Tesla first. See the connection setup and README.',
  421: 'This account is in a different region. Update TESLA_REGION in .env and reconnect.',
  429: 'Tesla is limiting requests. Wait before trying again.',
  451: 'Tesla cannot provide this data in the selected region.',
};

export async function requestJson(url, options = {}, fetchImpl = fetch) {
  let response;
  const { timeoutMs = 20_000, ...requestOptions } = options;
  try {
    response = await fetchImpl(url, {
      ...requestOptions, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new AppError(502, 'Could not reach Tesla. Please try again shortly.', 'tesla_unreachable');
  }
  // Workers on our compatibility date reject redirect: 'error' before sending
  // the request. Reject redirects explicitly so credentials are never forwarded.
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw new AppError(502, 'Tesla returned an unexpected redirect. Please try again shortly.', 'tesla_unavailable');
  }
  let body;
  try { body = await response.json(); }
  catch { body = {}; }
  return { response, body };
}

export async function tokenRequest(config, parameters, fetchImpl = fetch) {
  const { response, body } = await requestJson(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.clientId, ...parameters }),
  }, fetchImpl);
  if (!response.ok) {
    const rejected = [400, 401, 403].includes(response.status);
    const known = rejected && tokenFailures.get(body?.error);
    if (known) throw new AppError(401, known[1], known[0]);
    const credentialGrant = parameters.grant_type === 'client_credentials';
    throw new AppError(rejected ? 401 : 502,
      rejected ? credentialGrant
        ? 'Tesla could not authorize this application. Check its credentials and enabled grant types in the Tesla developer portal.'
        : 'Tesla could not authorize this connection. Check the app credentials and callback URL, then sign in again.'
        : 'Tesla sign-in is temporarily unavailable. Please try again.',
      rejected ? 'authorization_failed' : 'tesla_unavailable');
  }
  if (typeof body?.access_token !== 'string' || !body.access_token || !Number.isFinite(Number(body.expires_in)) || Number(body.expires_in) <= 0) {
    throw new AppError(502, 'Tesla returned an incomplete sign-in response. Please try again.');
  }
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    expiresAt: Date.now() + Number(body.expires_in) * 1000,
    scopes: tokenScopes(body.access_token, body.scope),
  };
}

export function tokenScopes(token, supplied) {
  let scopes = supplied;
  if (!scopes) {
    try {
      const encoded = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')));
      scopes = payload.scp || payload.scope;
    } catch { return []; }
  }
  return (Array.isArray(scopes) ? scopes : typeof scopes === 'string' ? scopes.split(/\s+/) : []).filter((scope) => typeof scope === 'string');
}

export async function accessToken(session, config, fetchImpl = fetch, force = false) {
  if (!session.tokens) throw new AppError(401, 'Connect your Tesla account to continue.');
  if (!force && session.tokens.expiresAt > Date.now() + 60_000) return session.tokens.accessToken;
  if (!session.refreshing) {
    session.refreshing = (async () => {
      if (!session.tokens.refreshToken) {
        session.tokens = null;
        throw new AppError(401, 'Connect your Tesla account again to continue.');
      }
      const previous = session.tokens.refreshToken;
      try {
        const tokens = await tokenRequest(config, { grant_type: 'refresh_token', refresh_token: previous }, fetchImpl);
        if (session.destroyed) throw new AppError(401, 'This session has ended.');
        session.tokens = { ...tokens, scopes: tokens.scopes.length ? tokens.scopes : session.tokens.scopes || [], refreshToken: tokens.refreshToken || previous };
        return session.tokens.accessToken;
      } catch (error) {
        if (error.status === 401) session.tokens = null;
        throw error;
      }
    })();
  }
  const pending = session.refreshing;
  try { return await pending; }
  finally { if (session.refreshing === pending) session.refreshing = null; }
}

export async function fleetGet(session, config, path, fetchImpl = fetch) {
  return fleetRequest(session, config, path, {}, fetchImpl);
}

export async function fleetRequest(session, config, path, options = {}, fetchImpl = fetch) {
  const token = await accessToken(session, config, fetchImpl);
  const send = (bearer) => requestJson(`${config.audience}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
  }, fetchImpl);
  let result = await send(token);
  if (result.response.status === 401) {
    const refreshed = session.tokens?.accessToken !== token && session.tokens?.expiresAt > Date.now() + 60_000
      ? session.tokens.accessToken : await accessToken(session, config, fetchImpl, true);
    result = await send(refreshed);
  }
  if (!result.response.ok) {
    const status = result.response.status;
    if (status === 401) session.tokens = null;
    throw new AppError(status < 500 ? status : 502, fleetErrors[status] || 'Tesla could not complete this request. Please try again.', `tesla_${status}`);
  }
  if (!result.body || !Object.hasOwn(result.body, 'response') || result.body.response == null) throw new AppError(502, 'Tesla returned an incomplete response.');
  return result.body.response;
}

export function vehicleSummary(vehicle) {
  return {
    vin: vehicle.vin, name: vehicle.display_name || 'My Tesla',
    state: vehicle.state || 'unknown',
  };
}

const numeric = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const flag = (value) => typeof value === 'boolean' ? value : null;
const opening = (value) => typeof value === 'number' ? value > 0 : null;

export function vehicleDetails(vehicle, { includeLocation = false } = {}) {
  const charge = vehicle.charge_state || {};
  const climate = vehicle.climate_state || {};
  const state = vehicle.vehicle_state || {};
  return {
    ...vehicleSummary(vehicle),
    battery: numeric(charge.battery_level), rangeMiles: numeric(charge.battery_range),
    chargeLimit: numeric(charge.charge_limit_soc), chargingState: charge.charging_state || 'Unknown',
    chargerPower: numeric(charge.charger_power), chargeEnergyAdded: numeric(charge.charge_energy_added),
    hoursToFull: numeric(charge.time_to_full_charge),
    chargeAmps: numeric(charge.charge_current_request), maxChargeAmps: numeric(charge.charge_current_request_max),
    chargerVoltage: numeric(charge.charger_voltage), chargerAmps: numeric(charge.charger_actual_current),
    chargeRateMiles: numeric(charge.charge_rate), chargePortOpen: flag(charge.charge_port_door_open),
    scheduledChargeTime: numeric(charge.scheduled_charging_start_time),
    insideCelsius: numeric(climate.inside_temp), outsideCelsius: numeric(climate.outside_temp),
    climateOn: flag(climate.is_climate_on), locked: flag(state.locked),
    sentryMode: flag(state.sentry_mode), odometerMiles: numeric(state.odometer),
    softwareVersion: state.car_version || null,
    softwareUpdate: typeof state.software_update?.status === 'string' ? state.software_update.status : null,
    tires: { frontLeft: numeric(state.tpms_pressure_fl), frontRight: numeric(state.tpms_pressure_fr), rearLeft: numeric(state.tpms_pressure_rl), rearRight: numeric(state.tpms_pressure_rr) },
    openings: { driverFront: opening(state.df), passengerFront: opening(state.pf), driverRear: opening(state.dr), passengerRear: opening(state.pr), frontTrunk: opening(state.ft), rearTrunk: opening(state.rt), driverWindow: opening(state.fd_window), passengerWindow: opening(state.fp_window), rearDriverWindow: opening(state.rd_window), rearPassengerWindow: opening(state.rp_window) },
    driverTemperature: numeric(climate.driver_temp_setting), passengerTemperature: numeric(climate.passenger_temp_setting),
    location: includeLocation && numeric(vehicle.drive_state?.latitude) != null && numeric(vehicle.drive_state?.longitude) != null ? { latitude: numeric(vehicle.drive_state.latitude), longitude: numeric(vehicle.drive_state.longitude) } : null,
    model: vehicle.vehicle_config?.car_type || null,
    distanceUnit: vehicle.gui_settings?.gui_distance_units === 'km/hr' ? 'km' : 'mi',
    temperatureUnit: vehicle.gui_settings?.gui_temperature_units === 'F' ? 'F' : 'C',
    fetchedAt: new Date().toISOString(),
  };
}
