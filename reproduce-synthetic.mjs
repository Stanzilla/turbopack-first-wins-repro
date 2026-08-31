// Prove the compressed-group failure independently from the app chunk graph.
// The tuples are synthetic. The runtime is the real production runtime from
// this build.

import assert from 'node:assert/strict';
import { bootRuntime, findRuntimeChunk } from './runtime-harness.mjs';

const runtimeChunk = findRuntimeChunk();

{
  const { turbopack } = bootRuntime(runtimeChunk);
  turbopack.push([
    'static/chunks/page-a-hoisted.js',
    100,
    101,
    (context) => {
      const dependency = context.i(999999);
      context.s(['helperA', 0, `A:${dependency.value}`], 100);
      context.s(['helperB', 0, 'B (page A scope)'], 101);
    },
  ]);
  turbopack.push([
    'static/chunks/page-b-hoisted.js',
    101,
    102,
    (context) => {
      context.s(['helperB', 0, 'B (self-contained)'], 101);
      context.s(['helperC', 0, 'C (self-contained)'], 102);
    },
  ]);

  let overlapError;
  try {
    await turbopack.push([
      'static/chunks/page-b-entry.js',
      { otherChunks: ['static/chunks/page-b-hoisted.js'], runtimeModuleIds: [102] },
    ]);
  } catch (error) {
    overlapError = error;
  }
  assert.match(
    overlapError?.message ?? '',
    /Module 999999 was instantiated because it was required from module 102, but the module factory is not available/,
  );
}

{
  const { turbopack } = bootRuntime(runtimeChunk);
  let observed;
  turbopack.push([
    'static/chunks/page-b-hoisted.js',
    101,
    102,
    (context) => {
      context.s(['helperB', 0, 'B (self-contained)'], 101);
      context.s(['helperC', 0, 'C (self-contained)'], 102);
    },
  ]);
  turbopack.push([
    'static/chunks/probe.js',
    103,
    (context) => {
      observed = context.i(102).helperC;
      context.s([], 103);
    },
  ]);
  await turbopack.push([
    'static/chunks/page-b-entry.js',
    {
      otherChunks: ['static/chunks/page-b-hoisted.js', 'static/chunks/probe.js'],
      runtimeModuleIds: [103],
    },
  ]);
  assert.equal(observed, 'C (self-contained)');
}

console.log(`runtime chunk: ${runtimeChunk}`);
console.log('PASS: overlap reuses the first group factory and produces the missing-factory error');
console.log('PASS: the same second group succeeds without the overlap');
