/**
 * Dev-server launcher that raises Node's HTTP header limit before starting
 * `ng serve`.
 *
 * Why: proxying D365 through the dev server can leave large affinity/session
 * cookies stored against localhost, which then ride along on every request.
 * Once they exceed Node's default 16 KB header limit the Vite dev server
 * rejects the request with HTTP 431. The proxy now strips those cookies
 * (see proxy.conf.js), but this raises the ceiling too so an already-loaded
 * browser session keeps working without having to clear cookies first.
 */
const { spawnSync } = require('child_process');

const HEADER_OPT = '--max-http-header-size=65536';
const NODE_OPTIONS = [process.env.NODE_OPTIONS, HEADER_OPT].filter(Boolean).join(' ');

const result = spawnSync('ng', ['serve', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: true, // resolves the `ng` bin from node_modules/.bin on Windows too
  env: { ...process.env, NODE_OPTIONS },
});

process.exit(result.status ?? 0);
