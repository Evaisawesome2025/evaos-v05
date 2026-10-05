// Preserve the exact live 2026-10-05 Worker for every pre-existing route.
// Source main does not contain its BOUNDARY routes. See RELEASE.md.
import deployed from '../preserved/deployed-514bf8c7.js';
import { handleBrief } from './brief.js';
export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname === '/brief/validate') return handleBrief(request);
    return deployed.fetch(request, env, ctx);
  }
};
