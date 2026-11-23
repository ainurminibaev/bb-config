import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inkAlpha, logoTone } from '../lib/logo-tone.ts';

const px = (...colors) => colors.flatMap(([r, g, b, a = 255]) => [r, g, b, a]);

test('a stroke logo of any colour is all ink, transparency stays', () => {
  for (const ink of [[0, 0, 0], [85, 85, 85], [11, 69, 127], [240, 240, 240]]) {
    assert.deepEqual([...inkAlpha(px(ink, ink, [0, 0, 0, 0]))], [255, 255, 0]);
  }
});

test('a plate logo keeps its plate and cuts its contrasting lines out', () => {
  const plate = [79, 70, 229];
  const alpha = inkAlpha(px(plate, plate, plate, [255, 255, 255], [255, 255, 255]));
  assert.deepEqual([...alpha], [255, 255, 255, 0, 0]);
});

test('an empty image has no mask', () => {
  assert.equal(logoTone(px([0, 0, 0, 0])), null);
  assert.equal(inkAlpha(px([0, 0, 0, 0])), null);
});
