import { appVersionLabel } from '../../../lib/appVersion';

// Renders the standard "VENTS v1.1.0 | © VENTS LTD" footer line. The
// actual version/brand string lives in one place (src/lib/appVersion.ts)
// -- this component just applies it consistently wherever it's shown, so
// a future version bump never requires hunting down separate copies.
export function AppVersionFooter({ note }: { note?: string }) {
  return (
    <p style={{ textAlign: 'center', color: '#555C7A', fontSize: '11px', marginTop: '8px', paddingBottom: '4px' }}>
      {appVersionLabel()}{note ? ` · ${note}` : ''}
    </p>
  );
}
