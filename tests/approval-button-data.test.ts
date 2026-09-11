import assert from 'node:assert/strict';
import {
  buildApprovalButtonData,
  parseApprovalButtonData,
  type ApprovalDecision,
} from '../src/features/approval-utils.js';

for (const decision of ['allow-once', 'allow-always', 'deny'] satisfies ApprovalDecision[]) {
  const buttonData = buildApprovalButtonData('plugin:12345678-1234-1234-1234-123456789abc', decision);
  assert.equal(
    buttonData,
    `approve:v2:plugin:plugin%3A12345678-1234-1234-1234-123456789abc:${decision}`,
  );
  assert.deepEqual(parseApprovalButtonData(buttonData), {
    approvalId: 'plugin:12345678-1234-1234-1234-123456789abc',
    approvalKind: 'plugin',
    decision,
  });
}

assert.deepEqual(parseApprovalButtonData(buildApprovalButtonData('exec:abc123', 'allow-once')), {
  approvalId: 'exec:abc123',
  approvalKind: 'exec',
  decision: 'allow-once',
});

for (const buttonData of [
  'approve:plugin:abc123:allow-once',
  'approve:v2:plugin:plugin%3Aabc123:approved',
  'approve:v2:exec:plugin%3Aabc123:allow-once',
  'approve:v2:plugin:%E0%A4%A:allow-once',
]) {
  assert.equal(parseApprovalButtonData(buttonData), null);
}

console.log('approval button data tests passed');
