import test from 'node:test';
import assert from 'node:assert/strict';
import { Cdp, closesNow, judgmentVerdictFor } from '../server/engine/visual.mjs';

class Socket extends EventTarget { send() {} }
test('an unresponsive capture command rejects instead of holding the room forever', async () => {
  const cdp = new Cdp(new Socket(), { timeoutMs: 20 });
  await assert.rejects(cdp.send('Page.captureScreenshot'), /no respondió/);
  assert.equal(cdp.pending.size, 0);
});
test('browser disconnection releases commands and event waits', async () => {
  const socket = new Socket();
  const cdp = new Cdp(socket);
  const command = cdp.send('Runtime.evaluate');
  const event = cdp.wait('Page.loadEventFired', 30000);
  socket.dispatchEvent(new Event('close'));
  await assert.rejects(command, /cerró la conexión/);
  await assert.rejects(event, /cerró la conexión/);
  assert.equal(cdp.pending.size, 0);
  assert.equal(cdp.waiters.length, 0);
});
test('reusing a screenshot ID cannot make an old visual approval current', () => {
  const room = { repo: { head: 'new' }, artifacts: { visual: { shots: [{ id: 'principal', hash: 'new-image', commit: 'new' }] } } };
  assert.equal(closesNow(room, { verdict: 'pasa', independence: 'ajeno', captures: [{ id: 'principal', hash: 'old-image' }] }), false);
});
