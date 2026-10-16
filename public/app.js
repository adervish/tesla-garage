const $ = (id) => document.getElementById(id);
const state = { session: null, vehicles: [], selected: null, readings: new Map(), statuses: new Map(), history: [], demo: false, busy: false };
const sample = {
  vin: 'SAMPLE', name: 'Midnight', state: 'online', model: 'model3', battery: 78,
  rangeMiles: 242, chargeLimit: 80, chargingState: 'Disconnected', chargerPower: 0,
  insideCelsius: 21, outsideCelsius: 18, climateOn: false, locked: true, sentryMode: true,
  odometerMiles: 12408, softwareVersion: 'Example build', distanceUnit: 'mi', temperatureUnit: 'F',
};
const callbackErrors = {
  setup: 'Check Connection settings below, then connect your Tesla account.',
  state: 'That sign-in link expired or belongs to another browser session. Start a new connection from this page.',
  denied: 'Tesla sign-in was canceled or access was not granted. You can try connecting again.',
  authorization: 'Tesla could not complete sign-in. Check your credentials, allowed origin, and callback URL, then try again.',
  credentials: 'Tesla rejected this app’s client ID or client secret. Update the matching credentials from the Tesla developer portal and deploy them to the app, then start a new sign-in.',
  authorization_code: 'Tesla did not accept the sign-in code. It may have expired or already been used. Start a new connection from this page.',
  redirect_uri: 'Tesla rejected the callback URL. The allowed redirect URI in the Tesla developer portal must exactly match the callback shown in Connection settings.',
  permissions: 'Tesla rejected the requested permissions. Enable the requested permissions in the Tesla developer portal, then reconnect. Vehicle controls need Vehicle Commands and Vehicle Charging Management.',
  login_required: 'Tesla requires a new sign-in. Connect your account again from this page.',
  tesla_unavailable: 'Tesla sign-in is temporarily unavailable. Wait a moment, then start a new connection.',
  tesla_unreachable: 'The app could not reach Tesla’s sign-in service. Wait a moment, then start a new connection.',
};
const number = (value, digits = 0) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: digits }) : '—';
const text = (id, value) => { $(id).textContent = value; };
const showNotice = (message = '') => { text('notice', message); $('notice').hidden = !message; };

async function api(path, method = 'GET', body) {
  let response;
  try { response = await fetch(path, { method, credentials: 'same-origin', ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(65_000) }); }
  catch { throw new Error('The app could not complete the request. Check the server is running and try again.'); }
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && state.session) {
      state.session.connected = false;
      state.vehicles = [];
      state.selected = null;
      state.readings.clear();
      render();
    }
    throw new Error(data.error || 'The request could not be completed.');
  }
  return data;
}

function render() {
  const connected = Boolean(state.session?.connected);
  const vehicle = state.demo ? sample : state.vehicles.find((item) => item.vin === state.selected);
  const details = state.demo ? sample : state.readings.get(state.selected);
  const ready = state.session?.credentialsConfigured && state.session?.appUrlConfigured;
  text('connection-pill', connected ? 'Connected' : 'Not connected');
  $('connection-pill').classList.toggle('connected', connected);
  $('disconnect').hidden = !connected;
  $('disconnect').disabled = state.busy;
  $('connection').hidden = connected || state.demo;
  $('dashboard').hidden = !connected && !state.demo;
  $('sample-notice').hidden = !state.demo;
  $('setup').hidden = connected || state.demo;
  $('readings').hidden = !vehicle;
  $('empty-vehicles').hidden = Boolean(vehicle) || state.busy;
  // Move local previews to the configured origin before beginning sign-in.
  const loginUrl = ready ? (window.location.origin === state.session.appUrl ? state.session.loginUrl : state.session.appUrl) : '#setup';
  $('connect-button').href = loginUrl;
  $('vehicle-picker-wrap').hidden = !connected || state.vehicles.length < 2;
  text('vehicle-model', { model3: 'Model 3', modely: 'Model Y', models: 'Model S', modelx: 'Model X', cybertruck: 'Cybertruck' }[details?.model] || 'Your Tesla');
  text('vehicle-name', vehicle?.name || (state.busy ? 'Loading vehicles…' : 'No vehicles found'));
  const status = state.statuses.get(state.selected);
  const vehicleState = state.demo ? sample.state : status?.state || vehicle?.state || details?.state;
  text('vehicle-state', { online: 'Online', asleep: 'Asleep', offline: 'Offline' }[vehicleState] || vehicleState || '');
  text('vin-value', vehicle?.vin || '—');
  text('lock-state', details?.locked == null ? '—' : details.locked ? 'Locked' : 'Unlocked');
  $('lock-state').hidden = details?.locked == null;
  text('battery-value', number(details?.battery));
  $('battery-progress').value = details?.battery ?? 0;
  $('battery-progress').hidden = details?.battery == null;
  text('battery-note', details?.chargeLimit != null ? `Limit ${number(details.chargeLimit)}%` : 'No reading yet');
  const unit = details?.distanceUnit || 'mi';
  text('range-unit', unit);
  const distance = (value) => value == null ? null : value * (unit === 'km' ? 1.609344 : 1);
  text('range-value', number(distance(details?.rangeMiles)));
  const charging = details?.chargingState;
  const chargingLabels = { Disconnected: 'Unplugged', Charging: 'Charging', Complete: 'Complete', Stopped: 'Stopped', NoPower: 'No power', Starting: 'Starting', Unknown: 'Unknown' };
  text('charging-value', charging ? (chargingLabels[charging] || charging) : '—');
  text('charging-note', charging === 'Charging' ? `${number(details.chargerPower)} kW · ${number(details.hoursToFull, 1)} h left` : charging === 'Disconnected' ? 'Cable disconnected' : charging ? 'Last reported status' : 'No reading yet');
  const tempUnit = details?.temperatureUnit || 'F';
  const temp = details?.insideCelsius == null ? null : tempUnit === 'F' ? details.insideCelsius * 9 / 5 + 32 : details.insideCelsius;
  text('temperature-value', number(temp));
  text('temperature-unit', `°${tempUnit}`);
  text('temperature-note', details?.climateOn == null ? 'No reading yet' : details.climateOn ? 'Climate on' : 'Climate off');
  text('odometer-value', details?.odometerMiles == null ? '—' : `${number(distance(details.odometerMiles))} ${unit}`);
  text('sentry-value', details?.sentryMode == null ? '—' : details.sentryMode ? 'On' : 'Off');
  text('software-value', details?.softwareVersion || '—');
  text('updated-at', state.demo ? 'Example readings' : details?.fetchedAt ? `Updated ${new Date(details.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}` : 'Refresh to get the latest readings.');
  $('refresh-note').hidden = state.demo;
  const offline = vehicle && vehicleState !== 'online';
  $('availability').hidden = !offline || state.demo;
  text('availability', offline ? `${vehicleState === 'asleep' ? 'The vehicle is asleep.' : 'The vehicle is offline.'} ${details ? 'Showing saved readings from ' + new Date(details.fetchedAt).toLocaleString() + '. ' : 'Tesla has not returned live readings yet. '}Wake it or open the Tesla app, then refresh. A car without cellular or Wi-Fi coverage may remain offline.` : '');
  const scopes = state.session?.scopes || [];
  const hasControls = scopes.includes('vehicle_cmds');
  const hasCharging = scopes.includes('vehicle_charging_cmds');
  $('wake-button').hidden = !vehicle || !connected || !offline || state.demo;
  $('wake-button').disabled = state.busy;
  text('wake-button', hasControls ? 'Wake' : 'Enable Wake');
  $('controls').hidden = !connected || !vehicle || state.demo;
  $('energy-panel').hidden = !connected;
  $('enable-controls').hidden = hasControls && hasCharging;
  $('enable-location').hidden = scopes.includes('vehicle_location');
  $('enable-energy').hidden = scopes.includes('energy_device_data');
  $('load-energy').disabled = state.busy || !scopes.includes('energy_device_data');
  $('pair-key').href = `https://tesla.com/_ak/${new URL(state.session?.appUrl || location.origin).hostname}?vin=${encodeURIComponent(vehicle?.vin || '')}`;
  text('controls-note', !hasControls || !hasCharging ? 'First enable Vehicle Commands and Vehicle Charging Management in the Tesla developer portal, then use Enable controls. Pair this app’s vehicle key in the Tesla mobile app.' : state.session.commandsAvailable ? 'Controls need the vehicle online and this app’s key paired in the Tesla mobile app. Changes happen only when you press a control.' : 'Wake is available. The signed command service is still being configured.');
  for (const button of document.querySelectorAll('[data-command]')) button.disabled = state.busy || !state.session?.commandsAvailable || !( /^(charge_|set_charge|set_charging)/.test(button.dataset.command) ? hasCharging : hasControls );
  for (const id of ['charge-limit-form', 'charge-amps-form', 'temperature-form']) for (const input of $(id).elements) input.disabled = state.busy || !state.session?.commandsAvailable || !(id === 'temperature-form' ? hasControls : hasCharging);
  for (const id of ['check-controls', 'load-history', 'load-alerts', 'load-releases']) $(id).disabled = state.busy || !connected || !vehicle || state.demo;
  $('export-history').disabled = state.busy || !state.history.length;
  const valueUnit = (value, unit, digits = 1) => value == null ? '—' : `${number(value, digits)} ${unit}`;
  text('power-value', valueUnit(details?.chargerPower, 'kW'));
  text('energy-added-value', valueUnit(details?.chargeEnergyAdded, 'kWh'));
  text('voltage-value', `${valueUnit(details?.chargerVoltage, 'V', 0)} / ${valueUnit(details?.chargerAmps, 'A', 0)}`);
  text('amps-value', valueUnit(details?.chargeAmps, 'A', 0));
  text('charge-time-value', valueUnit(details?.hoursToFull, 'hours'));
  text('port-value', details?.chargePortOpen == null ? '—' : details.chargePortOpen ? 'Open' : 'Closed');
  text('outside-value', valueUnit(details?.outsideCelsius == null ? null : tempUnit === 'F' ? details.outsideCelsius * 9 / 5 + 32 : details.outsideCelsius, `°${tempUnit}`));
  text('update-value', details?.softwareUpdate || '—');
  for (const [id, key] of [['tire-fl','frontLeft'],['tire-fr','frontRight'],['tire-rl','rearLeft'],['tire-rr','rearRight']]) text(id, valueUnit(details?.tires?.[key] == null ? null : details.tires[key] * 14.5038, 'psi'));
  const names = {driverFront:'Driver door',passengerFront:'Passenger door',driverRear:'Rear driver door',passengerRear:'Rear passenger door',frontTrunk:'Frunk',rearTrunk:'Trunk',driverWindow:'Driver window',passengerWindow:'Passenger window',rearDriverWindow:'Rear driver window',rearPassengerWindow:'Rear passenger window'};
  const openings = Object.entries(details?.openings || {});
  const open = openings.filter(([, value]) => value === true).map(([key]) => names[key]);
  text('openings-value', open.length ? `Open: ${open.join(', ')}.` : openings.length && openings.every(([, value]) => value === false) ? 'All reported doors, windows, and trunks are closed.' : 'Some door or window readings are unavailable.');
  const position = details?.location;
  $('location-link').hidden = !position;
  if (position) $('location-link').href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(position.latitude + ',' + position.longitude)}`;
  text('location-note', position ? `Location received ${new Date(details.fetchedAt).toLocaleString()}.` : scopes.includes('vehicle_location') ? 'Refresh while the vehicle is online. Tesla may withhold location for shared vehicles.' : 'Enable Vehicle Location in the Tesla developer portal, then grant location access here.');

  $('refresh-button').disabled = state.busy || !connected || !vehicle || state.demo;
  text('refresh-button', state.busy ? 'Loading…' : 'Refresh');
  $('reload-vehicles').hidden = !connected;
  $('reload-vehicles').disabled = state.busy;
  $('vehicle-picker').disabled = state.busy || !state.vehicles.length;
  if (state.session) {
    text('credentials-status', state.session.credentialsConfigured ? 'Credentials found' : 'Add the client ID and secret to the server configuration.');
    text('callback-url', state.session.callbackUrl);
    text('key-status', state.session.publicKeyReady ? 'Domain public key available' : 'Generate a public key and register your app domain.');
  }
}

async function loadVehicles() {
  const { vehicles } = await api('/api/vehicles');
  state.vehicles = vehicles;
  if (!vehicles.some((vehicle) => vehicle.vin === state.selected)) state.selected = vehicles[0]?.vin || null;
  $('vehicle-picker').replaceChildren(...vehicles.map((vehicle) => {
    const option = document.createElement('option');
    option.value = vehicle.vin;
    option.textContent = `${vehicle.name} · ${vehicle.vin.slice(-6)}`;
    return option;
  }));
  $('vehicle-picker').value = state.selected || '';
  await loadSelected();
}

async function refreshSelected() {
  if (!state.selected) return;
  const vin = state.selected;
  const result = await api(`/api/vehicles/${vin}/refresh`, 'POST');
  if (result.vehicle) state.readings.set(vin, result.vehicle);
  if (result.status) state.statuses.set(vin, result.status);
  if (result.message) showNotice(result.message);
}
async function loadSelected() {
  state.history = [];
  for (const id of ['history-content', 'alerts-content', 'releases-content']) $(id).replaceChildren();
  if (!state.selected) return;
  const snapshot = await api(`/api/vehicles/${state.selected}/snapshot`);
  if (snapshot.vehicle) state.readings.set(state.selected, snapshot.vehicle);
  if (snapshot.status) state.statuses.set(state.selected, snapshot.status);
  render();
  await refreshSelected();
}

async function run(operation) {
  if (state.busy) return;
  state.busy = true;
  showNotice();
  render();
  try { await operation(); }
  catch (error) { showNotice(error.message); }
  finally { state.busy = false; render(); }
}

$('preview-button').addEventListener('click', () => { state.demo = true; showNotice(); render(); });
$('exit-preview').addEventListener('click', () => { state.demo = false; render(); });
$('refresh-button').addEventListener('click', () => run(refreshSelected));
$('reload-vehicles').addEventListener('click', () => run(loadVehicles));
$('vehicle-picker').addEventListener('change', (event) => run(async () => { state.selected = event.target.value; await loadSelected(); }));
$('disconnect').addEventListener('click', () => run(async () => {
  await api('/api/logout', 'POST');
  state.session.connected = false;
  state.vehicles = [];
  state.readings.clear();
  state.statuses.clear();
  state.history = [];
  state.selected = null;
  state.demo = false;
}));
$('connect-button').addEventListener('click', () => {
  if ($('connect-button').getAttribute('href') === '#setup') $('setup').open = true;
});
$('copy-callback').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('callback-url').textContent); text('copy-callback', 'Copied'); }
  catch { showNotice('Copy the callback URL shown in Connection settings.'); }
});

const vehiclePath = (action) => `/api/vehicles/${encodeURIComponent(state.selected)}/${action}`;
$('wake-button').addEventListener('click', () => {
  if (!state.session.scopes?.includes('vehicle_cmds')) { location.href = '/auth/login?features=controls'; return; }
  run(async () => {
    const result = await api(vehiclePath('wake'), 'POST');
    if (result.status) state.statuses.set(state.selected, result.status);
    showNotice(result.message);
    if (result.status?.state === 'online') await refreshSelected();
  });
});
async function sendCommand(command, parameters = {}) {
  await run(async () => { const result = await api(vehiclePath('command'), 'POST', { command, ...parameters }); showNotice(result.message); });
}
for (const button of document.querySelectorAll('[data-command]')) button.addEventListener('click', () => {
  if (button.dataset.confirm && !window.confirm(button.dataset.confirm)) return;
  sendCommand(button.dataset.command, button.dataset.on ? { on: button.dataset.on === 'true' } : {});
});
for (const [form, command, field, parameter] of [['charge-limit-form','set_charge_limit','charge-limit','percent'],['charge-amps-form','set_charging_amps','charge-amps','charging_amps'],['temperature-form','set_temps','cabin-target','temperature']]) {
  $(form).addEventListener('submit', (event) => { event.preventDefault(); sendCommand(command, { [parameter]: Number($(field).value) }); });
}
$('check-controls').addEventListener('click', () => run(async () => {
  const result = await api(vehiclePath('status'));
  showNotice(`${result.keyPaired === true ? 'Vehicle key is paired.' : result.keyPaired === false ? 'Pair this app’s key using Pair vehicle key.' : 'Tesla did not report key-pairing status.'} ${result.requiresSigning === true ? 'This vehicle requires signed commands.' : ''} ${result.firmware ? `Firmware: ${result.firmware}.` : ''}`);
}));
for (const type of ['alerts', 'releases']) $(`load-${type}`).addEventListener('click', () => run(async () => {
  const data = await api(vehiclePath(type));
  const container = $(`${type}-content`);
  container.replaceChildren();
  if (!data.entries.length) { const p = document.createElement('p'); p.textContent = `Tesla returned no ${type === 'alerts' ? 'recent alerts' : 'release notes'} for this vehicle.`; container.append(p); }
  for (const entry of data.entries) {
    const article = document.createElement('article');
    const title = document.createElement('h3'); title.textContent = entry.title;
    const body = document.createElement('p'); body.textContent = entry.description || 'No additional details supplied.';
    article.append(title, body); container.append(article);
  }
}));
$('load-history').addEventListener('click', () => run(async () => {
  const result = await api(vehiclePath('history'));
  state.history = result.readings;
  const container = $('history-content'); container.replaceChildren();
  if (!state.history.length) { container.textContent = 'No saved readings yet. Refresh while the vehicle is online to start recording.'; return; }
  const points = state.history.filter((item) => typeof item.battery === 'number');
  if (points.length > 1) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 600 140'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Battery percentage across saved readings');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    const start = Date.parse(points[0].fetchedAt); const span = Date.parse(points.at(-1).fetchedAt) - start || 1;
    path.setAttribute('d', points.map((item, index) => `${index ? 'L' : 'M'}${20 + (Date.parse(item.fetchedAt) - start) / span * 560},${120 - item.battery}`).join(' '));
    path.setAttribute('stroke', '#202124'); path.setAttribute('stroke-width', '2'); path.setAttribute('fill', 'none');
    svg.append(path); container.append(svg);
  }
  const caption = document.createElement('p'); caption.className = 'feature-note'; caption.textContent = `${state.history.length} saved readings. Showing the latest 20; download CSV for all readings.`; container.append(caption);
  const table = document.createElement('table');
  const header = table.createTHead().insertRow();
  for (const label of ['Received', 'Battery', 'Range (mi)', 'Charging', 'Power (kW)']) { const th = document.createElement('th'); th.textContent = label; header.append(th); }
  const body = table.createTBody();
  for (const item of state.history.slice(-20).reverse()) {
    const row = body.insertRow();
    for (const value of [new Date(item.fetchedAt).toLocaleString(), `${number(item.battery)}%`, number(item.rangeMiles), item.chargingState || '—', number(item.chargerPower, 1)]) row.insertCell().textContent = value;
  }
  container.append(table);
}));
$('export-history').addEventListener('click', () => {
  const keys = ['fetchedAt','battery','rangeMiles','odometerMiles','chargingState','chargerPower','chargeEnergyAdded','insideCelsius'];
  const cell = (value) => `"${String(value ?? '').replace(/^[=+@-]/, "'$&").replaceAll('"','""')}"`;
  const csv = [keys.join(','), ...state.history.map((item) => keys.map((key) => cell(item[key])).join(','))].join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], {type: 'text/csv;charset=utf-8'}));
  const link = document.createElement('a'); link.href = url; link.download = `tesla-readings-${state.selected.slice(-6)}.csv`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('load-energy').addEventListener('click', () => run(async () => {
  const result = await api('/api/energy'); const container = $('energy-content'); container.replaceChildren();
  if (!result.sites.length) { container.textContent = 'No energy sites are shared with this Tesla account.'; return; }
  for (const site of result.sites) {
    const section = document.createElement('section'); const title = document.createElement('h2'); title.textContent = site.name;
    const button = document.createElement('button'); button.className = 'text-button'; button.textContent = 'Refresh energy';
    const readings = document.createElement('p'); readings.className = 'feature-note';
    button.addEventListener('click', () => run(async () => {
      const data = await api(`/api/energy/${site.id}`);
      readings.textContent = `Battery ${number(data.battery)}% · Solar ${number(data.solarWatts)} W · Home ${number(data.homeWatts)} W · Grid ${number(data.gridWatts)} W · ${data.gridStatus || 'Grid status unavailable'} · Received ${new Date(data.fetchedAt).toLocaleTimeString()}`;
    }));
    section.append(title, button, readings); container.append(section);
  }
}));

const url = new URL(window.location.href);
const error = url.searchParams.get('error');
if (error) {
  showNotice(callbackErrors[error] || 'Connection could not be completed. Please try again.');
  history.replaceState(null, '', '/');
}
try {
  state.session = await api('/api/session');
  $('setup').open = !state.session.appUrlConfigured || !state.session.credentialsConfigured || Boolean(error);
  if (state.session.connected) await run(loadVehicles);
  render();
} catch (error) { render(); showNotice(error.message); }
