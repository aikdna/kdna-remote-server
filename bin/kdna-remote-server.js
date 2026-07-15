#!/usr/bin/env node
/**
 * kdna-remote-server — CLI entry (Story 18)
 *
 * Self-hostable HTTP projection server. See README.md for
 * self-hosting instructions (run on any Node 18+ machine).
 *
 * Usage:
 *   kdna-remote-server --asset <path-to-.kdna> [--port 3000]
 *                      [--activation-server <url>]
 *                      [--audit-log <path>]
 *                      [--dry-run]
 *
 * Self-hosting is the default. The activation server URL is
 * deployer-controlled. No KDNA Inc. URL is hardcoded.
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { loadAuthorized } = require('@aikdna/kdna-core');
const { startServer, stopServer } = require('../src/server');
const pkg = require('../package.json');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const eq = key.indexOf('=');
      if (eq >= 0) {
        out[key.slice(0, eq)] = key.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        out[key] = argv[i + 1];
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

function help() {
  return `kdna-remote-server ${pkg.version} — self-hostable projection server

Usage:
  kdna-remote-server --asset <path-to-.kdna> [options]

Required:
  --asset <path>          Path to a .kdna asset (or source dir) the
                          server will hold locally. The server
                          NEVER fetches assets from the network.

Options:
  --port <n>              Port to listen on. Default 3000.
                          Use 0 for an OS-assigned port (tests).
  --host <addr>           Host to bind. Default 127.0.0.1.
  --activation-server <url>
                          URL of the activation server (see
                          @aikdna/kdna-activation-server). The
                          projection server calls the sync
                          endpoint on every request. Self-hosted;
                          no default URL is hardcoded.
  --dry-run               Skip entitlement verification. For
                          local development without a real
                          activation server.
  --audit-log <path>      Append audit events to this file.
                          Default ~/.kdna/remote-server-audit.jsonl.
  --rate-limit-ms <n>     Minimum gap between requests from the
                          same client. Default 100ms.
  --help                  Print this help.

Self-hosting (default):
  Run this on any Node 18+ server. Point --activation-server at
  your own activation server (also self-hostable). The protocol
  does NOT depend on any KDNA Inc. endpoint.

See README.md for the full deployment guide.
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    process.stdout.write(help());
    return;
  }

  const assetPath = args.asset;
  if (!assetPath) {
    process.stderr.write('Error: --asset <path> is required\n\n');
    process.stderr.write(help());
    process.exit(1);
  }
  if (!fs.existsSync(assetPath)) {
    process.stderr.write(`Error: --asset path not found: ${assetPath}\n`);
    process.exit(1);
  }

  // Load the asset ONCE at startup. The server never fetches
  // assets at request time.
  let asset;
  try {
    asset = loadAuthorized(path.resolve(assetPath), { profile: 'compact', as: 'json' });
  } catch (e) {
    process.stderr.write(`Error: failed to load asset: ${e.message}\n`);
    process.exit(1);
  }

  const port = args.port ? parseInt(args.port, 10) : 3000;
  const host = args.host || '127.0.0.1';
  const dryRun = Boolean(args['dry-run']);
  const activationUrl = args['activation-server'] || null;
  const auditLog = args['audit-log'] || null;
  const rateLimitMs = args['rate-limit-ms'] ? parseInt(args['rate-limit-ms'], 10) : 100;

  if (port === 3000 && !args.port) {
    // Default port; fall through.
  } else if (isNaN(port)) {
    process.stderr.write(`Error: invalid port: ${args.port}\n`);
    process.exit(1);
  }

  const { server, port: actualPort } = await startServer({
    asset,
    activationUrl,
    dryRun,
    auditLog,
    rateLimitMs,
    port,
    host,
  });

  process.stdout.write(
    `kdna-remote-server ${pkg.version} listening on http://${host}:${actualPort}\n` +
      `  asset:        ${asset.asset_id}@${asset.version || '?'} (${asset.title || 'untitled'})\n` +
      `  dry_run:      ${dryRun}\n` +
      `  activation:   ${activationUrl || '(none — dry-run mode)'}\n` +
      `  audit_log:    ${auditLog || '~/.kdna/remote-server-audit.jsonl'}\n` +
      `\n` +
      `Try:  curl http://${host}:${actualPort}/healthz\n` +
      `  curl -X POST http://${host}:${actualPort}/project -H 'Content-Type: application/json' -d '{"kdna_id":"${asset.asset_id}","task":"review"}\n`,
  );

  const shutdown = (signal) => {
    process.stdout.write(`\nReceived ${signal}, shutting down...\n`);
    stopServer(server).then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  process.stderr.write(`Error: ${e.message}\n`);
  process.exit(1);
});
