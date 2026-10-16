export const PUBLIC_KEY_PATH = '/.well-known/appspecific/com.tesla.3p.public-key.pem';
export const SCOPES = 'openid offline_access vehicle_device_data';
export const FEATURE_SCOPES = { controls: `${SCOPES} vehicle_cmds vehicle_charging_cmds`, location: `${SCOPES} vehicle_location`, energy: `${SCOPES} energy_device_data` };
export function loginScopes(features = '', existing = []) {
  return [...new Set([SCOPES, ...existing.filter((scope) => ['vehicle_cmds', 'vehicle_charging_cmds', 'vehicle_location', 'energy_device_data'].includes(scope)), FEATURE_SCOPES[features] || ''].join(' ').split(/\s+/).filter(Boolean))].join(' ');
}
export const REGIONS = {
  na: 'https://fleet-api.prd.na.vn.cloud.tesla.com',
  eu: 'https://fleet-api.prd.eu.vn.cloud.tesla.com',
};
