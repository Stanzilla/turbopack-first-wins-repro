import { useState } from 'react';

export default function DynA() {
  const [value, setValue] = useState('not loaded');
  return (
    <main>
      <button
        onClick={() => {
          import('../lib/heavy.js').then((mod) => setValue(mod.heavyValue('dyn-a')));
        }}
      >
        load
      </button>
      <p id="result">{value}</p>
    </main>
  );
}
