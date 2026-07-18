#!/usr/bin/env node
/**
 * Create a minimal current-format runtime fixture for tests.
 *
 * Uses kdna-core's buildChecksums to produce a valid runtime layout
 * with kdna.json + payload.kdnab + checksums.json. The asset
 * has a small judgment content suitable for projection tests.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('@aikdna/kdna-core');
const cbor = require('cbor-x');

const outDir = process.argv[2] || path.join(__dirname, 'asset-fixture');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

fs.writeFileSync(
  path.join(outDir, 'mimetype'),
  'application/vnd.kdna.asset',
);

const manifest = {
  format_version: '0.1.0',
  asset_id: 'kdna:test:remote-server-fixture',
  asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000099',
  asset_type: 'domain',
  title: 'Remote Server Test Asset',
  version: '1.0.0',
  judgment_version: '1.0.0',
  created_at: '2026-06-28T00:00:00.000Z',
  updated_at: '2026-06-28T00:00:00.000Z',
  creator: { name: 'Test Creator', id: 'test-creator' },
  compatibility: {
    min_loader_version: '0.20.0',
    profile: 'kdna.payload.judgment',
    profile_version: '0.1.0',
  },
  payload: { path: 'payload.kdnab', encoding: 'cbor', encrypted: false },
  access: 'public',
  description: 'Minimal test asset for kdna-remote-server tests.',
};

const payload = {
  profile: 'kdna.payload.judgment',
  profile_version: '0.1.0',
  core: {
    highest_question: 'What is the safest default action when judgment is uncertain?',
    axioms: [
      { id: 'ax1', one_sentence: 'Prefer reversible actions over irreversible ones.' },
      { id: 'ax2', one_sentence: 'Surface uncertainty to the operator, do not paper over it.' },
      { id: 'ax3', one_sentence: 'Prefer the smallest change that solves the problem.' },
      { id: 'ax4', one_sentence: 'Document the trade-off you are making.' },
      { id: 'ax5', one_sentence: 'When in doubt, ask before acting.' },
    ],
    boundaries: [
      { id: 'b1', scope: 'Never execute destructive operations without explicit consent.' },
      { id: 'b2', scope: 'Never make promises on the user\'s behalf without a recorded review.' },
      { id: 'b3', scope: 'Never expose internal reasoning to the operator verbatim.' },
    ],
    risk_model: {},
  },
  patterns: [
    {
      type: 'self_check',
      id: 'sc1',
      question: 'Did I distinguish between what the operator asked and what I should do?',
    },
    {
      type: 'self_check',
      id: 'sc2',
      question: 'Did I make any irreversible change?',
    },
    {
      type: 'self_check',
      id: 'sc3',
      question: 'Did I record the assumption I made?',
    },
  ],
  scenarios: [],
  cases: [],
  reasoning: {
    self_check: [
      'Did I distinguish between what the operator asked and what I should do?',
      'Did I make any irreversible change?',
      'Did I record the assumption I made?',
    ],
    failure_modes: [
      { mode: 'silent_execution', description: 'Acting without surfacing the decision to the operator.' },
      { mode: 'over_automation', description: 'Doing more than the operator asked.' },
    ],
  },
  evolution: { changelog: [], version_notes: [] },
};

fs.writeFileSync(path.join(outDir, 'kdna.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(outDir, 'payload.kdnab'), cbor.encode(payload));
fs.writeFileSync(
  path.join(outDir, 'checksums.json'),
  JSON.stringify(core.buildChecksums(outDir), null, 2) + '\n',
);

console.log(`Wrote fixture to ${outDir}`);
