import { describe, it, expect } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, Root } from 'react-dom/client';
import { PrivacyPolicyScreen } from './PrivacyPolicyScreen';

// Apple App Store rejection audit (Guideline 5.1.1, Oct 2026): the in-app
// Privacy Policy text disclosed account info, location, and payment data,
// but said nothing about camera/photo-library access (profile photos,
// event covers, service-provider verification docs, chat image
// attachments -- all real, gated behind a camera permission primer --
// see src/lib/pickImage.ts, src/app/components/scanner/useCamera.ts) or
// push notifications (src/lib/pushNotifications.ts). A permission
// explanation that doesn't match what the privacy policy itself discloses
// is a real accuracy gap -- this proves the policy text now covers both.

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<PrivacyPolicyScreen onBack={() => {}} />);
  });
}

describe('PrivacyPolicyScreen: data-collection disclosure matches real permission usage', () => {
  it('discloses camera/photo-library use (profile, event, verification, and chat photos)', () => {
    mount();
    expect(container!.textContent).toMatch(/camera or photo library/i);
    expect(container!.textContent).toMatch(/verification documents/i);
    root!.unmount();
    container!.remove();
  });

  it('discloses push notification use', () => {
    mount();
    expect(container!.textContent).toMatch(/push notifications/i);
    expect(container!.textContent).toMatch(/ticket confirmations, event reminders, and new messages/i);
    root!.unmount();
    container!.remove();
  });

  it('still discloses the pre-existing account/location/payment collection (not regressed by this edit)', () => {
    mount();
    expect(container!.textContent).toMatch(/name, email, and phone number/i);
    expect(container!.textContent).toMatch(/your location, only if you allow it/i);
    expect(container!.textContent).toMatch(/Paystack/);
    root!.unmount();
    container!.remove();
  });
});
