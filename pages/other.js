import dynamic from 'next/dynamic';
import { comboCd } from '../lib/combo-cd.js';
import { comboGh } from '../lib/combo-gh.js';

const Panel = dynamic(() => import('../components/panel.js'));

export default function Other() {
  return (
    <main>
      <h1>{comboCd('other') + comboGh('other')}</h1>
      <Panel />
    </main>
  );
}
