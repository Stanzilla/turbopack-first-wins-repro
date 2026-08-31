import Link from 'next/link';

export default function Home() {
  return (
    <main>
      <h1>Turbopack first-wins reproduction</h1>
      <Link href="/dyn-a">dynamic import only</Link>
      <br />
      <Link href="/dyn-b">static and dynamic import</Link>
    </main>
  );
}
