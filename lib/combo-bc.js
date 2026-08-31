import { bValue } from './b.js';
import { cValue } from './c.js';

export function comboBc(x) {
  return cValue(bValue(x));
}
