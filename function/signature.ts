// GitHub signs each delivery's raw body bytes with HMAC-SHA256 under the webhook secret and sends
// `sha256=<hex>` in `X-Hub-Signature-256`.

const encoder = new TextEncoder();

function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

export async function sign(secret: string, body: Uint8Array<ArrayBuffer>): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), body);
  return `sha256=${Buffer.from(mac).toString('hex')}`;
}

/** True only for a well-formed `sha256=<64 hex>` header that matches; compared in constant time. */
export async function verify(
  secret: string,
  body: Uint8Array<ArrayBuffer>,
  header: string | undefined,
): Promise<boolean> {
  const hex = /^sha256=([0-9a-f]{64})$/.exec(header ?? '')?.[1];
  if (!hex) return false;
  return crypto.subtle.verify(
    'HMAC',
    await hmacKey(secret, 'verify'),
    Buffer.from(hex, 'hex'),
    body,
  );
}
