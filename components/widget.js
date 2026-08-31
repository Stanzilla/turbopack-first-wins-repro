import { comboBc } from '../lib/combo-bc.js';
import { comboCd } from '../lib/combo-cd.js';
import { comboGh } from '../lib/combo-gh.js';

export default function Widget() {
  return <p>{comboBc('widget') + comboCd('widget') + comboGh('widget')}</p>;
}
