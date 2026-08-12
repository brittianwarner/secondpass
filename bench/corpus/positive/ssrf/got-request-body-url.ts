// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: ssrf
// A thumbnailing endpoint downloads whatever image URL the client
// supplies — a classic path to internal port scanning and cloud
// metadata exfiltration via a crafted imageUrl.

import got from "../fixtures/got.js";

interface ThumbnailBody {
  imageUrl: string;
}

export async function thumbnailHandler(body: ThumbnailBody): Promise<Buffer> {
  const response = await got(body.imageUrl, { responseType: "buffer" });
  return response.body as Buffer;
}
