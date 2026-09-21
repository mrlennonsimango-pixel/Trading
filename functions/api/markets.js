export async function onRequestGet(context) {
  if (!context.env.TRADING_WORKER) {
    return Response.json(
      { ok: false, error: "TRADING_WORKER service binding is not configured" },
      { status: 503 }
    );
  }

  const incoming = new URL(context.request.url);
  const target = new URL("/markets", incoming.origin);

  return context.env.TRADING_WORKER.fetch(
    new Request(target.toString(), { method: "GET" })
  );
}
