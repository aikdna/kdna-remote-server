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
  // Loader convenience: Core remains the only component that reads the
  // container. The server receives two authorized Capsules and builds a
  // projection-safe view; it never decodes payload.kdnab itself.
  loadAsset: (assetPath) => {
    const compact = loadAuthorized(assetPath, { profile: 'compact', as: 'json' });
    const index = loadAuthorized(assetPath, { profile: 'index', as: 'json' });
    return {
      capsule: compact,
      context: compact.context,
      asset_id: index.context.asset_id || compact.domain || null,
      title: index.context.title || null,
      version: index.context.version || null,
      access: compact.access || 'remote',
    };
  },
};
