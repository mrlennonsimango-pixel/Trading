export async function onRequestGet(context) {
  if (!context.env.TRADING_WORKER) return Response.json({ ok:false, error:"TRADING_WORKER service binding is not configured" }, { status:503 });
  const incoming = new URL(context.request.url);
  const target = new URL("/live-tick", incoming.origin);
  target.searchParams.set("symbol", incoming.searchParams.get("symbol") || "");
  target.searchParams.set("_t", String(Date.now()));
  const response = await context.env.TRADING_WORKER.fetch(new Request(target.toString(), { method:"GET" }));
  const headers = new Headers(response.headers);
  headers.set("cache-control","no-store, no-cache, must-revalidate, max-age=0");
  headers.set("pragma","no-cache");
  return new Response(response.body, { status:response.status, headers });
}
