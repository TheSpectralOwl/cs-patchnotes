import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";

const startFetch = createStartHandler(defaultStreamHandler);

export default {
  async fetch(request: Request, env: { API_URL?: string }) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const apiUrl = env.API_URL;
      if (!apiUrl) return new Response("Archive API is not configured", { status: 503 });
      return fetch(`${apiUrl}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: "manual",
      });
    }
    return startFetch(request);
  },
};
