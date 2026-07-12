const shimmerStyle: React.CSSProperties = {
  background: 'linear-gradient(90deg, #1a1d2e 25%, #252840 50%, #1a1d2e 75%)',
  backgroundSize: '800px 100%',
  animation: 'shimmer 1.4s infinite linear',
  borderRadius: '8px',
};

interface SkeletonCardProps {
  variant?: 'event' | 'ticket' | 'message' | 'feed' | 'row';
}

export function SkeletonCard({ variant = 'event' }: SkeletonCardProps) {
  if (variant === 'row') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 0' }}>
        <div style={{ width: '44px', height: '44px', borderRadius: '10px', flexShrink: 0, ...shimmerStyle }} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ height: '13px', width: '65%', ...shimmerStyle }} />
          <div style={{ height: '11px', width: '40%', ...shimmerStyle }} />
        </div>
      </div>
    );
  }

  if (variant === 'feed') {
    return (
      <div
        style={{
          width: '100%',
          background: '#090514',
          borderRadius: '28px',
          border: '1px solid rgba(255,255,255,0.07)',
          overflow: 'hidden',
        }}
      >
        <div style={{ aspectRatio: '3 / 4', ...shimmerStyle, borderRadius: 0 }} />
        <div style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ height: '16px', width: '75%', ...shimmerStyle }} />
          <div style={{ height: '12px', width: '50%', ...shimmerStyle }} />
          <div style={{ height: '12px', width: '35%', ...shimmerStyle }} />
        </div>
      </div>
    );
  }

  if (variant === 'ticket') {
    return (
      <div
        style={{
          background: '#090514',
          border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: '20px',
          overflow: 'hidden',
        }}
      >
        <div style={{ height: '100px', ...shimmerStyle, borderRadius: 0 }} />
        <div style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ height: '16px', width: '70%', ...shimmerStyle }} />
          <div style={{ height: '12px', width: '50%', ...shimmerStyle }} />
          <div style={{ height: '12px', width: '60%', ...shimmerStyle }} />
          <div style={{ height: '1px', background: 'rgba(255,255,255,0.06)' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <div style={{ height: '12px', width: '30%', ...shimmerStyle }} />
            <div style={{ height: '16px', width: '20%', ...shimmerStyle }} />
          </div>
        </div>
      </div>
    );
  }

  if (variant === 'message') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 16px' }}>
        <div style={{ width: '48px', height: '48px', borderRadius: '50%', flexShrink: 0, ...shimmerStyle }} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ height: '14px', width: '40%', ...shimmerStyle }} />
          <div style={{ height: '12px', width: '70%', ...shimmerStyle }} />
        </div>
        <div style={{ height: '11px', width: '30px', ...shimmerStyle }} />
      </div>
    );
  }

  // event (default)
  return (
    <div
      style={{
        background: '#090514',
        borderRadius: '20px',
        overflow: 'hidden',
        flexShrink: 0,
        width: '200px',
      }}
    >
      <div style={{ height: '120px', ...shimmerStyle, borderRadius: 0 }} />
      <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ height: '14px', width: '80%', ...shimmerStyle }} />
        <div style={{ height: '12px', width: '55%', ...shimmerStyle }} />
        <div style={{ height: '12px', width: '40%', ...shimmerStyle }} />
      </div>
    </div>
  );
}
