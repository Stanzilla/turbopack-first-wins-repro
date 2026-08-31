import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

export const chunksDir = '.next/static/chunks';

export function findRuntimeChunk(directory = chunksDir) {
  const file = readdirSync(directory)
    .filter((candidate) => candidate.startsWith('turbopack-') && candidate.endsWith('.js'))
    .sort()[0];
  if (!file) throw new Error('no Turbopack runtime chunk found; run `npm run build` first');
  return file;
}

export function recordChunk(file, directory = chunksDir) {
  const pushed = [];
  const sandbox = {
    TURBOPACK: { push: (tuple) => pushed.push(tuple) },
    __turbopack_load_page_chunks__: () => {},
    console: { log() {}, warn() {}, error() {} },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(directory, file), 'utf8'), sandbox, { filename: file });

  const groups = [];
  for (const tuple of pushed) {
    if (!Array.isArray(tuple)) continue;
    if (tuple.length === 2 && typeof tuple[1] === 'object') continue;

    let ids = [];
    for (let index = 1; index < tuple.length; index++) {
      const item = tuple[index];
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

export function bootRuntime(runtimeChunkFile, directory = chunksDir) {
  const requestedScripts = [];
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    URL,
    DOMException: class DOMException extends Error {},
    document: {
      currentScript: undefined,
      createElement: () => ({}),
      createComment: () => ({}),
      querySelectorAll: () => [],
      head: {
        appendChild(node) {
          if (node && typeof node.src === 'string') requestedScripts.push(node.src);
        },
      },
    },
    TURBOPACK_ASSET_SUFFIX: '',
    TURBOPACK_NEXT_CHUNK_URLS: [],
    __turbopack_load_page_chunks__: () => {},
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);

  const evaluateChunk = (file) => {
    sandbox.TURBOPACK_NEXT_CHUNK_URLS.push(`/_next/static/chunks/${file}`);
    vm.runInContext(readFileSync(join(directory, file), 'utf8'), sandbox, { filename: file });
  };

  evaluateChunk(runtimeChunkFile);
  return { turbopack: sandbox.TURBOPACK, evaluateChunk, requestedScripts };
}

export const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));
