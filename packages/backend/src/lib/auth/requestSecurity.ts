// Decide whether to set the `Secure` flag on cookies issued for a given
// request. ServiceBay is commonly self-hosted on a plain-HTTP LAN address
// (e.g. http://192.168.x.x:5888) — `secure: NODE_ENV === 'production'` is
// wrong there, because the browser will refuse to *store* the cookie when
// it arrives over a non-HTTPS connection (RFC 6265bis §5.4). The result is
// a silent login failure: the server thinks it set a session, the browser
// drops it, and the next request is unauthenticated.
//
// Detect the actual scheme of the inbound request instead. Honour
// `X-Forwarded-Proto` first so installs behind a TLS-terminating reverse
// proxy (Nginx Proxy Manager, Caddy, …) still get Secure cookies.
export function isRequestSecure(request: Request): boolean {
  const xf = request.headers.get('x-forwarded-proto');
  if (xf) {
    return xf.split(',')[0]!.trim().toLowerCase() === 'https';
  }
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return false;
  }
}
