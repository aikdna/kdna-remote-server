'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  unsafeRuntimeExamples,
  unsafeSecretExamples,
} = require('../scripts/public-secret-example-policy');

test('public examples reject inline secret bodies and permit private stdin or files', () => {
  const field = ['license', '_key'].join('');
  const unsafe = [
    `\`\`\`bash\ncurl -d '{"${field}":"real-secret"}' https://example.invalid/project\n\`\`\``,
    `\`\`\`bash\ncurl --data-raw '{"${field}":"real-secret"}' https://example.invalid/project\n\`\`\``,
  ];
  for (const markdown of unsafe) {
    assert.deepEqual(unsafeSecretExamples(markdown), ['inline curl request body']);
  }

  const safe = [
    '```bash\ncurl --data-binary @./private-request.json https://example.invalid/project\n```',
    '```bash\nsecret-provider | curl --data-binary @- https://example.invalid/project\n```',
  ];
  for (const markdown of safe) assert.deepEqual(unsafeSecretExamples(markdown), []);

  assert.deepEqual(
    unsafeRuntimeExamples(
      "Try: curl -X POST http://127.0.0.1/project -d '{\"task\":\"review\"}'",
    ),
    ['runtime output contains an inline curl request body'],
  );
  assert.deepEqual(
    unsafeRuntimeExamples(
      'Send JSON with --data-binary @<private-request-file> or @-.',
    ),
    [],
  );
});
