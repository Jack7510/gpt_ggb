/** Test-only SDK stdio server: emits partial events and exits, no provider code. */
import {createInterface} from 'node:readline';

const emit = message => process.stdout.write(JSON.stringify(message) + '\n');
createInterface({input: process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    emit({jsonrpc: '2.0', id: request.id, result: {
      serverInfo: {name: 'deepseek-harness-sdk-runtime', version: 'test-only'},
    }});
  } else if (request.method === 'session/prompt') {
    const sessionId = request.params.sessionId;
    emit({jsonrpc: '2.0', id: request.id, result: {messageId: 'fixture-message'}});
    for (const event of [
      {type: 'agent/inbox/spliced', data: {inserted: [{id: 'fixture-message'}]}},
      {type: 'step/start', data: {turn: 1, step: 1}},
    ]) emit({jsonrpc: '2.0', method: 'session.event', params: {sessionId, event}});
    process.stderr.write('fixture transport tail ' + process.env.DEEPSEEK_API_KEY + '\n');
    setTimeout(() => process.exit(23), 30);
  }
});
