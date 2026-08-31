// Parses every chunk in .next/static/chunks and reports how modules are
// registered: scope-hoisting groups (several module ids sharing one factory),
// modules duplicated across chunks, overlapping groups (the precondition
// for the runtime discarding a chunk's own factory), and async-loader modules
// whose factory BODY differs between chunks (availability-dependent code
// under one availability-independent module id).
//
// Usage: node analyze-chunks.mjs [chunksDir]

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const chunksDir = process.argv[2] ?? '.next/static/chunks';

// chunkFile -> Array<{ ids: number[], factory: Function }>
const groupsByChunk = new Map();

for (const file of readdirSync(chunksDir).sort()) {
  if (!file.endsWith('.js')) continue;
  const source = readFileSync(join(chunksDir, file), 'utf8');
  const pushed = [];
  // TURBOPACK is deliberately NOT an array: the runtime chunk's IIFE starts
  // with `if (!Array.isArray(globalThis.TURBOPACK)) return;`, so this records
  // the registrations without executing the runtime or any module factory.
  const sandbox = {
    TURBOPACK: { push: (tuple) => pushed.push(tuple) },
    __turbopack_load_page_chunks__: () => {},
    console,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  try {
    vm.runInContext(source, sandbox, { filename: file });
  } catch (error) {
    console.error(`  (skipped ${file}: ${error.message})`);
    continue;
  }

  const groups = [];
  for (const tuple of pushed) {
    if (!Array.isArray(tuple)) continue;
    if (tuple.length === 2 && typeof tuple[1] === 'object') continue; // entry
    // Compressed module factories: [scriptRef, id, id, ..., factory, id, factory, ...]
    let ids = [];
    for (let i = 1; i < tuple.length; i++) {
      const item = tuple[i];
      if (typeof item === 'function') {
        groups.push({ ids, factory: item });
        ids = [];
      } else if (typeof item === 'object' && item !== null) {
        // entry descriptor mixed into a module chunk
      } else {
        ids.push(item);
      }
    }
  }
  if (groups.length > 0) groupsByChunk.set(file, groups);
}

// ---- statistics -----------------------------------------------------------

let totalGroups = 0;
let mergedGroups = 0;
let largestGroup = 0;
const chunksOfModule = new Map(); // id -> Set<chunkFile>
const groupsOfModule = new Map(); // id -> Array<{ chunk, ids }>

for (const [chunk, groups] of groupsByChunk) {
  for (const group of groups) {
    totalGroups++;
    if (group.ids.length > 1) mergedGroups++;
    largestGroup = Math.max(largestGroup, group.ids.length);
    for (const id of group.ids) {
      if (!chunksOfModule.has(id)) chunksOfModule.set(id, new Set());
      chunksOfModule.get(id).add(chunk);
      if (!groupsOfModule.has(id)) groupsOfModule.set(id, []);
      groupsOfModule.get(id).push({ chunk, ids: group.ids });
    }
  }
}

const duplicated = [...chunksOfModule.entries()].filter(([, set]) => set.size > 1);

// The dangerous shape: one module id appears in two groups (in different
// chunks) whose member sets differ. Whichever chunk registers second has its
// factory discarded for the whole group; members that are NOT part of the
// first group become victims bound to a factory of a scope they don't belong to.
const overlaps = [];
for (const [id, groups] of groupsOfModule) {
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i];
      const b = groups[j];
      if (a.chunk === b.chunk) continue;
      const aKey = a.ids.join(',');
      const bKey = b.ids.join(',');
      if (aKey === bKey) continue;
      const shared = a.ids.filter((x) => b.ids.includes(x));
      const victimsIfALoadsFirst = b.ids.filter((x) => !a.ids.includes(x));
      const victimsIfBLoadsFirst = a.ids.filter((x) => !b.ids.includes(x));
      overlaps.push({ id, a, b, shared, victimsIfALoadsFirst, victimsIfBLoadsFirst });
    }
  }
}
// de-duplicate pairs discovered via several shared ids
const seenPairs = new Set();
const uniqueOverlaps = overlaps.filter(({ a, b }) => {
  const key = `${a.chunk}:${a.ids.join(',')}|${b.chunk}:${b.ids.join(',')}`;
  if (seenPairs.has(key)) return false;
  seenPairs.add(key);
  return true;
});

// ---- divergent async-loader factories ------------------------------------
// The same loader module id can be emitted with different bodies:
//   load variant   : e.v(t => Promise.all(["static/chunks/X.js"].map(...)).then(() => t(TARGET)))
//   resolve variant: e.v(t => Promise.resolve().then(() => t(TARGET)))
// The resolve variant assumes TARGET's factory is already registered. Which
// variant a session runs is decided by first-wins registration order.
const resolveRe = /Promise\.resolve\(\)\.then\(\(\)=>.\((\d+)\)\)/;
const loadRe = /Promise\.all\(\[(("static\/chunks\/[^"]+",?)+)\]\.map\(.=>.\.l\(.\)\)\)\.then\(\(\)=>.\((\d+)\)\)/;

const loaderVariants = new Map(); // id -> Map<variantDesc, chunks[]>
for (const [chunk, groups] of groupsByChunk) {
  for (const group of groups) {
    if (group.ids.length !== 1) continue;
    const src = String(group.factory);
    if (!src.includes('.v(')) continue;
    let desc;
    const r = src.match(resolveRe);
    const l = src.match(loadRe);
    if (r) desc = `resolve -> require(${r[1]})  [assumes ${r[1]} already registered]`;
    else if (l) desc = `load ${l[1]} -> require(${l[3]})`;
    else continue;
    const id = group.ids[0];
    if (!loaderVariants.has(id)) loaderVariants.set(id, new Map());
    const m = loaderVariants.get(id);
    if (!m.has(desc)) m.set(desc, []);
    m.get(desc).push(chunk);
  }
}
const divergentLoaders = [...loaderVariants.entries()].filter(([, m]) => m.size > 1);

console.log(`chunks with module registrations : ${groupsByChunk.size}`);
console.log(`module registration groups       : ${totalGroups}`);
console.log(`groups with >1 module (merged)   : ${mergedGroups}`);
console.log(`largest group                    : ${largestGroup} modules -> 1 factory`);
console.log(`module ids registered in >1 chunk: ${duplicated.length}`);
console.log(`overlapping non-identical groups : ${uniqueOverlaps.length}`);
console.log(`loader ids with DIVERGENT bodies : ${divergentLoaders.length}`);
console.log('');

for (const [id, m] of divergentLoaders) {
  console.log(`DIVERGENT async-loader module ${id}:`);
  for (const [desc, chunks] of m) {
    console.log(`  ${desc}`);
    for (const c of chunks) console.log(`      registered by ${c}`);
  }
  console.log('');
}

for (const { a, b, shared, victimsIfALoadsFirst, victimsIfBLoadsFirst } of uniqueOverlaps) {
  console.log(`OVERLAP shared id(s) ${shared.join(', ')}`);
  console.log(`  ${a.chunk}: group [${a.ids.join(', ')}]`);
  console.log(`  ${b.chunk}: group [${b.ids.join(', ')}]`);
  if (victimsIfALoadsFirst.length > 0) {
    console.log(
      `  if ${a.chunk} registers first -> module(s) ${victimsIfALoadsFirst.join(', ')} lose their own factory`,
    );
  }
  if (victimsIfBLoadsFirst.length > 0) {
    console.log(
      `  if ${b.chunk} registers first -> module(s) ${victimsIfBLoadsFirst.join(', ')} lose their own factory`,
    );
  }
  console.log('');
}
