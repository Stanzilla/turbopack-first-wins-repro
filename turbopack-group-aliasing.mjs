// Executes the REAL Turbopack browser runtime from this project's production
// build (.next/static/chunks) inside Node and demonstrates two defects in
// installCompressedModuleFactories:
//
//   Case A: when two scope-hoisted module groups overlap in one module id,
//           the runtime silently discards the second group's factory for ALL
//           of its members. A member that only exists in the second group is
//           bound to the first group's factory, which references modules from
//           a chunk graph the current session never executed. Instantiating
//           it produces the exact production error:
//             "Module N was instantiated because it was required from
//              module M, but the module factory is not available."
//
//   Case B: control run. The same second group works when the runtime does
//           not discard its factory.
//
//   Case C: fully natural, no synthetic tuples. This build emits the SAME
//           module id with two DIFFERENT factory bodies in two real chunks
//           (an async-loader module for import('../lib/heavy.js')):
//             - the /dyn-a chunk registers it as
//                 "load chunk X, then require target"
//             - the /dyn-b chunk registers it as
//                 "Promise.resolve, then require target"
//           First-wins registration means the installed behavior of that
//           module id depends on chunk execution order. This driver registers
//           the two real chunks in both orders and shows the flip.
//
// Run: npm run build && node turbopack-group-aliasing.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const chunksDir = '.next/static/chunks';
const CHUNK_BASE = '/_next/';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// Record a chunk's TURBOPACK registrations WITHOUT executing the runtime:
// the runtime IIFE bails out when globalThis.TURBOPACK is not an Array.
function recordChunk(file) {
  const source = readFileSync(join(chunksDir, file), 'utf8');
  const pushed = [];
  const sandbox = {
    TURBOPACK: { push: (t) => pushed.push(t) },
    __turbopack_load_page_chunks__: () => {},
    console: { log() {}, warn() {}, error() {} },
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: file });
  const groups = [];
  for (const tuple of pushed) {
    if (!Array.isArray(tuple)) continue;
    if (tuple.length === 2 && typeof tuple[1] === 'object') continue;
    let ids = [];
    for (let i = 1; i < tuple.length; i++) {
      const item = tuple[i];
      if (typeof item === 'function') {
        groups.push({ ids, source: String(item) });
        ids = [];
      } else if (typeof item !== 'object') {
        ids.push(item);
      }
    }
  }
  return groups;
}

// Create a vm context, evaluate the real runtime chunk in it, and return
// handles. `requestedScripts` records every <script src> the runtime asks
// the (stubbed) document to inject, i.e. every chunk load it starts.
function bootRuntime(runtimeChunkFile) {
  const requestedScripts = [];
  const documentStub = {
    currentScript: undefined,
    createElement: () => ({}),
    createComment: () => ({}),
    querySelectorAll: () => [],
    head: {
      appendChild(node) {
        if (node && typeof node.src === 'string') requestedScripts.push(node.src);
      },
    },
  };
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    URL,
    DOMException: class DOMException extends Error {},
    document: documentStub,
    TURBOPACK_ASSET_SUFFIX: '',
    TURBOPACK_NEXT_CHUNK_URLS: [],
    __turbopack_load_page_chunks__: () => {},
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);

  const evalChunk = (file) => {
    // The chunk resolves its own path from TURBOPACK_NEXT_CHUNK_URLS because
    // document.currentScript is undefined here.
    sandbox.TURBOPACK_NEXT_CHUNK_URLS.push(CHUNK_BASE + 'static/chunks/' + file);
    vm.runInContext(readFileSync(join(chunksDir, file), 'utf8'), sandbox, { filename: file });
  };

  evalChunk(runtimeChunkFile);
  // After the runtime IIFE, globalThis.TURBOPACK is { push } and push()
  // returns the registerChunk promise.
  return { turbopack: sandbox.TURBOPACK, evalChunk, requestedScripts };
}

const microtasks = () => new Promise((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------
// discovery: find the real chunks and module ids of this build
// ---------------------------------------------------------------------------

const runtimeChunk = readdirSync(chunksDir)
  .filter((f) => f.startsWith('turbopack-') && f.endsWith('.js'))
  .sort()[0];
if (!runtimeChunk) throw new Error('no turbopack runtime chunk found; run `npm run build` first');

const manifest = JSON.parse(readFileSync('.next/build-manifest.json', 'utf8'));
const pageChunk = (page) => {
  const shared = new Set(manifest.pages['/_app']);
  const own = manifest.pages[page].filter(
    (c) => c.endsWith('.js') && !c.includes('turbopack-') && !shared.has(c),
  );
  if (own.length !== 1) throw new Error(`expected 1 own chunk for ${page}, got ${own.join(', ')}`);
  return own[0].replace('static/chunks/', '');
};

const dynAChunk = pageChunk('/dyn-a');
const dynBChunk = pageChunk('/dyn-b');

// Locate the divergent async-loader module id: registered by BOTH page chunks
// as a single-module group, with a chunk-loading body in one and a
// Promise.resolve body in the other.
const loadRe = /Promise\.all\(\["([^"]+)"\]\.map\(.=>.\.l\(.\)\)\)\.then\(\(\)=>.\((\d+)\)\)/;
const resolveRe = /Promise\.resolve\(\)\.then\(\(\)=>.\((\d+)\)\)/;

const loadersIn = (file) => {
  const map = new Map();
  for (const { ids, source } of recordChunk(file)) {
    if (ids.length !== 1 || !source.includes('.v(')) continue;
    const l = source.match(loadRe);
    const r = source.match(resolveRe);
    if (l) map.set(ids[0], { kind: 'load', chunk: l[1], target: Number(l[2]) });
    else if (r) map.set(ids[0], { kind: 'resolve', target: Number(r[1]) });
  }
  return map;
};

const dynALoaders = loadersIn(dynAChunk);
const dynBLoaders = loadersIn(dynBChunk);
let loaderId, loadInfo;
for (const [id, info] of dynALoaders) {
  const other = dynBLoaders.get(id);
  if (info.kind === 'load' && other?.kind === 'resolve' && other.target === info.target) {
    loaderId = id;
    loadInfo = info;
    break;
  }
}
if (loaderId === undefined) {
  throw new Error('divergent loader not found; the build layout changed, re-run analyze-chunks.mjs');
}

console.log('build facts discovered from .next:');
console.log(`  runtime chunk        : ${runtimeChunk}`);
console.log(`  /dyn-a page chunk    : ${dynAChunk}  (registers loader ${loaderId} as "load ${loadInfo.chunk}")`);
console.log(`  /dyn-b page chunk    : ${dynBChunk}  (registers loader ${loaderId} as "Promise.resolve")`);
console.log(`  loader target module : ${loadInfo.target} (lib/heavy.js)`);
console.log('');

// ---------------------------------------------------------------------------
// Case A: overlapping scope-hoisted groups -> factory silently discarded
// ---------------------------------------------------------------------------

console.log('=== Case A: overlapping merged groups, second factory discarded ===');
{
  const { turbopack } = bootRuntime(runtimeChunk);

  // Page A's chunk: scope hoisting merged modules 100 and 101 into one
  // factory. That factory requires module 999999, whose own factory lives in
  // ANOTHER chunk of page A's graph. This session never executes that chunk
  // (in production: the un-awaited entry gap, a truncated script, or a chunk
  // that has not finished evaluating yet).
  turbopack.push([
    'static/chunks/page-a-hoisted.js',
    100, 101,
    (e) => {
      const dep = e.i(999999);
      e.s(['helperA', 0, 'A:' + dep.value], 100);
      e.s(['helperB', 0, 'B (page A scope)'], 101);
    },
  ]);

  // Page B's chunk: an independent, fully self-contained group that also
  // contains module 101, plus module 102 which exists ONLY here.
  turbopack.push([
    'static/chunks/page-b-hoisted.js',
    101, 102,
    (e) => {
      e.s(['helperB', 0, 'B (self-contained)'], 101);
      e.s(['helperC', 0, 'C (self-contained)'], 102);
    },
  ]);
  // installCompressedModuleFactories sees that id 101 already has a factory
  // and reuses it for the WHOLE group: page B's factory is discarded and
  // module 102 is now bound to page A's factory.

  try {
    await turbopack.push([
      'static/chunks/page-b-entry.js',
      { otherChunks: ['static/chunks/page-b-hoisted.js'], runtimeModuleIds: [102] },
    ]);
    console.log('  UNEXPECTED: entry ran without error');
  } catch (error) {
    console.log('  page B entry crashed:');
    console.log(`    ${error.message}`);
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Case B: control, same page B chunk alone works
// ---------------------------------------------------------------------------

console.log('=== Case B: control, page B chunk without the overlap ===');
{
  const { turbopack } = bootRuntime(runtimeChunk);
  let observed;
  turbopack.push([
    'static/chunks/page-b-hoisted.js',
    101, 102,
    (e) => {
      e.s(['helperB', 0, 'B (self-contained)'], 101);
      e.s(['helperC', 0, 'C (self-contained)'], 102);
    },
  ]);
  turbopack.push([
    'static/chunks/probe.js',
    103,
    (e) => {
      observed = e.i(102).helperC;
      e.s([], 103);
    },
  ]);
  await turbopack.push([
    'static/chunks/page-b-entry.js',
    {
      otherChunks: ['static/chunks/page-b-hoisted.js', 'static/chunks/probe.js'],
      runtimeModuleIds: [103],
    },
  ]);
  console.log(`  module 102 instantiated fine, helperC = ${JSON.stringify(observed)}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// Case C: REAL chunks only. The installed behavior of one module id depends
// on the execution order of two unmodified chunks from this build.
// ---------------------------------------------------------------------------

console.log('=== Case C: real chunks, loader behavior flips with execution order ===');

async function probeLoader(order) {
  const { turbopack, evalChunk, requestedScripts } = bootRuntime(runtimeChunk);
  for (const file of order) evalChunk(file);

  let loaderPromise;
  turbopack.push([
    'static/chunks/probe.js',
    999001,
    (e) => {
      loaderPromise = e.A(loaderId); // what import('../lib/heavy.js') compiles to
      e.s([], 999001);
    },
  ]);
  await turbopack.push([
    'static/chunks/probe-entry.js',
    { otherChunks: ['static/chunks/probe.js'], runtimeModuleIds: [999001] },
  ]);
  await microtasks();

  console.log(`  order: ${order.join('  then  ')}`);
  if (requestedScripts.length === 0) {
    const ns = await loaderPromise;
    console.log('    installed variant: Promise.resolve (no chunk request)');
    console.log(`    resolved immediately, heavyValue('probe') = ${JSON.stringify(ns.heavyValue('probe'))}`);
  } else {
    console.log('    installed variant: chunk-loading');
    console.log(`    runtime injected <script src="${requestedScripts[0]}"> before resolving`);
    // satisfy the request so the loader can finish
    evalChunk(requestedScripts[0].split('/').pop());
    const ns = await loaderPromise;
    console.log(`    after that extra chunk executed, heavyValue('probe') = ${JSON.stringify(ns.heavyValue('probe'))}`);
  }
  console.log('');
}

await probeLoader([dynBChunk, dynAChunk]);
await probeLoader([dynAChunk, dynBChunk]);

console.log('Same two unmodified chunks, same module id, different installed');
console.log('behavior depending on execution order. The runtime keeps whichever');
console.log('factory registers first and silently drops the other.');
console.log('');
console.log('The failure mode: when the Promise.resolve variant wins the race but');
console.log('the chunk that holds the target factory has not executed, requiring');
console.log(`the target throws "Module ${loadInfo.target} was instantiated because it was`);
console.log(`required from module ${loaderId}, but the module factory is not available."`);
console.log('(shown synthetically in Case A).');
