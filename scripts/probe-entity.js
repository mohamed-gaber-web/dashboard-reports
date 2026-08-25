#!/usr/bin/env node
/**
 * Ask a D365 tenant what it actually publishes.
 *
 * ## Why this exists
 *
 * Entity names and column names are NOT portable between F&O tenants, and a
 * wrong one is an opaque HTTP 400, not a useful error — the same trap that
 * `CLAUDE.md` records for `enumType`. Wiring a new module by guessing the entity
 * therefore fails at the worst possible moment: at runtime, in front of a user,
 * with no indication of which of the twenty things in the query was wrong.
 *
 * So a new source gets confirmed against the live tenant first. This is the
 * smallest thing that does it.
 *
 * ## Usage
 *
 *   node scripts/probe-entity.js --search trial          # which entity sets match "trial"?
 *   node scripts/probe-entity.js --search ledger --source shatat
 *   node scripts/probe-entity.js --entity GeneralJournalAccountEntries
 *
 * `--search` lists matching entity SETS from the service document.
 * `--entity` fetches ONE row and prints its column names and types, which is
 * what a `FieldMeta` list has to be written against.
 *
 * Reads the same git-ignored `.env` the dev API uses. No secret is printed, and
 * nothing is written — this only reads.
 */

const fs = require('fs');
const path = require('path');

// Same two source blocks as `src/environments/environment.ts`. Kept here rather
// than imported because that file is TypeScript and this is a plain node script.
const SOURCES = {
  growpath: {
    baseUrl: 'https://growpath.sandbox.operations.eu.dynamics.com',
    clientId: 'db61ee09-84a1-4912-b319-709480fa243a',
    secretEnv: 'AZURE_CLIENT_SECRET',
    tenantEnv: 'AZURE_TENANT_ID',
    tenantDefault: '26c58d65-b577-4f92-aed2-cec1395d146d',
    company: 'usmf',
    crossCompany: false,
  },
  shatat: {
    baseUrl: 'https://shatat-uat.sandbox.operations.dynamics.com',
    clientId: 'af9c6191-37aa-4bb4-a623-5e7f2c364c17',
    secretEnv: 'AZURE_CLIENT_SECRET_SHATAT',
    tenantEnv: 'AZURE_TENANT_ID_SHATAT',
    tenantDefault: 'be88f713-a964-488f-89ef-00a04bc0f789',
    company: '003',
    crossCompany: true,
  },
};

/** Minimal .env reader — no dependency, and it only has to handle KEY=value. */
function loadEnv() {
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line);
    if (!match) continue;
    const value = match[2].replace(/^["']|["']$/g, '');
    if (!(match[1] in process.env)) process.env[match[1]] = value;
  }
}

function args() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  }
  return out;
}

async function token(source) {
  const secret = process.env[source.secretEnv];
  if (!secret) {
    throw new Error(
      `${source.secretEnv} is not set. Put it in .env (see .env.example) — it is never read from source.`,
    );
  }

  const tenant = process.env[source.tenantEnv] || source.tenantDefault;
  const response = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: source.clientId,
      client_secret: secret,
      scope: `${source.baseUrl}/.default`,
    }),
  });

  const body = await response.json();
  if (!response.ok) {
    // Azure's own description is the useful part; the secret is never echoed.
    throw new Error(`Token request failed (${response.status}): ${body.error_description || body.error}`);
  }
  return body.access_token;
}

async function get(source, accessToken, url) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}\n${text.slice(0, 600)}`);
  }
  return JSON.parse(text);
}

/** Which entity sets this tenant publishes whose name contains `term`. */
async function search(source, accessToken, term) {
  const doc = await get(source, accessToken, `${source.baseUrl}/data`);
  const needle = term.toLowerCase();
  const hits = (doc.value || [])
    .map((entry) => entry.name || entry.url)
    .filter((name) => typeof name === 'string' && name.toLowerCase().includes(needle))
    .sort();

  console.log(`\n${hits.length} entity set(s) matching “${term}” on ${source.baseUrl}:\n`);
  for (const name of hits) console.log(`  ${name}`);
  if (!hits.length) console.log('  (none — try a shorter term)');
  console.log('');
}

/** One row of an entity, reduced to its column names and inferred types. */
async function describe(source, accessToken, entity, company) {
  const params = new URLSearchParams({ $top: '1' });
  if (company) params.set('$filter', `dataAreaId eq '${company}'`);
  if (source.crossCompany) params.set('cross-company', 'true');

  const url = `${source.baseUrl}/data/${entity}?${params}`;
  console.log(`\nGET ${url}\n`);

  const body = await get(source, accessToken, url);
  const row = (body.value || [])[0];
  if (!row) {
    console.log('The entity exists but returned no row for that company.');
    console.log('Try another company with --company, or drop it to read across all of them.\n');
    return;
  }

  const rows = Object.keys(row)
    .filter((key) => !key.startsWith('@'))
    .sort()
    .map((key) => {
      const value = row[key];
      let type = value === null ? 'null' : typeof value;
      // The two shapes a FieldMeta has to get right, and the ones a bare
      // "string" would hide: a date, and D365's 1900 unset sentinel.
      if (type === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
        type = value.startsWith('1900-01-01') ? 'date (UNSET SENTINEL in this row)' : 'date';
      }
      return { column: key, type, sample: value === null ? '' : String(value).slice(0, 40) };
    });

  console.table(rows);
  console.log(`${rows.length} columns.\n`);
}

async function main() {
  loadEnv();
  const opts = args();
  const source = SOURCES[opts.source || 'shatat'];
  if (!source) {
    throw new Error(`Unknown --source “${opts.source}”. Use one of: ${Object.keys(SOURCES).join(', ')}`);
  }

  if (!opts.search && !opts.entity) {
    console.log(`Usage:
  node scripts/probe-entity.js --search <term>   [--source growpath|shatat]
  node scripts/probe-entity.js --entity <Entity> [--source growpath|shatat] [--company 003]`);
    return;
  }

  const accessToken = await token(source);
  if (opts.search) await search(source, accessToken, opts.search);
  if (opts.entity) {
    await describe(source, accessToken, opts.entity, opts.company || source.company);
  }
}

main().catch((err) => {
  console.error(`\n${err.message}\n`);
  process.exitCode = 1;
});
