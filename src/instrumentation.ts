// Step 14C: Next's once-per-server-instance hook (see node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md).
// register() runs before the server handles a request, in `next dev` and in `next start`. It is the ONLY
// production caller of the server composition point, which wires modules that must not know each other
// (for example the Agreement policy provider into Partner Reviews). Node runtime only: the composition
// reaches firebase-admin, which cannot run on the Edge runtime.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerServerProviders } = await import("@/server/composition/register-providers");
    registerServerProviders();
  }
}
