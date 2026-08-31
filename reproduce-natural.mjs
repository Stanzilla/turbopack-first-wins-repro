// Prove that two real, unmodified page chunks register the same async-loader
// module ID with different behavior, and that registration order selects the
// installed behavior.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  bootRuntime,
  findRuntimeChunk,
  flushMicrotasks,
  recordChunk,
} from './runtime-harness.mjs';

const runtimeChunk = findRuntimeChunk();
const manifest = JSON.parse(readFileSync('.next/build-manifest.json', 'utf8'));

function pageChunk(page) {
  const shared = new Set(manifest.pages['/_app']);
  const own = manifest.pages[page].filter(
    (chunk) => chunk.endsWith('.js') && !chunk.includes('turbopack-') && !shared.has(chunk),
  );
  assert.equal(own.length, 1, `expected one own chunk for ${page}, got ${own.join(', ')}`);
  return own[0].replace('static/chunks/', '');
}

const dynAChunk = pageChunk('/dyn-a');
const dynBChunk = pageChunk('/dyn-b');
const loadRe = /Promise\.all\(\["([^"]+)"\]\.map\(.=>.\.l\(.\)\)\)\.then\(\(\)=>.\((\d+)\)\)/;
const resolveRe = /Promise\.resolve\(\)\.then\(\(\)=>.\((\d+)\)\)/;

function loadersIn(file) {
  const loaders = new Map();
  for (const { ids, source } of recordChunk(file)) {
    if (ids.length !== 1 || !source.includes('.v(')) continue;
    const loadMatch = source.match(loadRe);
    const resolveMatch = source.match(resolveRe);
    if (loadMatch) {
      loaders.set(ids[0], { kind: 'load', chunk: loadMatch[1], target: Number(loadMatch[2]) });
    } else if (resolveMatch) {
      loaders.set(ids[0], { kind: 'resolve', target: Number(resolveMatch[1]) });
    }
  }
  return loaders;
}

const dynALoaders = loadersIn(dynAChunk);
const dynBLoaders = loadersIn(dynBChunk);
let loaderId;
let loadInfo;
for (const [id, info] of dynALoaders) {
  const other = dynBLoaders.get(id);
  if (info.kind === 'load' && other?.kind === 'resolve' && other.target === info.target) {
    loaderId = id;
    loadInfo = info;
    break;
  }
}
assert.notEqual(loaderId, undefined, 'expected /dyn-a and /dyn-b to emit divergent loaders');

async function probe(order) {
  const { turbopack, evaluateChunk, requestedScripts } = bootRuntime(runtimeChunk);
  for (const file of order) evaluateChunk(file);

  let loaderPromise;
  turbopack.push([
    'static/chunks/probe.js',
    999001,
    (context) => {
      loaderPromise = context.A(loaderId);
      context.s([], 999001);
    },
  ]);
  await turbopack.push([
    'static/chunks/probe-entry.js',
    { otherChunks: ['static/chunks/probe.js'], runtimeModuleIds: [999001] },
  ]);
  await flushMicrotasks();

  if (requestedScripts.length === 0) {
    const namespace = await loaderPromise;
    return { kind: 'resolve', value: namespace.heavyValue('probe'), requestedScripts };
  }

  assert.equal(requestedScripts.length, 1, 'expected one requested target chunk');
  evaluateChunk(requestedScripts[0].split('/').pop());
  const namespace = await loaderPromise;
  return { kind: 'load', value: namespace.heavyValue('probe'), requestedScripts };
}

const resolveFirst = await probe([dynBChunk, dynAChunk]);
const loadFirst = await probe([dynAChunk, dynBChunk]);

assert.equal(resolveFirst.kind, 'resolve');
assert.deepEqual(resolveFirst.requestedScripts, []);
assert.equal(resolveFirst.value, 'probe/heavy');
assert.equal(loadFirst.kind, 'load');
assert.deepEqual(loadFirst.requestedScripts, [`/_next/${loadInfo.chunk}`]);
assert.equal(loadFirst.value, 'probe/heavy');

console.log(`runtime chunk: ${runtimeChunk}`);
console.log(`loader module: ${loaderId}, target module: ${loadInfo.target}`);
console.log(`${dynBChunk} first: Promise.resolve, no chunk request`);
console.log(`${dynAChunk} first: requested /_next/${loadInfo.chunk}`);
console.log('PASS: real chunk order selects different behavior for the same module ID');
