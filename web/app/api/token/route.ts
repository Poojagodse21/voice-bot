import { AccessToken } from "livekit-server-sdk";

// Creates a short-lived LiveKit access token for the browser.
// The user's prompt travels inside the participant metadata,
// so the agent can read it when the user joins the room.
export async function POST(request: Request) {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const livekitUrl = process.env.LIVEKIT_URL;

  if (!apiKey || !apiSecret || !livekitUrl) {
    return Response.json({ message: "Server is missing LiveKit settings" }, { status: 500 });
  }

  let prompt = "";
  try {
    const body = await request.json();
    prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  } catch {
    return Response.json({ message: "Invalid JSON body" }, { status: 400 });
  }

  // An empty prompt is allowed on purpose: the agent then uses its own
  // generic "answer anything" instructions.
  if (prompt.length > 4000) {
    return Response.json({ message: "Prompt is too long (max 4000 characters)" }, { status: 422 });
  }

  // A new room per conversation, so each user gets their own agent.
  const roomName = `voice-${crypto.randomUUID().slice(0, 8)}`;
  const identity = `user-${crypto.randomUUID().slice(0, 8)}`;

  const token = new AccessToken(apiKey, apiSecret, {
    identity,
    ttl: "10m",
    metadata: JSON.stringify({ prompt }),
  });
  token.addGrant({ room: roomName, roomJoin: true, canPublish: true, canSubscribe: true });

  return Response.json({
    token: await token.toJwt(),
    url: livekitUrl,
    roomName,
  });
}
