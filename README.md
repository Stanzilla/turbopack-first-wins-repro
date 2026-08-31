# Turbopack browser runtime: first-wins module registration installs the wrong factory

**Next.js:** 16.3.3 (also reproduced on 16.4.0-canary.12) · **Bundler:** Turbopack · **Router:** Pages · **Target:** browser, production build

## Summary

The Turbopack browser runtime registers modules in a compressed form where several module ids can share one factory:

```js
(globalThis.TURBOPACK ||= []).push([chunkRef, id1, id2, ..., factory, id3, factory2, ...]);
```

`installCompressedModuleFactories` resolves each group with a first-wins rule: if **any** id in a group already has a factory, the whole group reuses that existing factory and the group's own factory is **silently discarded**.

This is unsound whenever the same module id is emitted with different factory semantics in different chunks. This repository demonstrates two concrete cases, both driven through the **real, unmodified runtime chunk** of this build:

1. **Divergent async-loader factories (fully natural, present in this 6-page app).** Turbopack emits the same loader module id for `import('../lib/heavy.js')` with two different bodies: one variant loads a chunk and then requires the target, the other variant is `Promise.resolve().then(() => require(target))` and *assumes the target factory is already registered*. Which behavior a session gets depends on chunk execution order.
2. **Overlapping scope-hoisted groups (synthetic tuples, real runtime).** When two merged groups overlap on one id, the second group's members are bound to the first group's factory. A member that exists only in the second group then evaluates a foreign merged scope and requires modules its own chunk graph never provides, which throws:

```
Module <X> was instantiated because it was required from module <Y>,
but the module factory is not available.
```

This is the exact error we see at scale in production (details at the end).

## Reproduction

```bash
npm install
npm run build     # next build (Turbopack)
npm run analyze   # static scan of .next/static/chunks
npm run repro     # drives the real runtime chunk in Node
```

No dev server and no browser are needed. The driver evaluates the build's own `turbopack-*.js` runtime chunk in a Node `vm` context (with a minimal `document` stub so chunk loads are observable) and then registers real and synthetic chunks against it.

### `npm run analyze` (static evidence)

The scan parses every chunk's `TURBOPACK.push` tuples without executing any module code. On this 6-page app it reports:

```
loader ids with DIVERGENT bodies : 3

DIVERGENT async-loader module 6083:
  load "static/chunks/266vlf9oqvd-x.js" -> require(8215)
      registered by 02i4j1jprkfxe.js          (page chunk of /dyn-a)
  resolve -> require(8215)  [assumes 8215 already registered]
      registered by 3d12xmd3hpnio.js          (page chunk of /dyn-b)
```

The source of the divergence is minimal:

* [`pages/dyn-a.js`](pages/dyn-a.js) only imports `lib/heavy.js` dynamically. Its chunk does not contain `heavy.js`, so its copy of loader `6083` must load the extra chunk first.
* [`pages/dyn-b.js`](pages/dyn-b.js) imports `lib/heavy.js` statically **and** dynamically. Its chunk contains `heavy.js`, so its copy of loader `6083` is compiled down to `Promise.resolve().then(...)`.

Same module id, two semantically different factories. First-wins registration arbitrates between them by script execution order.

Two of the three divergent ids in this app (`8805`, `8761`) are Next.js internal loaders (`_app` / `_error` page loaders), not app code. On 16.4.0-canary.12 the internal ones are gone but the app-level one still reproduces.

### `npm run repro` (runtime evidence)

Case C registers the two **unmodified** page chunks against the real runtime in both orders and probes the loader via `e.A(6083)` (what `import()` compiles to):

```
order: 3d12xmd3hpnio.js  then  02i4j1jprkfxe.js
  installed variant: Promise.resolve (no chunk request)
  resolved immediately, heavyValue('probe') = "probe/heavy"

order: 02i4j1jprkfxe.js  then  3d12xmd3hpnio.js
  installed variant: chunk-loading
  runtime injected <script src="/_next/static/chunks/266vlf9oqvd-x.js"> before resolving
```

Same two chunks, same module id, different installed behavior. In the benign direction this only downloads an unnecessary chunk. In the dangerous direction the `Promise.resolve` variant wins while the chunk that holds the target factory has not executed (late script evaluation, a failed or truncated script, or an entry that does not wait for all chunks). Then the target require throws the `module factory is not available` error.

Case A shows that failure mode deterministically with the group-overlap shape (real runtime, synthetic tuples):

```js
TURBOPACK.push(['static/chunks/page-a-hoisted.js', 100, 101, factoryMergedA]); // requires 999999 from page A's graph
TURBOPACK.push(['static/chunks/page-b-hoisted.js', 101, 102, factoryB]);       // overlaps on 101 -> factoryB DISCARDED
await TURBOPACK.push(['static/chunks/page-b-entry.js', { otherChunks: [...], runtimeModuleIds: [102] }]);
```

```
page B entry crashed:
  Module 999999 was instantiated because it was required from module 102,
  but the module factory is not available.
```

Module `102` never references `999999`. It exists only in page B's self-contained group, but because id `101` already had page A's factory, the runtime bound `102` to that factory as well. Case B is the control: the identical page B chunk works when nothing overlaps.

## The buggy code

Deminified from `.next/static/chunks/turbopack-*.js`:

```js
function installCompressedModuleFactories(chunkModules, moduleFactories) {
  let i = 1;
  while (i < chunkModules.length) {
    let existingGroupFactory, end = i + 1;
    while (end < chunkModules.length && typeof chunkModules[end] !== 'function') end++;
    if (end === chunkModules.length) throw Error('malformed chunk format, expected a factory function');
    const factory = chunkModules[end];

    // if ANY id in this group already has a factory, reuse it for the whole group
    for (let c = i; c < end; c++) {
      const existing = moduleFactories.get(chunkModules[c]);
      if (existing) { existingGroupFactory = existing; break; }
    }

    const chosen = existingGroupFactory ?? factory;
    for (let n = i; n < end; n++) {
      const id = chunkModules[n];
      if (!moduleFactories.has(id)) moduleFactories.set(id, chosen);
    }
    i = end + 1;
  }
}
```

The rule is only sound if every registration of a module id is semantically identical and every group that contains an id is identical across chunks. Both assumptions are false: the loader bodies above differ per chunk by construction, and nothing in the runtime detects or reports a mismatch.

## This happens at scale in real builds

Measured on one production build of a large Pages Router app (3,282 parsed chunks, ~217k registration groups, 121 chunks on the entry document):

* **59 module ids** are registered with divergent async-loader bodies (chunk-loading variant in some chunks, `Promise.resolve` variant in others). One id has the chunk-loading variant in 283 chunks and the `Promise.resolve` variant in 1.
* Joining those loaders against `build-manifest.json`: on **9 pages** the `Promise.resolve` variant wins in document order while the target module's factory lives in a **different chunk** of that page. Those pages work only while every listed chunk fully executes; any partial-execution window turns the first dynamic import into the `module factory is not available` error.
* Scope hoisting emits **7,138 merged groups** (largest: 43 modules sharing 1 factory), and **1,303 modules** are both inside a merged group and duplicated across chunks, which is the population exposed to the group-overlap path.

| | scope hoisting on | `turbopackScopeHoisting: false` |
| --- | ---: | ---: |
| groups with >1 module | 7,138 (3.1%) | **0** |
| modules inside merged groups | 18,701 | 0 |
| largest group | 43 modules → 1 factory | 1 |
| modules in >1 chunk **and** in a merged group | **1,303** | **0** |

Both builds are the same commit, differing only in the flag. Bundle cost of disabling it: +0.4% gzipped (+1.8% raw).

## What we observe in production

iOS WKWebView, cold foreground load, everything delivered, intermittent, self-resolves after hours:

```
ready=complete chunks=122 rtChunks=121 rtMissing=0     <- every chunk fetched
exec=121/2/4697                                        <- every chunk executed
dpl=<single build id>                                  <- no mixed deploy
errKind=module_factory
lastError=Module 748765 was instantiated because it was required from
          module 946878, but the module factory is not available.
```

The requirer (`946878`) is in a merged group of three; the module reported missing is in a group of one, duplicated across two chunks. Hydration never completes and users are stuck on the loading screen.

## Workaround

```js
// next.config.mjs
experimental: {
  turbopackScopeHoisting: false,
},
```

This removes merged groups entirely. It does not remove the divergent async-loader bodies, but in our measurements it removes the population involved in the production error signature.

## Honest scope of this report

* The divergent async-loader factories and the order-dependent installation (Cases C and the analyzer) are fully natural and deterministic in this minimal app, on both 16.3.3 and 16.4.0-canary.12.
* The group-overlap crash (Case A) proves the runtime discards a chunk's own factory, using the real runtime with synthetic registration tuples. In our clean production build we found no two chunks that emit non-identical overlapping groups, so reaching that path in the wild likely needs an extra ingredient (for example partial chunk evaluation, a stale cached chunk from a previous deploy that shares module ids, or an HMR/update path).
* We have not proven which of the two paths produces our exact production failures. What we can show is that the unsound arbitration exists, that real builds create both preconditions at scale (59 divergent loader ids, 1,303 overlap-exposed modules, 9 order-fragile pages), and that the production error has the matching shape.
