/**
 * Platform WAD loader (M1-08): fetches a WAD over HTTP with an optional
 * sha256 pin verified via crypto.subtle. Async by design — the plan pins
 * "fetch + optional sha256 verify via crypto.subtle, async — record
 * deviation" (M1-plan §M1-08): the ARCHITECTURE §2 contract has no WAD
 * loader yet, so this platform-zone helper is the deviation carrier.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

/** Loader failure kinds (404/network vs hash mismatch vs parse). */
export class WadLoadError extends Error {
  override name = 'WadLoadError';
}

/** Lowercase hex sha256 of a buffer via WebCrypto. */
export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Fetch `url` as an ArrayBuffer. Throws WadLoadError on a non-OK response
 * (HTTP 404 included — callers use it to show a fallback UI instead of a
 * console error) or network failure, and verifies `expectedSha256` when a
 * pin is supplied.
 */
export async function fetchWad(url: string, expectedSha256?: string): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new WadLoadError(`fetch '${url}' failed: ${String(err)}`);
  }
  if (!res.ok) {
    throw new WadLoadError(`fetch '${url}' -> HTTP ${res.status}`);
  }
  const buf = await res.arrayBuffer();
  if (expectedSha256 !== undefined) {
    const got = await sha256Hex(buf);
    if (got !== expectedSha256.toLowerCase()) {
      throw new WadLoadError(`sha256 mismatch for '${url}': got ${got}, expected ${expectedSha256}`);
    }
  }
  return buf;
}
