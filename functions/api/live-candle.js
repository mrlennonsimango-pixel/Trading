export async function onRequestPost(context) {
  if (!context.env.TRADING_WORKER) return Response.json({ ok:false, error:"TRADING_WORKER service binding is not configured" }, { status:503 });
  const incoming = new URL(context.request.url);
  const target = new URL("/live-candle", incoming.origin);
  target.search = incoming.search;
  const body = await context.request.arrayBuffer();
  return context.env.TRADING_WORKER.fetch(new Request(target.toString(), {
    method:"POST",
    headers:{ "content-type": context.request.headers.get("content-type") || "application/json" },
    body
  }));
}
