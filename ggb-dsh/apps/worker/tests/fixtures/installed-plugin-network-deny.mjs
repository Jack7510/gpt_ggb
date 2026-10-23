/** Test-only network guard loaded before the SDK runtime and its providers. */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {syncBuiltinESMExports} from 'node:module';
import {appendFileSync} from 'node:fs';

const attempts = [];
globalThis[Symbol.for('ggb.sdk.networkAttempts')] = attempts;
const deny = () => {
  attempts.push('network-denied');
  appendFileSync(process.env.GGB_SDK_NETWORK_ATTEMPTS, 'network-denied\n');
  throw new Error('installed_plugin_sdk_network_forbidden');
};
globalThis.fetch = deny;
http.request = deny;
http.get = deny;
https.request = deny;
https.get = deny;
net.Socket.prototype.connect = deny;
syncBuiltinESMExports();
