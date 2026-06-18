import { ArrowLeft, MapPin, ChevronDown } from 'lucide-react';

interface NigeriaLiveScreenProps {
  onBack: () => void;
}

type Activity = 'very-busy' | 'busy' | 'moderate' | 'calm';

interface City {
  name: string;
  x: number;
  y: number;
  activity: Activity;
  events: number;
  lx: number;
  ly: number;
  anchor: 'start' | 'middle' | 'end';
  delay: number;
}

// Nigeria border path — coords mapped from geographic lon/lat to SVG space
// toX(lon) = 50 + (lon - 2.7) * 25,  toY(lat) = 380 - (lat - 4.0) * 26
const NIGERIA_PATH =
  'M 58,320 L 50,318 L 50,297 L 58,276 L 62,237 L 70,180 L 75,163 L 88,140 ' +
  'L 120,127 L 158,128 L 195,140 L 233,133 L 283,140 L 320,144 L 348,146 ' +
  'L 350,172 L 338,198 L 320,211 L 313,237 L 320,276 L 333,315 L 320,354 ' +
  'L 203,375 L 158,380 L 120,372 L 108,354 L 95,328 L 70,320 Z';

const CITIES: City[] = [
  { name: 'Lagos',       x: 68,  y: 315, activity: 'very-busy', events: 847, lx: 0,   ly: -11, anchor: 'middle', delay: 0 },
  { name: 'Ibadan',      x: 80,  y: 292, activity: 'busy',      events: 234, lx: -8,  ly: 0,   anchor: 'end',    delay: 0.4 },
  { name: 'Abuja',       x: 170, y: 247, activity: 'very-busy', events: 612, lx: 0,   ly: 15,  anchor: 'middle', delay: 0.8 },
  { name: 'Kano',        x: 195, y: 172, activity: 'calm',      events: 142, lx: 9,   ly: -4,  anchor: 'start',  delay: 1.2 },
  { name: 'P.Harcourt',  x: 158, y: 359, activity: 'busy',      events: 198, lx: 0,   ly: 14,  anchor: 'middle', delay: 0.2 },
  { name: 'Kaduna',      x: 168, y: 211, activity: 'calm',      events: 98,  lx: 9,   ly: 0,   anchor: 'start',  delay: 1.6 },
  { name: 'Enugu',       x: 170, y: 318, activity: 'calm',      events: 76,  lx: 9,   ly: 0,   anchor: 'start',  delay: 0.6 },
  { name: 'Sokoto',      x: 114, y: 144, activity: 'calm',      events: 34,  lx: 9,   ly: 0,   anchor: 'start',  delay: 1.0 },
  { name: 'Maiduguri',   x: 310, y: 177, activity: 'moderate',  events: 67,  lx: -9,  ly: -9,  anchor: 'end',    delay: 1.4 },
  { name: 'Jos',         x: 205, y: 227, activity: 'calm',      events: 89,  lx: 9,   ly: -4,  anchor: 'start',  delay: 1.8 },
  { name: 'Calabar',     x: 190, y: 357, activity: 'calm',      events: 45,  lx: 9,   ly: 0,   anchor: 'start',  delay: 0.3 },
  { name: 'Ilorin',      x: 96,  y: 263, activity: 'calm',      events: 62,  lx: 9,   ly: 0,   anchor: 'start',  delay: 0.7 },
  { name: 'Yola',        x: 295, y: 245, activity: 'calm',      events: 28,  lx: -9,  ly: 0,   anchor: 'end',    delay: 1.1 },
  { name: 'Benin City',  x: 122, y: 319, activity: 'calm',      events: 54,  lx: 9,   ly: 13,  anchor: 'start',  delay: 0.9 },
  { name: 'Warri',       x: 125, y: 341, activity: 'calm',      events: 32,  lx: 9,   ly: 0,   anchor: 'start',  delay: 0.5 },
  { name: 'Owerri',      x: 155, y: 343, activity: 'calm',      events: 28,  lx: 9,   ly: 0,   anchor: 'start',  delay: 1.3 },
];

const ACTIVITY_CFG: Record<Activity, { color: string; r: number; pulseR: number; shadow: string }> = {
  'very-busy': { color: '#FF3B30', r: 6,   pulseR: 13, shadow: 'rgba(255,59,48,0.7)' },
  'busy':      { color: '#FF9F0A', r: 5,   pulseR: 11, shadow: 'rgba(255,159,10,0.6)' },
  'moderate':  { color: '#FFD60A', r: 5,   pulseR: 11, shadow: 'rgba(255,214,10,0.6)' },
  'calm':      { color: '#30D158', r: 3.5, pulseR: 8,  shadow: 'rgba(48,209,88,0.5)' },
};

const LEGEND = [
  { color: '#FF3B30', label: 'Very Busy' },
  { color: '#FF9F0A', label: 'Busy' },
  { color: '#FFD60A', label: 'Moderate' },
  { color: '#30D158', label: 'Calm' },
];

export function NigeriaLiveScreen({ onBack }: NigeriaLiveScreenProps) {
  const totalEvents = CITIES.reduce((s, c) => s + c.events, 0);

  return (
    <div
      style={{
        background: '#06090D',
        width: '100%',
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <style>{`
        @keyframes mapPulse {
          0%   { opacity: 0.7; r: var(--r1); }
          50%  { opacity: 0;   r: var(--r2); }
          100% { opacity: 0.7; r: var(--r1); }
        }
        @keyframes ringExpand {
          0%   { opacity: 0.6; transform: scale(1); }
          100% { opacity: 0;   transform: scale(2.4); }
        }
        @keyframes liveDot {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.3; }
        }
        @keyframes countUp {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      {/* Background ambient glow */}
      <div
        style={{
          position: 'absolute',
          width: '500px',
          height: '500px',
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(0,200,80,0.04) 0%, transparent 70%)',
          top: '100px',
          left: '-60px',
          pointerEvents: 'none',
        }}
      />

      {/* SVG Map */}
      <svg
        width="390"
        height="500"
        viewBox="0 0 390 500"
        style={{ position: 'absolute', top: 70, left: 0 }}
      >
        <defs>
          <filter id="nlGlow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="nlDotGlow" x="-120%" y="-120%" width="340%" height="340%">
            <feGaussianBlur stdDeviation="3.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <radialGradient id="nlMapBg" cx="55%" cy="50%" r="45%">
            <stop offset="0%" stopColor="rgba(0,40,20,0.9)" />
            <stop offset="100%" stopColor="rgba(0,15,8,0.95)" />
          </radialGradient>
        </defs>

        {/* Map fill */}
        <path d={NIGERIA_PATH} fill="url(#nlMapBg)" stroke="none" />

        {/* Border glow (thick outer) */}
        <path
          d={NIGERIA_PATH}
          fill="none"
          stroke="rgba(0,255,100,0.18)"
          strokeWidth={10}
          filter="url(#nlGlow)"
        />

        {/* Border sharp (inner line) */}
        <path
          d={NIGERIA_PATH}
          fill="none"
          stroke="#00FF6A"
          strokeWidth={1.5}
          opacity={0.85}
        />

        {/* City dots */}
        {CITIES.map((city) => {
          const cfg = ACTIVITY_CFG[city.activity];
          return (
            <g key={city.name}>
              {/* Pulse ring — animated via CSS class */}
              <circle
                cx={city.x}
                cy={city.y}
                r={cfg.pulseR}
                fill={cfg.color}
                opacity={0}
                style={{
                  transformOrigin: `${city.x}px ${city.y}px`,
                  animation: `ringExpand 2s ease-out ${city.delay}s infinite`,
                }}
              />
              {/* Glow dot */}
              <circle
                cx={city.x}
                cy={city.y}
                r={cfg.r + 2}
                fill={cfg.shadow}
                filter="url(#nlDotGlow)"
              />
              {/* Main dot */}
              <circle cx={city.x} cy={city.y} r={cfg.r} fill={cfg.color} />
              {/* Bright center */}
              <circle cx={city.x} cy={city.y} r={cfg.r * 0.42} fill="#fff" opacity={0.7} />

              {/* Label */}
              <text
                x={city.x + city.lx}
                y={city.y + city.ly}
                fill="rgba(255,255,255,0.88)"
                fontSize={9}
                fontFamily="Inter, sans-serif"
                fontWeight={city.activity === 'very-busy' ? 700 : 500}
                textAnchor={city.anchor}
              >
                {city.name}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Top bar */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          padding: 'calc(16px + env(safe-area-inset-top)) 20px 16px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          zIndex: 20,
        }}
      >
        <button
          onClick={onBack}
          style={{
            background: 'rgba(0,0,0,0.45)',
            backdropFilter: 'blur(10px)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '50%',
            width: '38px',
            height: '38px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          }}
        >
          <ArrowLeft size={16} color="#fff" />
        </button>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            background: 'rgba(0,0,0,0.5)',
            backdropFilter: 'blur(12px)',
            border: '1px solid rgba(0,255,106,0.25)',
            borderRadius: '20px',
            padding: '7px 14px',
          }}
        >
          <MapPin size={13} color="#00FF6A" />
          <span style={{ color: '#fff', fontSize: '14px', fontWeight: 600 }}>Nigeria</span>
          <ChevronDown size={12} color="#8B8FA8" />
        </div>

      </div>

      {/* "Nigeria is Alive" — left overlay text */}
      <div
        style={{
          position: 'absolute',
          top: 100,
          left: 0,
          width: '155px',
          padding: '0 16px',
          zIndex: 10,
        }}
      >
        <h1
          style={{
            color: '#fff',
            fontSize: '40px',
            fontWeight: 900,
            fontFamily: 'Space Grotesk, sans-serif',
            lineHeight: 1.0,
            marginBottom: '10px',
          }}
        >
          Nigeria
          <br />is
          <br />
          <span style={{ color: '#00FF6A' }}>Alive</span>
        </h1>
        <p
          style={{
            color: 'rgba(255,255,255,0.48)',
            fontSize: '11px',
            lineHeight: 1.55,
          }}
        >
          Discover events happening in every state right now.
        </p>
      </div>

      {/* Bottom gradient + stats */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          padding: '0 20px 44px',
          background: 'linear-gradient(to top, rgba(6,9,13,1) 55%, rgba(6,9,13,0.7) 80%, transparent)',
          zIndex: 15,
          paddingTop: '40px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          {/* Stats */}
          <div style={{ animation: 'countUp 0.6s ease both' }}>
            <p
              style={{
                color: '#00FF6A',
                fontSize: '44px',
                fontWeight: 900,
                fontFamily: 'Space Grotesk, sans-serif',
                lineHeight: 1,
                marginBottom: '4px',
                textShadow: '0 0 20px rgba(0,255,106,0.4)',
              }}
            >
              {totalEvents.toLocaleString()}
            </p>
            <p style={{ color: 'rgba(255,255,255,0.45)', fontSize: '12px', marginBottom: '12px' }}>
              Events happening across Nigeria
            </p>
            {/* Live badge */}
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '7px',
                background: 'rgba(0,255,106,0.1)',
                border: '1px solid rgba(0,255,106,0.35)',
                borderRadius: '20px',
                padding: '6px 14px',
              }}
            >
              <span
                style={{
                  width: '7px',
                  height: '7px',
                  borderRadius: '50%',
                  background: '#00FF6A',
                  display: 'inline-block',
                  boxShadow: '0 0 6px #00FF6A',
                  animation: 'liveDot 1.4s ease-in-out infinite',
                }}
              />
              <span style={{ color: '#00FF6A', fontSize: '12px', fontWeight: 700 }}>Live</span>
            </div>
          </div>

          {/* Legend */}
          <div
            style={{
              background: 'rgba(6,9,13,0.75)',
              backdropFilter: 'blur(10px)',
              border: '1px solid rgba(255,255,255,0.07)',
              borderRadius: '14px',
              padding: '12px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: '7px',
            }}
          >
            {LEGEND.map(({ color, label }) => (
              <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span
                  style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    background: color,
                    flexShrink: 0,
                    boxShadow: `0 0 5px ${color}`,
                  }}
                />
                <span style={{ color: 'rgba(255,255,255,0.65)', fontSize: '11px' }}>{label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
