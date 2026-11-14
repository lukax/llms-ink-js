/** Node's, Bun's and Deno's `process`; absent in browsers and Workers without nodejs_compat. */
interface Scope {
  process?: { env?: Record<string, string | undefined> };
}

/** `process.env[name]` where there is a `process` (Node, Bun, Deno with env access); undefined elsewhere. */
export function env(name: string): string | undefined {
  // Read off globalThis, not a declared global, so it neither needs nor clashes with @types/node.
  const scope = globalThis as Scope;
  try {
    return scope.process?.env?.[name]?.trim() || undefined;
  } catch {
    return undefined; // Deno without --allow-env throws
  }
}
