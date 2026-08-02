import { LegalLayout, B, A, Ul, Li } from './legal/LegalLayout';

export function PrivacyScreen() {
  return (
    <LegalLayout
      title="Privacy Policy"
      lastUpdated="August 2026"
      intro="This policy explains what information Vents collects, why we collect it, who we share it with, and the rights you have over your data — including how to permanently delete your account."
      otherPages={[
        { href: '/terms', label: 'Terms of Use' },
        { href: '/refunds', label: 'Refund Policy' },
        { href: '/', label: '← Back to Vents' },
      ]}
      sections={[
        {
          id: 'who-we-are',
          title: '1. Who We Are',
          body: (
            <>
              Vents App Ltd (&quot;Vents&quot;, &quot;we&quot;, &quot;us&quot;) is a Nigerian company registered in Gwarimpa, Abuja, Nigeria. We operate the Vents event discovery and ticketing platform available at getvents.com and as a mobile application. This Privacy Policy explains how we collect, use, disclose, and protect your information when you use our platform. By using Vents you agree to this policy. If you do not agree, please do not use the Service.
              <br />
              <br />
              Contact: <A href="mailto:support@getvents.com">support@getvents.com</A>
            </>
          ),
        },
        {
          id: 'information-we-collect',
          title: '2. Information We Collect',
          body: (
            <>
              <B>Account information:</B> name, email address, username, phone number, date of birth, and profile photo.
              <br />
              <br />
              <B>Profile information:</B> bio, location, and any other information you choose to add to your public profile.
              <br />
              <br />
              <B>Payment information:</B> we do not store card details. All payments are processed securely by Paystack (paystack.com). We only store transaction references, amounts, and payment status.
              <br />
              <br />
              <B>Ticketing information:</B> events you buy tickets for, ticket QR codes, check-in status, and — if you organize events — attendee lists for your own events, payout bank details, and event listing content.
              <br />
              <br />
              <B>Communications:</B> direct messages you send to other users through the app, and support requests you send to us.
              <br />
              <br />
              <B>Device information:</B> device type, operating system, browser type, IP address, app version, and a push-notification token (used only to deliver notifications you have opted into).
              <br />
              <br />
              <B>Usage data:</B> events you view, tickets you purchase, searches you perform, and features you use.
              <br />
              <br />
              <B>Location data:</B> only when you explicitly grant permission, used to show you nearby events. We do not track your precise GPS location continuously or in the background.
            </>
          ),
        },
        {
          id: 'how-we-use-it',
          title: '3. How We Use Your Information',
          body: (
            <Ul>
              <Li>To create and manage your account</Li>
              <Li>To process ticket purchases and send booking confirmations</Li>
              <Li>To send event reminders and notifications you have opted into</Li>
              <Li>To show you relevant events based on your location and interests</Li>
              <Li>To enable messaging between users, and to let you follow, block, or report other users</Li>
              <Li>To prevent fraud and ensure the security of our platform</Li>
              <Li>To respond to your support requests</Li>
              <Li>To improve our platform through anonymised analytics</Li>
              <Li>To comply with Nigerian law and regulations</Li>
            </Ul>
          ),
        },
        {
          id: 'payment-data',
          title: '4. Payment Data',
          body: (
            <>
              All payment processing on Vents is handled by Paystack Technology Limited, a licensed payment processor regulated in Nigeria. When you make a purchase your payment details are transmitted directly to Paystack and are never stored on our servers. Paystack&apos;s privacy policy is available at{' '}
              <A href="https://paystack.com/privacy" external>
                paystack.com/privacy
              </A>
              .
              <br />
              <br />
              Vents only receives confirmation of successful or failed transactions along with a transaction reference and amount. We never see or store your card number, CVV, or bank PIN.
            </>
          ),
        },
        {
          id: 'data-sharing',
          title: '5. Data Sharing',
          body: (
            <>
              We do not sell your personal data. We share your information only with:
              <Ul>
                <Li>
                  <B>Paystack:</B> for secure payment processing
                </Li>
                <Li>
                  <B>Event organizers:</B> your name and contact details when you purchase a ticket to their event, so they can manage entry and communicate event updates
                </Li>
                <Li>
                  <B>Other users:</B> your public profile (name, username, photo, bio) is visible to users you interact with, follow, or message
                </Li>
                <Li>
                  <B>Legal authorities:</B> when required by Nigerian law or a valid court order
                </Li>
                <Li>
                  <B>Service providers:</B> our cloud hosting/database provider (InsForge), Google Maps/Places for location search, PostHog for anonymised product analytics, Sentry for crash/error reporting, and Firebase Cloud Messaging for push notifications — all under agreements that prohibit them from using your data for their own purposes
                </Li>
              </Ul>
            </>
          ),
        },
        {
          id: 'international-transfer',
          title: '6. International Data Transfer',
          body: (
            <>
              Some of our service providers (cloud hosting, analytics, crash reporting) process data on servers located outside Nigeria. Where this happens, we require those providers to maintain safeguards consistent with the Nigeria Data Protection Act 2023, such as encryption in transit and contractual data-protection obligations.
            </>
          ),
        },
        {
          id: 'vents-cents',
          title: '7. Vents Cents',
          body: (
            <>
              Vents Cents are in-app loyalty points. They are <B>not real money, not withdrawable, and not convertible to cash or any currency</B>. They may only be used for in-app discounts on ticket purchases and hold no monetary value outside the Vents platform.
            </>
          ),
        },
        {
          id: 'account-deletion',
          title: '8. Account Deletion & Data Retention',
          body: (
            <>
              You can permanently delete your account at any time from <B>Settings → Account → Delete Account</B> inside the app — no need to contact support. Deletion is immediate and irreversible: your identifying personal data (name, email, phone number, profile photo, and bio) is anonymised at once, and your login is deactivated at the same moment.
              <br />
              <br />
              We retain your account data for as long as your account is active. Ticket purchase and payout records are retained in anonymised form for 7 years as required by Nigerian financial regulations, even after account deletion. Direct messages you sent are anonymised along with the rest of your account; messages remain visible to the other participant in the conversation unless they also delete their account.
            </>
          ),
        },
        {
          id: 'your-rights',
          title: '9. Your Rights',
          body: (
            <>
              Under the Nigeria Data Protection Act (NDPA) 2023, you have the right to:
              <Ul>
                <Li>
                  <B>Access</B> a copy of your personal data
                </Li>
                <Li>
                  <B>Correct</B> inaccurate data
                </Li>
                <Li>
                  <B>Delete</B> your account, immediately anonymising your identifying personal data (see Section 8)
                </Li>
                <Li>
                  <B>Opt out</B> of marketing communications and push notifications at any time, from Settings
                </Li>
                <Li>
                  <B>Request a copy</B> of your data in a portable format
                </Li>
                <Li>
                  <B>Lodge a complaint</B> with the Nigeria Data Protection Commission (NDPC)
                </Li>
              </Ul>
              To exercise any of these rights, email <A href="mailto:support@getvents.com">support@getvents.com</A>. We will respond within 30 days.
            </>
          ),
        },
        {
          id: 'cookies',
          title: '10. Cookies and Tracking',
          body: (
            <>
              We use essential cookies/local storage to keep you logged in and remember your preferences. We use PostHog analytics to understand how the app is used so we can improve it, and Sentry to detect and diagnose crashes. You can disable non-essential cookies in your device or browser settings. Disabling essential cookies may prevent you from logging in.
            </>
          ),
        },
        {
          id: 'security',
          title: '11. Security',
          body: (
            <>
              We use HTTPS/TLS for all data in transit. Passwords are never stored in plaintext. Access to user data is restricted internally to what is needed to operate the platform. We conduct regular security reviews. Despite our best efforts no system is 100% secure; if we discover a breach that affects your information we will notify you directly. If you suspect unauthorized access to your account, contact us immediately at{' '}
              <A href="mailto:support@getvents.com">support@getvents.com</A>.
            </>
          ),
        },
        {
          id: 'children',
          title: '12. Children',
          body: (
            <>
              Vents is not intended for users under 13 years of age. We do not knowingly collect personal data from anyone under 13. Users between 13 and 18 must have parental consent to use the Service. If you believe a child under 13 has created an account, contact us at <A href="mailto:support@getvents.com">support@getvents.com</A> and we will delete the account.
            </>
          ),
        },
        {
          id: 'changes',
          title: '13. Changes to This Policy',
          body: (
            <>
              We will notify you of significant changes to this policy via email or in-app notification before the changes take effect. Continued use of Vents after changes are notified constitutes acceptance of the updated policy.
            </>
          ),
        },
        {
          id: 'contact',
          title: '14. Contact Us',
          body: (
            <>
              Vents App Ltd
              <br />
              Gwarimpa, Abuja, Nigeria
              <br />
              Email: <A href="mailto:support@getvents.com">support@getvents.com</A>
              <br />
              WhatsApp: <A href="https://wa.me/2349030737368">+234 9030 737 368</A>
            </>
          ),
        },
      ]}
    />
  );
}
