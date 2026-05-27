// Geometric Banking + Insurance illustration for the LoginPage shell.
//
// Hand-drawn SVG — no external asset dependency. Renders an abstract
// risk-intelligence panel: stacked indicator bars, a radar polygon
// suggesting multi-axis scoring, and a thin pulse line meant to
// evoke a live alert feed. Uses currentColor + per-element opacity
// so the surrounding theme can tint without touching the markup.

import { useEffect, useState } from 'react';

interface Props {
  className?: string;
}

export function BankingIllustration({ className }: Props) {
  // Subtle on-mount stagger — keeps the illustration feeling alive
  // on the initial render without any external animation lib.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const id = window.requestAnimationFrame(() => setReady(true));
    return () => window.cancelAnimationFrame(id);
  }, []);

  return (
    <svg
      viewBox="0 0 480 320"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      role="presentation"
      className={className}
    >
      <defs>
        <linearGradient id="cardGlow" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#1A2F60" stopOpacity="0.7" />
          <stop offset="100%" stopColor="#0A1430" stopOpacity="0.95" />
        </linearGradient>
        <linearGradient id="orangeStroke" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#FF6B35" stopOpacity="0" />
          <stop offset="50%" stopColor="#FF6B35" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#FF6B35" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="barGrad" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor="#FF6B35" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#F0B344" stopOpacity="0.7" />
        </linearGradient>
        <pattern id="ews-dots" x="0" y="0" width="14" height="14" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.9" fill="#F5F1E8" opacity="0.25" />
        </pattern>
      </defs>

      {/* atmospheric frame */}
      <rect x="22" y="22" width="436" height="276" rx="14" fill="url(#ews-dots)" opacity="0.4" />
      <rect
        x="22"
        y="22"
        width="436"
        height="276"
        rx="14"
        fill="none"
        stroke="#FF6B35"
        strokeOpacity="0.18"
        strokeDasharray="2 6"
      />

      {/* Panel 1 — indicator bar chart (Banking) */}
      <g transform="translate(48 56)" opacity={ready ? 1 : 0} style={{ transition: 'opacity 600ms ease' }}>
        <rect width="180" height="160" rx="10" fill="url(#cardGlow)" stroke="#2A3A65" />
        <text x="14" y="22" fill="#F5F1E8" fontSize="9" fontFamily="JetBrains Mono, monospace" letterSpacing="1.6" opacity="0.7">
          PD · LIVE
        </text>
        <text x="14" y="44" fill="#FF6B35" fontSize="22" fontFamily="Fraunces, serif" fontWeight="600">
          412
        </text>
        <text x="14" y="58" fill="#F5F1E8" fontSize="8" fontFamily="Inter, system-ui" opacity="0.55">
          high-risk customers
        </text>

        {/* Bars */}
        {[36, 60, 28, 78, 52, 90, 44, 72, 96, 64].map((h, i) => (
          <rect
            key={i}
            x={14 + i * 16}
            y={150 - h}
            width="10"
            height={ready ? h : 0}
            rx="2"
            fill="url(#barGrad)"
            style={{
              transition: `height 700ms cubic-bezier(.22,1,.36,1) ${i * 60}ms`,
            }}
          />
        ))}
        <line x1="14" y1="151" x2="170" y2="151" stroke="#2A3A65" strokeWidth="0.8" />
      </g>

      {/* Panel 2 — risk radar (Insurance) */}
      <g transform="translate(254 56)" opacity={ready ? 1 : 0} style={{ transition: 'opacity 600ms ease 200ms' }}>
        <rect width="180" height="160" rx="10" fill="url(#cardGlow)" stroke="#2A3A65" />
        <text x="14" y="22" fill="#F5F1E8" fontSize="9" fontFamily="JetBrains Mono, monospace" letterSpacing="1.6" opacity="0.7">
          CLAIM · RADAR
        </text>

        {/* Radar grid */}
        <g transform="translate(90 95)" fill="none" stroke="#3A4B7E" strokeOpacity="0.55">
          {[16, 30, 46, 60].map((r) => (
            <polygon
              key={r}
              points={
                hexPoints(r).map((p) => `${p.x},${p.y}`).join(' ')
              }
            />
          ))}
          {/* Spokes */}
          {hexPoints(60).map((p) => (
            <line key={`s${p.x}${p.y}`} x1="0" y1="0" x2={p.x} y2={p.y} />
          ))}
        </g>

        {/* Filled risk polygon */}
        <g transform="translate(90 95)">
          <polygon
            points={hexPoints(54)
              .map((p, i) => {
                const factors = [0.85, 0.6, 0.92, 0.48, 0.78, 0.66];
                const k = factors[i % factors.length];
                return `${p.x * k},${p.y * k}`;
              })
              .join(' ')}
            fill="#FF6B35"
            fillOpacity={ready ? 0.22 : 0}
            stroke="#FF6B35"
            strokeWidth="1.5"
            style={{ transition: 'fill-opacity 600ms ease 400ms' }}
          />
          {/* Vertex dots */}
          {hexPoints(54).map((p, i) => {
            const factors = [0.85, 0.6, 0.92, 0.48, 0.78, 0.66];
            const k = factors[i % factors.length];
            return (
              <circle
                key={`v${i}`}
                cx={p.x * k}
                cy={p.y * k}
                r="2"
                fill="#FF6B35"
              />
            );
          })}
        </g>

        <text x="14" y="148" fill="#F5F1E8" fontSize="8" fontFamily="Inter, system-ui" opacity="0.6">
          6 axes · fraud + lapse + churn
        </text>
      </g>

      {/* Live alert pulse line */}
      <g transform="translate(48 244)" opacity={ready ? 1 : 0} style={{ transition: 'opacity 700ms ease 600ms' }}>
        <rect width="384" height="36" rx="8" fill="url(#cardGlow)" stroke="#2A3A65" />
        <circle cx="18" cy="18" r="4" fill="#FF6B35">
          <animate attributeName="r" values="3;5;3" dur="1.5s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="1;0.4;1" dur="1.5s" repeatCount="indefinite" />
        </circle>
        <text x="32" y="22" fill="#F5F1E8" fontSize="9" fontFamily="JetBrains Mono, monospace" letterSpacing="1.4">
          LIVE · alert.created · CUST-04812 · severity=red
        </text>
        <path
          d="M260 22 Q272 6 284 22 T308 22 T332 22 T356 22 T376 22"
          fill="none"
          stroke="url(#orangeStroke)"
          strokeWidth="1.5"
        />
      </g>
    </svg>
  );
}

// Hexagonal vertex helper for the radar grid (6 evenly-spaced spokes).
function hexPoints(r: number) {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    out.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return out;
}
