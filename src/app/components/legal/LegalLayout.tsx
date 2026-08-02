import type { ReactNode } from 'react';

export interface LegalSection {
  id: string;
  title: string;
  body: ReactNode;
}

interface LegalLayoutProps {
  title: string;
  intro: string;
  lastUpdated: string;
  sections: LegalSection[];
  otherPages: { href: string; label: string }[];
}

// Shared shell for the standalone /privacy, /terms, /refunds pages. Scrolling
// is native document scroll (see html.legal-scroll in index.css, set before
// render in main.tsx) — this component only handles layout, not scroll
// mechanics, so there's nothing here to fight touch/mouse gestures.
export function LegalLayout({ title, intro, lastUpdated, sections, otherPages }: LegalLayoutProps) {
  return (
    <div
      style={{
        background: '#07030F',
        minHeight: '100dvh',
        color: '#C4C9E0',
        fontFamily: 'Inter, sans-serif',
      }}
    >
      <header
        style={{
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          background: 'rgba(7,3,15,0.85)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          position: 'sticky',
          top: 0,
          zIndex: 10,
        }}
      >
        <div
          style={{
            maxWidth: '920px',
            margin: '0 auto',
            padding: 'calc(14px + env(safe-area-inset-top)) 24px 14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <a href="/" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '9px',
                background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <span style={{ color: '#fff', fontWeight: 900, fontSize: '16px', fontFamily: 'Space Grotesk, sans-serif' }}>V</span>
            </div>
            <span style={{ color: '#F0F0FF', fontWeight: 800, fontSize: '17px', fontFamily: 'Space Grotesk, sans-serif' }}>Vents</span>
          </a>
          <a href="/" style={{ color: '#8B8FA8', fontSize: '13px', textDecoration: 'none' }}>← Back to app</a>
        </div>
      </header>

      <div
        style={{
          maxWidth: '920px',
          margin: '0 auto',
          padding: '48px 24px calc(100px + env(safe-area-inset-bottom))',
        }}
      >
        <div style={{ marginBottom: '48px', maxWidth: '640px' }}>
          <h1
            style={{
              color: '#F8F8FF',
              fontSize: 'clamp(28px, 5vw, 38px)',
              fontWeight: 800,
              fontFamily: 'Space Grotesk, sans-serif',
              margin: '0 0 10px',
              letterSpacing: '-0.02em',
            }}
          >
            {title}
          </h1>
          <p style={{ color: '#8B8FA8', fontSize: '13px', margin: '0 0 16px' }}>Last updated: {lastUpdated}</p>
          <p style={{ color: '#A9AEC7', fontSize: '15px', lineHeight: 1.7, margin: 0 }}>{intro}</p>
        </div>

        <div className="legal-grid">
          <nav className="legal-toc" aria-label="Sections">
            {sections.map((s) => (
              <a key={s.id} href={`#${s.id}`}>
                {s.title}
              </a>
            ))}
          </nav>

          <div>
            {sections.map((s) => (
              <section
                key={s.id}
                id={s.id}
                style={{
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px solid rgba(255,255,255,0.06)',
                  borderRadius: '16px',
                  padding: '24px',
                  marginBottom: '16px',
                  scrollMarginTop: '80px',
                }}
              >
                <h2
                  style={{
                    color: '#F0F0FF',
                    fontSize: '17px',
                    fontWeight: 700,
                    marginBottom: '12px',
                    fontFamily: 'Space Grotesk, sans-serif',
                  }}
                >
                  {s.title}
                </h2>
                <div style={{ fontSize: '14px', lineHeight: 1.8 }}>{s.body}</div>
              </section>
            ))}
          </div>
        </div>

        <div
          style={{
            marginTop: '32px',
            borderTop: '1px solid rgba(255,255,255,0.06)',
            paddingTop: '24px',
            display: 'flex',
            gap: '20px',
            flexWrap: 'wrap',
          }}
        >
          {otherPages.map((p) => (
            <a key={p.href} href={p.href} style={{ color: '#A78BFA', fontSize: '13px', textDecoration: 'none', fontWeight: 600 }}>
              {p.label}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

export function B({ children }: { children: ReactNode }) {
  return <b style={{ color: '#F0F0FF' }}>{children}</b>;
}

export function A({ href, children, external }: { href: string; children: ReactNode; external?: boolean }) {
  return (
    <a href={href} style={{ color: '#A78BFA' }} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
      {children}
    </a>
  );
}

export function Ul({ children }: { children: ReactNode }) {
  return <ul style={{ margin: '10px 0 0', paddingLeft: '20px' }}>{children}</ul>;
}

export function Li({ children }: { children: ReactNode }) {
  return <li style={{ marginBottom: '6px' }}>{children}</li>;
}
