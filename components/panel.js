import { comboCd } from '../lib/combo-cd.js';
import { comboEf } from '../lib/combo-ef.js';

export default function Panel() {
  return <p>{comboCd('panel') + comboEf('panel')}</p>;
}
