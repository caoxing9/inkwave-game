import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const apiUrl = process.env.TEABLE_API_URL;
  const token = process.env.TEABLE_APP_TOKEN;
  const appId = process.env.TEABLE_APP_ID;

  if (!apiUrl || !token) {
    return new NextResponse(null, { status: 204 });
  }

  let properties: Record<string, unknown> = {};
  try {
    properties = await request.json();
  } catch {
    // ignore
  }

  if (appId) {
    properties.appId = appId;
  }

  fetch(apiUrl + "/api/user/track", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event: "app.page_view",
      properties,
    }),
  }).catch(() => {});

  return new NextResponse(null, { status: 204 });
}
