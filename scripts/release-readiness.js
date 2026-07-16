#!/usr/bin/env node
'use strict';

const path = require('node:path');
const {
  assertRegistryReleaseReady,
  verifyInstalledAikdnaGraph,
} = require('./runtime-candidate-binding');

const root = path.resolve(__dirname, '..');
verifyInstalledAikdnaGraph(root);
assertRegistryReleaseReady(root);
console.log('Release dependency closure verified against the canonical registry artifact.');
