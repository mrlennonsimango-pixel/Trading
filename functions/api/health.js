export async function onRequestGet(context) {
  if (!context.env.TRADING_WORKER) {
    return Response.json(
      {
        ok: false,
        error: "TRADING_WORKER service binding is not configured"
      },
      { status: 503 }
    );
  }

  const requestUrl = new URL(context.request.url);
  const workerUrl = new URL("/health", requestUrl);

  const response = await context.env.TRADING_WORKER.fetch(
    new Request(workerUrl.toString(), {
      method: "GET"
    })
  );

  return response;
}
