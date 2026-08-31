import { useState } from 'react';
import { heavyValue } from '../lib/heavy.js';

export default function DynB() {
  const [value, setValue] = useState(heavyValue('static'));
  return (
    <main>
      <button
        onClick={() => {
          import('../lib/heavy.js').then((mod) => setValue(mod.heavyValue('dyn-b')));
        }}
      >
        load
      </button>
      <p id="result">{value}</p>
    </main>
  );
}
