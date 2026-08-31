import { gValue } from './g.js';
import { hValue } from './h.js';

export function comboGh(x) {
  return hValue(gValue(x));
}
