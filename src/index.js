/**
 * index.js — public API for @aikdna/kdna-remote-server (Story 18)
 *
 * Exports the server, projection, entitlement, and audit
 * modules so that:
 *   - the `kdna-remote-server` CLI binary can boot the server
 *   - integration tests can spin up an in-process server
 *   - embedders can compose the projection layer into a
 *     different transport
 */

'use strict';

const { loadAuthorized } = require('@aikdna/kdna-core');

const server = require('./server');
const projection = require('./projection');
const entitlement = require('./entitlement');
const audit = require('./audit');

module.exports = {
  // Server
  startServer: server.startServer,
  stopServer: server.stopServer,
  makeRequestHandler: server.makeRequestHandler,
  // Projection
  selectProjection: projection.selectProjection,
  // Entitlement
  verifyEntitlement: entitlement.verifyEntitlement,
  // Audit
  appendAudit: audit.appendAudit,
  // Loader convenience: load a .kdna asset via the same
  // primitive the CLI uses. Embedders get a ready-to-serve
  // asset object.
  loadAsset: (assetPath) => loadAuthorized(assetPath, { profile: 'compact', as: 'json' }),
};
