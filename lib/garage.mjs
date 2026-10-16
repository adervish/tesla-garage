import { AppError, fleetGet, fleetRequest, accessToken, requestJson, tokenScopes, vehicleDetails, vehicleSummary } from './tesla.mjs';

export const COMMANDS = {
  charge_start: 'Start charging', charge_stop: 'Stop charging', set_charge_limit: 'Set charge limit', set_charging_amps: 'Set charging current',
  auto_conditioning_start: 'Start climate', auto_conditioning_stop: 'Stop climate', set_temps: 'Set cabin temperature',
  door_lock: 'Lock doors', door_unlock: 'Unlock doors', set_sentry_mode: 'Set Sentry mode',
  charge_port_door_open: 'Open charge port', charge_port_door_close: 'Close charge port', flash_lights: 'Flash lights', honk_horn: 'Honk horn',
};
export const scopesFor = (session) => session.tokens?.scopes?.length ? session.tokens.scopes : tokenScopes(session.tokens?.accessToken || '');
const requireScope = (session, scope) => {
  if (!scopesFor(session).includes(scope)) throw new AppError(403, `Enable ${scope === 'vehicle_cmds' ? 'vehicle controls' : scope === 'vehicle_charging_cmds' ? 'charging controls' : scope === 'energy_device_data' ? 'energy access' : 'location access'} and reconnect with Tesla first.`, 'permission_required');
};
const finite = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const plain = (value) => typeof value === 'string' ? value.replace(/<[^>]*>/g, '').slice(0, 8000) : '';
function entries(data, type) {
  const list = Array.isArray(data) ? data : data?.[type] || data?.recent_alerts || data?.alerts || data?.release_notes || data?.notes || [];
  return (Array.isArray(list) ? list : [list]).slice(0, 50).map((item) => ({
    title: plain(item.title || item.name || item.alert_name || item.short_description || item.customer_version) || (type === 'alerts' ? 'Vehicle alert' : 'Software update'),
    description: plain(item.description || item.body || item.text || item.user_text || item.long_description || item.subtitle),
    date: plain(item.timestamp || item.date || item.created_at),
  }));
}
export function commandParameters(command, input) {
  if (!Object.hasOwn(COMMANDS, command)) throw new AppError(400, 'This command is not supported.');
  const range = (key, min, max, integer = false) => {
    const value = input[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new AppError(400, `Enter a ${key} between ${min} and ${max}.`);
    return value;
  };
  if (command === 'set_charge_limit') return { percent: range('percent', 50, 100, true) };
  if (command === 'set_charging_amps') return { charging_amps: range('charging_amps', 1, 48, true) };
  if (command === 'set_temps') { const value = range('temperature', 15, 28); return { driver_temp: value, passenger_temp: value }; }
  if (command === 'set_sentry_mode') {
    if (typeof input.on !== 'boolean') throw new AppError(400, 'Choose whether Sentry mode should be on or off.');
    return { on: input.on };
  }
  return {};
}

export async function garageApi({ session, config, path, method, input = {}, fetchImpl = fetch, proxyFetch, cached, forget }) {
  session.garage ||= { readings: {}, history: {}, statuses: {} };
  const garage = session.garage;
  if (path === '/api/energy' && method === 'GET') {
    requireScope(session, 'energy_device_data');
    const sites = await cached('energy', async () => {
      const products = await fleetGet(session, config, '/api/1/products', fetchImpl);
      return (Array.isArray(products) ? products : []).filter((item) => item.energy_site_id).map((item) => ({ id: String(item.energy_site_id), name: plain(item.site_name || item.name) || 'Energy site', type: plain(item.resource_type) }));
    });
    return { sites };
  }
  const energy = path.match(/^\/api\/energy\/(\d+)$/);
  if (energy && method === 'GET') {
    requireScope(session, 'energy_device_data');
    return cached(`energy:${energy[1]}`, async () => {
      const result = await fleetGet(session, config, `/api/1/energy_sites/${energy[1]}/live_status`, fetchImpl);
      return { battery: finite(result.percentage_charged), solarWatts: finite(result.solar_power), homeWatts: finite(result.load_power), gridWatts: finite(result.grid_power), batteryWatts: finite(result.battery_power), gridStatus: plain(result.grid_status), fetchedAt: new Date().toISOString() };
    });
  }
  const match = path.match(/^\/api\/vehicles\/([A-HJ-NPR-Z0-9]{17})\/(snapshot|history|refresh|wake|command|status|alerts|releases)$/);
  if (!match) throw new AppError(404, 'Endpoint not found.');
  const [, vin, operation] = match;
  const base = `/api/1/vehicles/${vin}`;
  if (method === 'GET' && operation === 'snapshot') return { vehicle: garage.readings[vin] || null, status: garage.statuses[vin] || null };
  if (method === 'GET' && operation === 'history') return { readings: garage.history[vin] || [], retention: 'Up to 200 readings per vehicle in this connection; removed on disconnect or after the session expires.' };
  if (method === 'POST' && operation === 'refresh') {
    const refreshed = await cached(vin, async () => {
      const current = await fleetGet(session, config, base, fetchImpl);
      const status = { ...vehicleSummary(current), checkedAt: new Date().toISOString() };
      garage.statuses[vin] = status;
      for (const key of Object.keys(garage.statuses).slice(0, Math.max(0, Object.keys(garage.statuses).length - 100))) delete garage.statuses[key];
      if (current.state !== 'online') return { vehicle: garage.readings[vin] || null, status, message: current.state === 'asleep' ? 'The vehicle is asleep. Wake it to request new readings.' : 'The vehicle is offline. Try Wake, or open the Tesla app. A car without cellular or Wi-Fi coverage may remain unavailable.' };
      const endpoints = ['charge_state', 'climate_state', 'vehicle_state', 'vehicle_config', 'gui_settings'];
      if (scopesFor(session).includes('vehicle_location')) endpoints.push('location_data');
      const result = await fleetGet(session, config, `${base}/vehicle_data?endpoints=${encodeURIComponent(endpoints.join(';'))}`, fetchImpl);
      const vehicle = vehicleDetails({ ...current, ...result }, { includeLocation: scopesFor(session).includes('vehicle_location') });
      garage.readings[vin] = vehicle;
      const history = garage.history[vin] ||= [];
      history.push({ fetchedAt: vehicle.fetchedAt, battery: vehicle.battery, rangeMiles: vehicle.rangeMiles, odometerMiles: vehicle.odometerMiles, chargeEnergyAdded: vehicle.chargeEnergyAdded, chargerPower: vehicle.chargerPower, chargingState: vehicle.chargingState, insideCelsius: vehicle.insideCelsius });
      garage.history[vin] = history.slice(-200);
      // Bound the session even for large shared fleets.
      const oldest = Object.keys(garage.readings).sort((a, b) => garage.readings[a].fetchedAt.localeCompare(garage.readings[b].fetchedAt));
      for (const key of oldest.slice(0, Math.max(0, oldest.length - 25))) { delete garage.readings[key]; delete garage.history[key]; delete garage.statuses[key]; }
      return { vehicle, status, cacheSeconds: 60 };
    });
    // An offline check must not hide a vehicle that has just woken up.
    if (refreshed.status?.state !== 'online') forget(vin);
    return refreshed;
  }
  if (method === 'POST' && operation === 'wake') {
    requireScope(session, 'vehicle_cmds');
    const result = await fleetRequest(session, config, `${base}/wake_up`, { method: 'POST', body: '{}' }, fetchImpl);
    forget(vin); forget('vehicles');
    garage.statuses[vin] = { ...vehicleSummary(result), checkedAt: new Date().toISOString() };
    return { status: garage.statuses[vin], message: 'Wake request sent. The car may take a minute to come online; use Refresh to check.' };
  }
  if (method === 'POST' && operation === 'command') {
    const command = input.command;
    const parameters = commandParameters(command, input);
    const charging = /^(charge_|set_charge|set_charging)/.test(command);
    requireScope(session, charging ? 'vehicle_charging_cmds' : 'vehicle_cmds');
    if (!proxyFetch) throw new AppError(503, 'The vehicle command service is not available yet. Readings and Wake are still available.', 'commands_unavailable');
    const token = await accessToken(session, config, fetchImpl);
    const { response, body } = await requestJson(`https://commands.internal${base}/command/${command}`, { timeoutMs: 60_000, method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(parameters) }, proxyFetch).catch(() => { throw new AppError(502, 'No command confirmation was received. Check the vehicle in the Tesla app before trying again.', 'command_unconfirmed'); });
    if (!response.ok || body.response?.result !== true) {
      if (response.status === 401) throw new AppError(403, 'Reconnect with Tesla to renew command access.', 'permission_required');
      if (response.status === 403) throw new AppError(403, 'Tesla denied the command. Check control permissions and pair the vehicle key.', 'key_required');
      if (response.status === 408 || response.status === 504) throw new AppError(408, 'The vehicle did not respond. Wake it, check connectivity, then try again.');
      throw new AppError(409, 'Tesla did not confirm the command. Check that the vehicle is online, the key is paired, and the action is available in its current state.', 'command_failed');
    }
    forget(vin);
    return { ok: true, message: `${COMMANDS[command]}: confirmed by Tesla. Refresh to check the new state.` };
  }
  if (method === 'GET' && operation === 'status') {
    const result = await cached(`status:${vin}`, () => fleetRequest(session, config, '/api/1/vehicles/fleet_status', { method: 'POST', body: JSON.stringify({ vins: [vin] }) }, fetchImpl));
    const info = result.vehicle_info?.[vin] || result;
    return { keyPaired: Array.isArray(result.key_paired_vins) ? result.key_paired_vins.includes(vin) : null, requiresSigning: typeof info.vehicle_command_protocol_required === 'boolean' ? info.vehicle_command_protocol_required : null, firmware: plain(info.firmware_version), telemetryVersion: plain(info.fleet_telemetry_version) };
  }
  if (method === 'GET' && ['alerts', 'releases'].includes(operation)) {
    const data = await cached(`${operation}:${vin}`, () => fleetGet(session, config, `${base}/${operation === 'alerts' ? 'recent_alerts' : 'release_notes'}`, fetchImpl));
    return { entries: entries(data, operation), fetchedAt: new Date().toISOString() };
  }
  throw new AppError(405, 'Method not allowed.');
}
