// Find async-loader module IDs whose generated factory body differs between
// production chunks. This records TURBOPACK registrations without executing
// module factories.

import { readdirSync } from 'node:fs';
import { recordChunk } from './runtime-harness.mjs';

const chunksDir = process.argv[2] ?? '.next/static/chunks';
const resolveRe = /Promise\.resolve\(\)\.then\(\(\)=>.\((\d+)\)\)/;
const loadRe = /Promise\.all\(\[(("static\/chunks\/[^"]+",?)+)\]\.map\(.=>.\.l\(.\)\)\)\.then\(\(\)=>.\((\d+)\)\)/;

const groupsByChunk = new Map();
for (const file of readdirSync(chunksDir).sort()) {
  if (!file.endsWith('.js')) continue;
  try {
    const groups = recordChunk(file, chunksDir);
    if (groups.length > 0) groupsByChunk.set(file, groups);
  } catch (error) {
    console.error(`skipped ${file}: ${error.message}`);
  }
}

const loaderVariants = new Map();
for (const [chunk, groups] of groupsByChunk) {
  for (const { ids, source } of groups) {
    if (ids.length !== 1 || !source.includes('.v(')) continue;

    const resolveMatch = source.match(resolveRe);
    const loadMatch = source.match(loadRe);
    let variant;
    if (resolveMatch) {
      variant = `resolve -> require(${resolveMatch[1]})`;
    } else if (loadMatch) {
      variant = `load ${loadMatch[1]} -> require(${loadMatch[3]})`;
    } else {
      continue;
    }

    const id = ids[0];
    if (!loaderVariants.has(id)) loaderVariants.set(id, new Map());
    const variants = loaderVariants.get(id);
    if (!variants.has(variant)) variants.set(variant, []);
    variants.get(variant).push(chunk);
  }
}

const divergentLoaders = [...loaderVariants.entries()].filter(([, variants]) => variants.size > 1);
if (divergentLoaders.length === 0) {
  throw new Error('expected at least one async-loader ID with divergent factory bodies');
}

console.log(`chunks with module registrations: ${groupsByChunk.size}`);
console.log(`divergent async-loader IDs: ${divergentLoaders.length}`);
for (const [id, variants] of divergentLoaders) {
  console.log(`\nmodule ${id}:`);
  for (const [variant, chunks] of variants) {
    console.log(`  ${variant}`);
    for (const chunk of chunks) console.log(`    ${chunk}`);
  }
}
console.log('\nPASS: one module ID has different generated loader behavior');
