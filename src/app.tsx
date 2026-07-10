import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { GameShell } from './ui/GameShell';
import './style.css';

declare global {
  interface Window {
    __thresholdRuntimeStarted?: boolean;
  }
}

function ThresholdApp() {
  useEffect(() => {
    if (window.__thresholdRuntimeStarted) return;
    window.__thresholdRuntimeStarted = true;
    void import('./main.js').catch((error: unknown) => {
      console.error(error);
      document.querySelector('#unsupported')?.classList.add('is-visible');
    });
  }, []);

  return <GameShell />;
}

const rootElement = document.querySelector<HTMLDivElement>('#root');
if (!rootElement) throw new Error('THRESHOLD requires a #root mount element.');

createRoot(rootElement).render(<ThresholdApp />);
