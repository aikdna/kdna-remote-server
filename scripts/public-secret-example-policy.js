'use strict';

function fencedCodeBlocks(markdown) {
  const blocks = [];
  const pattern = /```[^\n]*\n([\s\S]*?)```/gu;
  let match;
  while ((match = pattern.exec(markdown)) !== null) blocks.push(match[1]);
  return blocks;
}

function unsafeSecretExamples(text) {
  const findings = [];
  for (const block of fencedCodeBlocks(text)) {
    if (
      /\bcurl\b[\s\S]{0,1200}(?:\s-d\b|\s--data(?!-binary\b)(?:-raw)?\b)/iu.test(
        block,
      )
    ) {
      findings.push('inline curl request body');
    }
  }
  return findings;
}

function unsafeRuntimeExamples(source) {
  return /\bcurl\b[^\n]{0,800}(?:\s-d\b|\s--data(?!-binary\b)(?:-raw)?\b)/iu.test(
    source,
  )
    ? ['runtime output contains an inline curl request body']
    : [];
}

module.exports = {
  fencedCodeBlocks,
  unsafeRuntimeExamples,
  unsafeSecretExamples,
};
