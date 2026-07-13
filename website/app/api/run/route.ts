// Proxies the "run the agent" stream to the agent server on our VM.
// The VM speaks plain HTTP; browsers block that from an HTTPS page, so the
// browser talks to this route and the fetch below happens server-side.
const AGENT_SERVER = process.env.AGENT_SERVER || "http://68.233.104.110:8443";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  let upstream: Response;
  try {
    upstream = await fetch(`${AGENT_SERVER}/run?${searchParams.toString()}`, {
      headers: { accept: "text/event-stream" },
      signal: request.signal,
    });
  } catch {
    return new Response("event: run-error\ndata: {\"message\":\"The agent server is unreachable right now.\"}\n\n", {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
