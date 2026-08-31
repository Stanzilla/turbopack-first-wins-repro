import Link from 'next/link';
import { bValue } from '../lib/b.js';
import { comboBc } from '../lib/combo-bc.js';

export default function Four() {
  return (
    <main>
      <h1>{bValue('four') + comboBc('four')}</h1>
      <Link href="/">go to index</Link>
    </main>
  );
}
