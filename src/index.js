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
const fs = require('node:fs');
const path = require('node:path');

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
  // container. The server receives one authorized full Runtime Capsule and
  // narrows it at the HTTP projection boundary; it never decodes
  // payload.kdnab itself.
  loadAsset: (assetPath) => {
    const resolved = path.resolve(assetPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile() || !resolved.endsWith('.kdna')) {
      const error = new Error('Remote runtime requires a packaged .kdna asset file. Source directories are authoring inputs only.');
      error.code = 'KDNA_ASSET_FILE_REQUIRED';
      throw error;
    }
    const capsule = loadAuthorized(resolved, { profile: 'full', as: 'json' });
    if (
      capsule?.type !== 'kdna.runtime-capsule' ||
      capsule.contract_version !== '0.1.0' ||
      capsule.profile !== 'full' ||
      !capsule.asset ||
      typeof capsule.asset.asset_id !== 'string' ||
      !capsule.context ||
      typeof capsule.context !== 'object'
    ) {
      const error = new Error('Core did not return the required full Runtime Capsule contract.');
      error.code = 'KDNA_RUNTIME_CAPSULE_REQUIRED';
      throw error;
    }
    return {
      capsule,
      context: capsule.context,
      asset_id: capsule.asset.asset_id,
      title: capsule.context.manifest?.title || null,
      version: capsule.asset.version,
      access: capsule.access,
    };
  },
};
