"use client";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function getDocsBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_DOCS_URL;
  if (configured) return trimTrailingSlash(configured);

  if (typeof window !== "undefined" && window.location.hostname === "app.agenthifive.com") {
    return "https://docs.agenthifive.com";
  }

  return "/docs";
}

export function docsUrl(path = ""): string {
  const base = getDocsBaseUrl();
  if (!path) return `${base}/`;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}
