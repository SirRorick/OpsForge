// ---------------------------------------------------------------------------
// The prefab library's one serverless function.
// ---------------------------------------------------------------------------
// vercel.json sends every /api/<route> here as ?route=<route>, and
// _lib/library.js does the rest. One function rather than nine because the
// routes share their connections and their cold start, and Vercel's free plan
// counts functions. Node's standard library only: no install step, no lockfile.
// ---------------------------------------------------------------------------

import { handle } from './_lib/library.js';
import { adaptersFrom } from './_lib/adapters.js';

let deps;

/** Built once per instance, so the dev server's in-memory store survives between requests. */
function dependencies() {
  if (deps === undefined) {
    const a = adaptersFrom(process.env);
    deps = a ? { ...a, env: process.env } : null;
  }
  return deps;
}

export async function GET(request) { return handle(request, dependencies()); }
export async function POST(request) { return handle(request, dependencies()); }
