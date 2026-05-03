'use client';

import dynamic from 'next/dynamic';

// Disable SSR to prevent hydration mismatch from Date.now() / toLocaleTimeString()
const Terminal = dynamic(() => import('@/components/Terminal'), { ssr: false });

export default function Home() {
  return <Terminal />;
}
