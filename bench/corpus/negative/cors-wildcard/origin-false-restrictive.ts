// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): cors-wildcard
// This service is never called cross-origin — CORS is explicitly
// disabled rather than opened up.

import { cors } from "../fixtures/cors-middleware.js";
import { app } from "../fixtures/app.js";

app.use(
  cors({
    origin: false,
  }),
);
