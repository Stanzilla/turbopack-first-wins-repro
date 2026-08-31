import dynamic from 'next/dynamic';
import { comboAb } from '../lib/combo-ab.js';
import { comboBc } from '../lib/combo-bc.js';

const Widget = dynamic(() => import('../components/widget.js'));

export default function Home() {
  return (
    <main>
      <h1>{comboAb('home') + comboBc('home')}</h1>
      <Widget />
    </main>
  );
}
