import { cValue } from './c.js';
import { dValue } from './d.js';

export function comboCd(x) {
  return dValue(cValue(x));
}
