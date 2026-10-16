import test from 'node:test';
import assert from 'node:assert/strict';
import { garageApi, commandParameters } from '../lib/garage.mjs';
import { vehicleDetails, tokenScopes } from '../lib/tesla.mjs';
import { loginScopes } from '../lib/settings.mjs';
const vin = '5YJ3E1EA7KF000001';
function fixture() {
  const session = { tokens: { accessToken: 'fake', expiresAt: Date.now()+3600_000, scopes: ['vehicle_device_data','vehicle_cmds','vehicle_charging_cmds'] } };
  const cache = new Map(); const calls=[]; let online=true;
  const api = (operation, method='GET', input={}, extra={}) => garageApi({session,config:{audience:'https://fleet.test'},path:`/api/vehicles/${vin}/${operation}`,method,input,
    cached: async (key, fn) => { if(!cache.has(key)) cache.set(key, await fn()); return cache.get(key); },forget:key=>cache.delete(key),
    fetchImpl: async (url, options) => { calls.push({url,options}); if(url.endsWith('/wake_up')) { online=true; return Response.json({response:{vin,state:'online'}}); } return Response.json({response: url.includes('/vehicle_data') ? {vin,state:'online',charge_state:{battery_level:75,charge_energy_added:12},vehicle_state:{tpms_pressure_fl:2.9,df:0,pf:1}} : {vin,state:online?'online':'offline'}}); },...extra });
  return {session,cache,calls,api,offline:()=>{online=false;}};
}
test('retained readings and history survive offline checks without fabricating fresh timestamps or extra data requests',async()=>{
 const f=fixture(); const first=await f.api('refresh','POST');
 assert.equal(first.vehicle.battery,75); assert.equal((await f.api('history')).readings.length,1);
 await f.api('refresh','POST'); assert.equal((await f.api('history')).readings.length,1);
 f.offline(); f.cache.clear(); const offline=await f.api('refresh','POST');
 assert.equal(offline.status.state,'offline'); assert.equal(offline.vehicle.fetchedAt,first.vehicle.fetchedAt);
 assert.equal(f.calls.filter(c=>c.url.includes('vehicle_data')).length,1);
 assert.equal((await f.api('snapshot')).vehicle.battery,75);
});
test('wake requires permission, performs only one wake, and clears stale offline cache',async()=>{
 const f=fixture(); f.offline(); await f.api('refresh','POST');
 f.session.tokens.scopes=[]; await assert.rejects(f.api('wake','POST'),e=>e.code==='permission_required');
 assert.equal(f.calls.some(c=>c.url.endsWith('/wake_up')),false);
 f.session.tokens.scopes=['vehicle_cmds']; assert.equal((await f.api('wake','POST')).status.state,'online');
 assert.equal((await f.api('refresh','POST')).vehicle.battery,75);
 assert.equal(f.calls.filter(c=>c.url.endsWith('/wake_up')).length,1);
});
test('commands validate inputs, scope and proxy confirmation; uncertain responses are never retried',async()=>{
 const f=fixture(); let sends=0;
 const proxyFetch=async(url,options)=>{sends++;assert.match(url,/command\/set_charge_limit$/);assert.deepEqual(JSON.parse(options.body),{percent:80});return Response.json({response:{result:true}});};
 assert.equal((await f.api('command','POST',{command:'set_charge_limit',percent:80},{proxyFetch})).ok,true);
 await assert.rejects(f.api('command','POST',{command:'set_charge_limit',percent:120},{proxyFetch}),e=>e.status===400);
 await assert.rejects(f.api('command','POST',{command:'remote_start_drive'},{proxyFetch}),e=>e.status===400);
 f.session.tokens.scopes=['vehicle_cmds'];await assert.rejects(f.api('command','POST',{command:'set_charge_limit',percent:80},{proxyFetch}),e=>e.code==='permission_required');
 assert.equal(sends,1);
 await assert.rejects(f.api('command','POST',{command:'door_lock'},{proxyFetch:async()=>{sends++;throw new Error('secret provider detail');}}),e=>e.code==='command_unconfirmed'&&!e.message.includes('secret'));
 assert.equal(sends,2);
});
test('extended readings keep unavailable values unknown and expose location only with explicit access',()=>{
 const raw={vehicle_state:{df:0,pf:1,tpms_pressure_fl:0},drive_state:{latitude:12,longitude:34}};
 const normal=vehicleDetails(raw);assert.equal(normal.location,null);assert.equal(normal.openings.driverFront,false);assert.equal(normal.openings.passengerFront,true);assert.equal(normal.openings.driverWindow,null);assert.equal(normal.tires.frontLeft,0);
 assert.deepEqual(vehicleDetails(raw,{includeLocation:true}).location,{latitude:12,longitude:34});
 assert.throws(()=>commandParameters('set_sentry_mode',{on:'yes'}));
});
test('optional permissions are cumulative while unsupported scopes are discarded',()=>{
 const scope=loginScopes('controls',['vehicle_location','untrusted']);assert.match(scope,/vehicle_location/);assert.match(scope,/vehicle_charging_cmds/);assert.doesNotMatch(scope,/untrusted|energy_device_data/);
 const token=`x.${Buffer.from(JSON.stringify({scp:['vehicle_cmds']})).toString('base64url')}.x`;assert.deepEqual(tokenScopes(token),['vehicle_cmds']);assert.deepEqual(tokenScopes('opaque'),[]);
});
test('alerts, release notes and fleet key status normalize provider shapes without executable markup',async()=>{
 const f=fixture();
 const fetchImpl=async(url)=>Response.json({response:url.endsWith('recent_alerts')?{recent_alerts:[{name:'Alert',user_text:'<b>Check tire</b>'}]}:url.endsWith('release_notes')?{release_notes:[{title:'Update',description:'<script>bad()</script>New notes'}]}:{key_paired_vins:[vin],vehicle_info:{[vin]:{vehicle_command_protocol_required:true,firmware_version:'2026.1'}}}});
 assert.deepEqual((await f.api('alerts','GET',{}, {fetchImpl})).entries[0],{title:'Alert',description:'Check tire',date:''});
 assert.doesNotMatch((await f.api('releases','GET',{}, {fetchImpl})).entries[0].description,/<script>/);
 const status=await f.api('status','GET',{}, {fetchImpl});assert.equal(status.keyPaired,true);assert.equal(status.requiresSigning,true);assert.equal(status.firmware,'2026.1');
});
test('energy requires separate consent and preserves zero measurements',async()=>{
 const f=fixture();let calls=0;
 const extra={path:'/api/energy',fetchImpl:async()=>{calls++;return Response.json({response:[{energy_site_id:123,site_name:'Home'}]});}};
 await assert.rejects(f.api('','GET',{},extra),e=>e.code==='permission_required');assert.equal(calls,0);
 f.session.tokens.scopes.push('energy_device_data');assert.equal((await f.api('','GET',{},extra)).sites[0].id,'123');
 const data=await f.api('','GET',{}, {path:'/api/energy/123',fetchImpl:async()=>Response.json({response:{percentage_charged:0,solar_power:0,load_power:220,grid_status:'Active'}})});
 assert.equal(data.battery,0);assert.equal(data.solarWatts,0);assert.equal(data.batteryWatts,null);
});
