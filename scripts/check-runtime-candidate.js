#!/usr/bin/env node
'use strict';

const path = require('node:path');
const {
  verifyCandidateBinding,
  verifyInstalledAikdnaGraph,
} = require('./runtime-candidate-binding');

const root = path.resolve(__dirname, '..');
verifyCandidateBinding(root);
verifyInstalledAikdnaGraph(root);
console.log('Runtime candidate binding and installed graph verified.');
