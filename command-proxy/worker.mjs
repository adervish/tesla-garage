import { Container } from '@cloudflare/containers';
export class TeslaCommands extends Container {
  defaultPort = 8080;
  sleepAfter = '1m';
  envVars = { TESLA_PRIVATE_KEY: this.env.TESLA_PRIVATE_KEY };
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (!(request.method === 'GET' && path === '/health') && !(request.method === 'POST' && /^\/api\/1\/vehicles\/[A-HJ-NPR-Z0-9]{17}\/command\/(charge_start|charge_stop|set_charge_limit|set_charging_amps|auto_conditioning_start|auto_conditioning_stop|set_temps|door_lock|door_unlock|set_sentry_mode|charge_port_door_open|charge_port_door_close|flash_lights|honk_horn)$/.test(path))) return new Response('Not found', {status:404});
    try {
      return await env.CONTAINER.get(env.CONTAINER.idFromName('commands')).fetch(request);
    } catch { return Response.json({error:'Command service unavailable'}, {status:503}); }
  }
};
