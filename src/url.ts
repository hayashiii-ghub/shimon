export function publicTargetUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return url.protocol;
  }

  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}
