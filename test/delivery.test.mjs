import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compiled = await build({ entryPoints: [path.join(root, 'app/src/lib/delivery.ts')], bundle: true, write: false, platform: 'node', format: 'esm' });
const { deliveryEvidence } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const room = items => ({ work: items ? { items } : null, result: { consensus: { points: [{status:'agreed'},{status:'open'}] } } });
test('a decision without execution does not claim passed tests', () => {
  assert.deepEqual(deliveryEvidence(room(null)), {hasWork:false,integrated:0,reviewed:0,verified:0,unresolved:1});
});
test('only integrated, actually executed green checks count', () => {
  const base = { status:'integrated', reviewerName:'Reviewer', unreviewed:false };
  const evidence = deliveryEvidence(room([
    {...base,verify:{ran:true,ok:true}},
    {...base,verify:{ran:false,ok:true}},
    {...base,verify:{ran:true,ok:false,preExisting:true}},
    {...base,verify:null,unreviewed:true},
    {...base,status:'reverted',verify:{ran:true,ok:true}},
  ]));
  assert.equal(evidence.integrated,4);
  assert.equal(evidence.verified,1);
  assert.equal(evidence.reviewed,3);
});
test('frozen work is used when there is no live work snapshot', () => {
  const r = room(null);
  r.result.work = {items:[{status:'integrated',verify:{ran:true,ok:true}}]};
  assert.equal(deliveryEvidence(r).verified,1);
  assert.equal(deliveryEvidence(r).reviewed,0);
});
test('an empty live snapshot takes precedence over historical work', () => {
  const r = room([]);
  r.result.work = {items:[{status:'integrated',verify:{ran:true,ok:true}}]};
  assert.equal(deliveryEvidence(r).verified,0);
});
