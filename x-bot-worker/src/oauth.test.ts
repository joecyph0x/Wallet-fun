import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { authorizationHeader, hmacSha1Base64, oauthBaseString, percentEncode } from "./oauth.js";

test("percent-encoding follows RFC 3986", () => {
  assert.equal(percentEncode("a b*"), "a%20b%2A");
  assert.equal(percentEncode("!*'()"), "%21%2A%27%28%29");
  assert.equal(percentEncode("Ladies + Gentlemen"), "Ladies%20%2B%20Gentlemen");
  assert.equal(percentEncode("HMAC-SHA1"), "HMAC-SHA1");
});

test("the base string sorts oauth params and does not include the JSON body", () => {
  const params = {
    oauth_token: "tk",
    oauth_consumer_key: "ck",
    oauth_version: "1.0",
    oauth_timestamp: "1",
    oauth_nonce: "n",
    oauth_signature_method: "HMAC-SHA1",
  };
  assert.equal(
    oauthBaseString("post", "https://api.x.com/2/tweets", params),
    "POST&https%3A%2F%2Fapi.x.com%2F2%2Ftweets&oauth_consumer_key%3Dck%26oauth_nonce%3Dn%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1%26oauth_token%3Dtk%26oauth_version%3D1.0",
  );
});

test("HMAC-SHA1 matches node crypto and the header carries the encoded signature", async () => {
  const key = "secret&token-secret";
  const data = "POST&https%3A%2F%2Fapi.x.com%2F2%2Ftweets&oauth_nonce%3Dn";
  const expected = createHmac("sha1", key).update(data).digest("base64");
  assert.equal(await hmacSha1Base64(key, data), expected);

  const header = await authorizationHeader({
    consumerKey: "ck",
    consumerSecret: "cs",
    token: "tk",
    tokenSecret: "ts",
    nonce: "n",
    timestamp: "1",
  });
  assert.ok(header.startsWith("OAuth "));
  assert.ok(header.includes('oauth_consumer_key="ck"'));
  assert.ok(header.includes('oauth_signature_method="HMAC-SHA1"'));
  assert.ok(header.includes('oauth_token="tk"'));
  assert.equal(header.includes("text="), false);
  const match = header.match(/oauth_signature="([^"]+)"/);
  assert.ok(match);
  assert.equal(match[1]?.includes("+"), false);
  assert.equal(match[1]?.includes("="), false);
});
