import { ShieldCheck, Sparkles, Activity, Brain } from 'lucide-react';

/**
 * AuroraIntelPanel — the premium AI-native left panel for the login
 * experience (P0 redesign). Pure CSS/SVG (no runtime dep):
 *   • soft indigo→teal gradient-mesh canvas with drifting blobs
 *   • an animated "intelligence" network graph (edges draw in, nodes pulse)
 *   • rising glowing particles
 *   • an AI-first headline + three capability chips
 *
 * Renders only on lg+ (the LoginPage hides it below that), so it never
 * affects the jsdom login tests.
 */

// Deterministic node layout for the network graph (viewBox 0..400 × 0..520).
const NODES = [
  { x: 70, y: 90 }, { x: 160, y: 60 }, { x: 250, y: 110 }, { x: 330, y: 70 },
  { x: 110, y: 200 }, { x: 210, y: 240 }, { x: 300, y: 200 }, { x: 360, y: 280 },
  { x: 60, y: 320 }, { x: 170, y: 360 }, { x: 260, y: 330 }, { x: 330, y: 410 },
  { x: 120, y: 450 }, { x: 230, y: 460 },
];
const EDGES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [0, 4], [1, 5], [2, 6], [3, 7],
  [4, 5], [5, 6], [6, 7], [4, 8], [5, 9], [6, 10], [7, 11],
  [8, 9], [9, 10], [10, 11], [9, 12], [10, 13], [12, 13],
];
const PARTICLES = Array.from({ length: 14 }, (_, i) => ({
  left: `${(i * 67) % 100}%`,
  dur: `${7 + (i % 5) * 1.6}s`,
  delay: `${(i % 7) * 0.9}s`,
  size: i % 3 === 0 ? 5 : 3,
}));

export function AuroraIntelPanel() {
  return (
    <div className="relative h-full w-full overflow-hidden aurora-canvas">
      {/* Drifting gradient-mesh blobs */}
      <div
        className="aurora-blob-1 absolute -left-24 -top-24 h-[28rem] w-[28rem] rounded-full blur-3xl"
        style={{ background: 'radial-gradient(circle, rgba(99,102,241,0.45), transparent 65%)' }}
      />
      <div
        className="aurora-blob-2 absolute -right-20 top-1/3 h-[24rem] w-[24rem] rounded-full blur-3xl"
        style={{ background: 'radial-gradient(circle, rgba(14,165,164,0.38), transparent 65%)' }}
      />
      <div
        className="aurora-blob-1 absolute bottom-[-6rem] left-1/4 h-[22rem] w-[22rem] rounded-full blur-3xl"
        style={{ background: 'radial-gradient(circle, rgba(124,58,237,0.35), transparent 65%)' }}
      />

      {/* Animated intelligence network */}
      <svg
        className="absolute inset-0 h-full w-full opacity-70"
        viewBox="0 0 400 520"
        preserveAspectRatio="xMidYMid slice"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="edgeGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#6366F1" />
            <stop offset="100%" stopColor="#0EA5A4" />
          </linearGradient>
        </defs>
        {EDGES.map(([a, b], i) => (
          <line
            key={i}
            className="aurora-edge"
            x1={NODES[a].x} y1={NODES[a].y}
            x2={NODES[b].x} y2={NODES[b].y}
            stroke="url(#edgeGrad)"
            strokeWidth={1.2}
            style={{ animationDelay: `${(i % 8) * 0.18}s` }}
          />
        ))}
        {NODES.map((n, i) => (
          <circle
            key={i}
            className="aurora-node"
            cx={n.x} cy={n.y} r={3.5}
            fill={i % 3 === 0 ? '#7C3AED' : i % 3 === 1 ? '#6366F1' : '#0EA5A4'}
            style={{ animationDelay: `${(i % 6) * 0.5}s` }}
          />
        ))}
      </svg>

      {/* Rising particles */}
      <div className="absolute inset-0 pointer-events-none">
        {PARTICLES.map((p, i) => (
          <span
            key={i}
            className="aurora-particle absolute bottom-10 rounded-full"
            style={{
              left: p.left,
              width: p.size,
              height: p.size,
              background: 'rgba(124,58,237,0.65)',
              boxShadow: '0 0 8px rgba(99,102,241,0.8)',
              ['--p-dur' as string]: p.dur,
              ['--p-delay' as string]: p.delay,
            }}
          />
        ))}
      </div>

      {/* Foreground copy */}
      <div className="relative z-10 flex h-full flex-col justify-between p-12">
        <div className="flex items-center gap-3">
          <div className="relative flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-aurora-indigo to-aurora-violet shadow-glow aurora-pulse">
            <ShieldCheck size={20} className="text-white" strokeWidth={2} />
          </div>
          <div>
            <p className="text-[15px] font-semibold text-aurora-ink tracking-tight">ZorEWS</p>
            <p className="text-[11px] text-aurora-ink-sub">Zor Early Warning System</p>
          </div>
        </div>

        <div className="max-w-md">
          <span className="aurora-chip mb-5">
            <Sparkles size={12} /> AI-native risk intelligence
          </span>
          <h1 className="font-display text-[2.6rem] leading-[1.08] font-semibold tracking-tight text-aurora-ink">
            See risk <span className="aurora-gradient-text">before</span> it surfaces.
          </h1>
          <p className="mt-4 text-[14px] leading-relaxed text-aurora-ink-sub">
            Predictive early-warning across banking &amp; insurance — NPA, fraud,
            claims anomaly, lapse &amp; solvency — with explainable AI on every signal.
          </p>

          <div className="mt-8 flex flex-wrap gap-2.5">
            {[
              { icon: Brain, label: 'Predictive scoring' },
              { icon: Activity, label: 'Live anomaly feed' },
              { icon: Sparkles, label: 'Explainable AI' },
            ].map(({ icon: Icon, label }) => (
              <span
                key={label}
                className="inline-flex items-center gap-1.5 rounded-full border border-aurora-line bg-white/60 px-3 py-1.5 text-[12px] font-medium text-aurora-ink-sub backdrop-blur"
              >
                <Icon size={13} className="text-aurora-indigo" /> {label}
              </span>
            ))}
          </div>
        </div>

        <p className="text-[11px] text-aurora-ink-sub/80">
          Trusted risk intelligence · RBI &amp; IRDAI-aligned · SOC-grade audit trail
        </p>
      </div>
    </div>
  );
}
