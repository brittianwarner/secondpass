// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// POSITIVE: cors-wildcard
// The CORS middleware is configured to allow any origin — `origin: true`
// tells most CORS libraries to reflect whatever Origin the caller sent.

import { cors } from "../fixtures/cors-middleware.js";
import { app } from "../fixtures/app.js";

app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);
