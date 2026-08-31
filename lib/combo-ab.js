import { aValue } from './a.js';
import { bValue } from './b.js';

export function comboAb(x) {
  return bValue(aValue(x));
}
