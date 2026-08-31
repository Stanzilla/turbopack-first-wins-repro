import { eValue } from './e.js';
import { fValue } from './f.js';

export function comboEf(x) {
  return fValue(eValue(x));
}
