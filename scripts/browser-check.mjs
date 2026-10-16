// Optional UI smoke check. Start a separate headless Chrome with
// --remote-debugging-port=9228 and a temporary --user-data-dir first.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from '../lib/config.mjs';

const appUrl = process.argv[2] || 'http://localhost:3000';

const tab = await (await fetch('http://127.0.0.1:9228/json/new?about:blank', { method: 'PUT' })).json();
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
let counter = 0;
const pending = new Map();
const errors = [];
socket.addEventListener('message', (event) => {
  const data = JSON.parse(event.data);
  if (data.method === 'Runtime.exceptionThrown') errors.push('Uncaught browser exception');
  if (data.method === 'Log.entryAdded' && data.params.entry.level === 'error') errors.push(data.params.entry.text);
  if (data.id && pending.has(data.id)) {
    const { resolve, reject, timer } = pending.get(data.id);
    clearTimeout(timer);
    pending.delete(data.id);
    if (data.error) reject(new Error(data.error.message)); else resolve(data.result);
  }
});
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++counter;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser command timed out: ${method}`)); }, 10_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
const waitFor = async (expression) => {
  assert.equal(await evaluate(`new Promise(resolve => {
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      if (${expression}) { clearInterval(timer); resolve(true); }
      else if (Date.now() > deadline) { clearInterval(timer); resolve(false); }
    }, 30);
  })`), true, `UI did not settle: ${expression}`);
};

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: appUrl });
  await evaluate("new Promise(resolve => { const timer = setInterval(() => { if (document.querySelector('#credentials-status')?.textContent.includes('Credentials found')) { clearInterval(timer); resolve(true); } }, 50); setTimeout(() => { clearInterval(timer); resolve(false); }, 5000); })");
  assert.equal(await evaluate("document.querySelector('#connection-pill').textContent"), 'Not connected');
  assert.equal(await evaluate("document.querySelector('#refresh-button').disabled"), true);
  await evaluate("document.querySelector('#preview-button').click()");
  assert.equal(await evaluate("document.querySelector('#sample-notice').hidden"), false);
  assert.equal(await evaluate("document.querySelector('#battery-value').textContent"), '78');
  assert.equal(await evaluate("document.querySelector('#range-value').textContent"), '242');
  assert.equal(await evaluate("document.querySelector('#temperature-value').textContent"), '70');
  assert.equal(await evaluate("document.querySelector('#refresh-button').disabled"), true);
  const output = join(ROOT, 'assets', 'screenshots');
  await mkdir(output, { recursive: true });
  const desktop = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile(join(output, 'desktop.png'), Buffer.from(desktop.data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
  const mobile = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile(join(output, 'mobile.png'), Buffer.from(mobile.data, 'base64'));
  await evaluate("document.querySelector('#exit-preview').click()");
  assert.equal(await evaluate("document.querySelector('#battery-value').textContent"), '—');
  assert.equal(await evaluate("document.querySelector('#sample-notice').hidden"), true);
  assert.equal(await evaluate("document.querySelector('#dashboard').hidden"), true);

  // Exercise the connected interface with fabricated API responses, without
  // authorizing a real Tesla account or making any vehicle requests.
  let connected = true;
  let vehicleCount = 2;
  const vehicles = [
    { vin: 'BROWSER_SAMPLE_1', name: 'Midnight', state: 'online' },
    { vin: 'BROWSER_SAMPLE_2', name: 'Weekend', state: 'asleep' },
  ];
  let refreshRequests = 0;
  socket.addEventListener('message', async (event) => {
    const data = JSON.parse(event.data);
    if (data.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = data.params;
    const path = new URL(request.url).pathname;
    let body;
    if (path === '/api/session') body = { connected, credentialsConfigured: true, appUrlConfigured: true, publicKeyReady: true, appUrl, loginUrl: `${appUrl}/auth/login`, callbackUrl: `${appUrl}/auth/callback`, runtime: 'cloudflare', scopes: ['vehicle_cmds','vehicle_charging_cmds'], commandsAvailable: true };
    else if (path === '/api/vehicles') body = { vehicles: vehicles.slice(0, vehicleCount) };
    else if (path.endsWith('/snapshot')) body = { vehicle: null, status: null };
    else if (path.endsWith('/history')) body = { readings: [{fetchedAt:new Date().toISOString(),battery:78,rangeMiles:242,chargingState:'Disconnected',chargerPower:0}] };
    else if (path.endsWith('/alerts')) body = { entries:[{title:'Test vehicle alert',description:'Simulated alert details'}] };
    else if (path.endsWith('/releases')) body = { entries:[{title:'Test release',description:'Simulated software notes'}] };
    else if (path.endsWith('/status')) body = {keyPaired:true,requiresSigning:true};
    else if (path.endsWith('/command')) body = {ok:true,message:'Command confirmed in simulation.'};
    else if (path.endsWith('/refresh') && request.method === 'POST') {
      refreshRequests++;
      body = { vehicle: { ...vehicles[0], model: 'model3', battery: 78, rangeMiles: 242, chargeLimit: 80, chargingState: 'Disconnected', insideCelsius: 21, climateOn: false, locked: true, sentryMode: true, odometerMiles: 12408, tires:{frontLeft:2.9,frontRight:2.9,rearLeft:2.8,rearRight:2.8},openings:{driverFront:false,passengerFront:false},chargeEnergyAdded:12,chargerVoltage:240,chargerAmps:32,softwareVersion: 'Example build', distanceUnit: 'mi', temperatureUnit: 'F', fetchedAt: new Date().toISOString() } };
      if (path.includes('BROWSER_SAMPLE_2')) body = {vehicle:null,status:vehicles[1],message:'Vehicle is asleep. Wake it to request new readings.'};
    } else if (path === '/api/logout' && request.method === 'POST') { connected = false; body = { ok: true }; }
    else { errors.push('Unexpected API request in browser simulation'); body = {}; }
    try {
      await send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(body)).toString('base64') });
    } catch { errors.push('Could not fulfill simulated API response'); }
  });
  await send('Fetch.enable', { patterns: [{ urlPattern: `${appUrl}/api/*` }] });
  await send('Page.navigate', { url: appUrl });
  await waitFor("document.querySelector('#vehicle-picker')?.options.length === 2 && !document.querySelector('#refresh-button').disabled");
  assert.equal(await evaluate("document.querySelector('#connection').hidden"), true);
  assert.equal(await evaluate("document.querySelector('#setup').hidden"), true);
  assert.equal(await evaluate("document.querySelector('#vehicle-picker-wrap').hidden"), false);
  assert.equal(await evaluate("document.querySelector('#vehicle-details').open"), false);
  await evaluate("document.querySelector('#refresh-button').click()");
  await waitFor("document.querySelector('#battery-value').textContent === '78' && !document.querySelector('#refresh-button').disabled");
  assert.equal(refreshRequests, 2, 'Opening the vehicle automatically requests readings, then Refresh requests once more.');
  assert.equal(await evaluate("document.querySelector('#lock-state').textContent"), 'Locked');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const connectedDesktop = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile(join(output, 'connected-desktop.png'), Buffer.from(connectedDesktop.data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
  const connectedMobile = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile(join(output, 'connected-mobile.png'), Buffer.from(connectedMobile.data, 'base64'));
  await evaluate("document.querySelector('#vehicle-details summary').click()");
  assert.equal(await evaluate("document.querySelector('#vehicle-details').open"), true);
  await evaluate("const picker = document.querySelector('#vehicle-picker'); picker.value = 'BROWSER_SAMPLE_2'; picker.dispatchEvent(new Event('change'));");
  await waitFor("document.querySelector('#vehicle-name').textContent === 'Weekend' && !document.querySelector('#refresh-button').disabled");
  assert.equal(await evaluate("document.querySelector('#availability').hidden"), false);
  assert.equal(await evaluate("document.querySelector('#wake-button').hidden"), false);
  assert.equal(await evaluate("document.querySelector('#vehicle-state').textContent"), 'Asleep');
  assert.equal(await evaluate("document.querySelector('#battery-value').textContent"), '—');
  assert.equal(await evaluate("document.querySelector('#lock-state').hidden"), true);
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 740, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
  vehicleCount = 1;
  await evaluate("document.querySelector('#reload-vehicles').click()");
  await waitFor("document.querySelector('#vehicle-picker').options.length === 1 && !document.querySelector('#reload-vehicles').disabled");
  assert.equal(await evaluate("document.querySelector('#vehicle-picker-wrap').hidden"), true);
  assert.equal(await evaluate("document.querySelector('#battery-value').textContent"), '78');
  await evaluate("document.querySelector('#history-panel').open = true; document.querySelector('#load-history').click()");
  await waitFor("!document.querySelector('#export-history').disabled");
  assert.equal(await evaluate("document.querySelector('#history-content').textContent.includes('78%')"), true);
  await evaluate("document.querySelector('#load-alerts').click()");
  await waitFor("document.querySelector('#alerts-content').textContent.includes('Test vehicle alert')");
  await evaluate("document.querySelector('#controls').open = true; document.querySelector('[data-command=charge_start]').click()");
  await waitFor("document.querySelector('#notice').textContent.includes('confirmed in simulation')");
  vehicleCount = 0;
  await evaluate("document.querySelector('#reload-vehicles').click()");
  await waitFor("!document.querySelector('#empty-vehicles').hidden");
  assert.equal(await evaluate("document.querySelector('#readings').hidden"), true);
  await evaluate("document.querySelector('#disconnect').click()");
  await waitFor("!document.querySelector('#connection').hidden");
  assert.equal(await evaluate("document.querySelector('#dashboard').hidden"), true);
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: sample and connected views, refresh, vehicle switching, details, empty list, logout, responsive layout, and no browser errors. Connected checks used simulated API data.');
  console.log('Screenshots saved in assets/screenshots/.');
} finally {
  socket.close();
  await fetch(`http://127.0.0.1:9228/json/close/${tab.id}`);
}
