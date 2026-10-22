import { test } from 'node:test';
import assert from 'node:assert';
import { sortForDrawer } from '../js/state.js';

test('sortForDrawer exact order', () => {
  const routes = [
    { id: 'R4', status: 'Ready' },
    { id: 'R1', status: 'Excluded / deferred' },
    { id: 'R2', status: 'Pending review' },
    { id: 'R3', status: 'Needs revision' },
    { id: 'R5', status: 'Approved exception' },
  ];
  const sorted = sortForDrawer(routes);
  assert.deepStrictEqual(sorted.map(r => r.status), ['Needs revision', 'Pending review', 'Approved exception', 'Ready', 'Excluded / deferred']);
});
