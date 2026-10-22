/**
 * OAuth 1.0a HMAC-SHA1 for POST https://api.x.com/2/tweets.
 * The JSON body is not part of the signature. WebCrypto only, no SDK.
 */

const URL = "https://api.x.com/2/tweets";

export function percentEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

export function oauthBaseString(method: string, url: string, params: Readonly<Record<string, string>>): string {
  const pairs = Object.keys(params)
    .sort()
    .map((k) => percentEncode(k) + "=" + percentEncode(params[k] ?? ""));
  const param = pairs.join("&");
  return `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(param)}`;
}

export async function hmacSha1Base64(key: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data));
  return bytesToBase64(new Uint8Array(sig));
}

export async function authorizationHeader(opts: {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
  nonce: string;
  timestamp: string;
}): Promise<string> {
  const params: Record<string, string> = {
    oauth_consumer_key: opts.consumerKey,
    oauth_nonce: opts.nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: opts.timestamp,
    oauth_token: opts.token,
    oauth_version: "1.0",
  };
  const base = oauthBaseString("POST", URL, params);
  const key = percentEncode(opts.consumerSecret) + "&" + percentEncode(opts.tokenSecret);
  const signature = await hmacSha1Base64(key, base);
  const headerParams: Record<string, string> = { ...params, oauth_signature: signature };
  const order = [
    "oauth_consumer_key",
    "oauth_nonce",
    "oauth_signature",
    "oauth_signature_method",
    "oauth_timestamp",
    "oauth_token",
    "oauth_version",
  ];
  const bits = order.map((k) => `${percentEncode(k)}="${percentEncode(headerParams[k] ?? "")}"`);
  return "OAuth " + bits.join(", ");
}

export function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export const TWEET_URL = URL;
