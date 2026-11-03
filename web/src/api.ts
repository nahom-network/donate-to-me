export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function api<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  headers.set("x-requested-with", "dashboard");
  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });

  if (!response.ok) {
    if (response.status === 401 && !path.includes("/session")) {
      // The allowlist can revoke a live cookie; send the browser back through
      // the session check so it renders the login screen.
      window.dispatchEvent(new Event("d2m:unauthorized"));
    }
    let message =
      response.status === 401
        ? "Your session expired. Sign in again."
        : `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      /* keep the status message */
    }
    throw new ApiError(response.status, message);
  }

  return (await response.json()) as T;
}
