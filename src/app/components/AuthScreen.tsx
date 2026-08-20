import { useState, useRef, useEffect } from 'react';
import { ArrowLeft, Eye, EyeOff, Mail, Lock, User, AlertCircle, MapPin, X, ChevronRight, ChevronDown, Check, ShieldCheck } from 'lucide-react';
import { PhoneInput } from './PhoneInput';
import { AuthMode } from './types';
import { VentsLogo } from './VentsLogo';
import { supabase } from '../../lib/supabase';
import { openExternalUrl } from '../../lib/externalLink';
import { NIGERIA_STATES } from './StateSelectScreen';
import { pickImage } from '../../lib/pickImage';
import { ImageCropperModal } from './ImageCropperModal';
import { PickerSheet } from './shared/PickerSheet';
import { verifyTOTP } from '../../lib/totp';
import { analytics } from '../../lib/analyticsEvents';
import { validateUsername, validatePassword } from '../../lib/sanitize';
import { signupSchema, loginSchema, firstValidationError } from '../../lib/schemas';
import { REGION } from '../../lib/regionConfig';
import { COUNTRY_CODES, DEFAULT_COUNTRY, isPlausibleNationalNumber, buildE164 } from '../../lib/countries';
import { savePendingVerification, getPendingVerification, clearPendingVerification } from '../../lib/pendingVerification';
import { Sentry } from '../../lib/sentry';
import { withTimeoutFallback } from '../../lib/withTimeoutFallback';

// Must match Supabase Auth's mailer_otp_length project setting (currently 8,
// not the library default of 6) -- confirmed via the Management API before
// this change. A mismatch here means the email always shows more digits
// than the input can ever hold, so verification can never succeed.
const EMAIL_OTP_LENGTH = 8;

// Best-effort abuse guard for traffic going through this screen — Supabase
// Auth's own endpoints run outside our schema, so this can't stop a scripted
// attacker who skips our UI and calls them directly. It does stop the
// overwhelmingly common case: a script or bot hammering our actual
// login/signup/reset form. Dual-keyed server-side (per-identifier and
// per-IP) inside check_auth_rate_limit(); throws a friendly message rather
// than letting the raw 'rate_limited' RPC error reach the user.
async function checkAuthRateLimit(action: 'login' | 'signup' | 'password_reset', identifier: string) {
  const { error } = await supabase.rpc('check_auth_rate_limit', { p_action: action, p_identifier: identifier });
  if (error) {
    if (String((error as any)?.message || error).includes('rate_limited')) {
      throw new Error('Too many attempts. Please wait a few minutes and try again.');
    }
    // Fail open — a rate-limit check failing for an unrelated reason (e.g.
    // a transient network blip) shouldn't block a legitimate login.
  }
}

interface AuthScreenProps {
  initialMode: AuthMode;
  userRole?: string;
  selectedState?: string;
  onBack: () => void;
  onSuccess: (userProfile: { id: string; email: string; full_name: string | null; role: string; username?: string; phone_number?: string; state?: string; avatar_url?: string; cover_url?: string; isOrganizer?: boolean; is_verified?: boolean; vc_badge?: string }) => void;
  resetToken?: string;
  // Set when the user arrived via the "Verify Account" link in the
  // verification email (?verify_email=) or is resuming a signup that was
  // left mid-verification on a previous visit — jumps straight to the OTP
  // screen instead of the sign-up form.
  pendingVerificationEmail?: string;
  // Kill switch (app_config.disable_signups) — the server-side signup path
  // itself can't be gated (Supabase Auth's own signup endpoint runs outside
  // our schema), so this blocks the client's own signup attempt and the
  // check_signups_enabled() pre-flight RPC blocks it again server-side for
  // any caller that goes through our RPC layer at all.
  signupsDisabled?: boolean;
}

const INPUT_STYLE: React.CSSProperties = {
  flex: 1,
  background: 'none',
  border: 'none',
  outline: 'none',
  color: '#FFFFFF',
  fontSize: '14px',
  fontFamily: 'Inter, sans-serif',
};

// Fields sit on a near-black radial background (#050010 → #020005). The old
// #090514 fill was within a few percent of it, so inputs visually dissolved
// into the page. These two constants keep every field — text rows, the date
// input, the state picker — on one raised surface with a readable edge.
const FIELD_BG = '#150B26';
const FIELD_BORDER = 'rgba(255,255,255,0.16)';
// Fields use a 16px radius; the submit button matches so the form reads as
// one set of controls rather than a pill dropped under a stack of boxes.
const FIELD_RADIUS = '16px';

const BTN_PRIMARY: React.CSSProperties = {
  width: '100%',
  height: '52px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)',
  border: 'none',
  borderRadius: FIELD_RADIUS,
  padding: '0 24px',
  color: '#fff',
  fontSize: '16px',
  fontWeight: 700,
  fontFamily: 'Space Grotesk, sans-serif',
  cursor: 'pointer',
  boxShadow: '0 8px 24px rgba(123,47,190,0.35)',
};

// Profile photo limits. The file is cropped and re-encoded to JPEG before
// upload, so this cap is about refusing absurd inputs early (and not burning a
// mobile data plan decoding a 40MB RAW) rather than about the final object size.
const MAX_AVATAR_BYTES = 8 * 1024 * 1024;
const ALLOWED_AVATAR_TYPES = [
  'image/jpeg', 'image/pjpeg', 'image/png', 'image/webp', 'image/gif',
  'image/heic', 'image/heif',
];

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

function InputRow({
  icon: Icon,
  placeholder,
  value,
  onChange,
  type = 'text',
  right,
  error,
  onEnter,
}: {
  icon: React.ElementType;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  right?: React.ReactNode;
  error?: string;
  /** Submit the surrounding form when Enter is pressed in this field. */
  onEnter?: () => void;
}) {
  return (
    <div>
      <div
        className="auth-input-row"
        style={{
          display: 'flex',
          alignItems: 'center',
          background: FIELD_BG,
          border: `1px solid ${error ? 'rgba(239,68,68,0.6)' : FIELD_BORDER}`,
          borderRadius: FIELD_RADIUS,
          height: '52px',
          padding: '0 16px',
          gap: '12px',
        }}
      >
        <Icon size={18} color={error ? '#EF4444' : '#94A3B8'} />
        <input
          type={type}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onEnter ? (e) => { if (e.key === 'Enter') { e.preventDefault(); onEnter(); } } : undefined}
          style={INPUT_STYLE}
        />
        {right}
      </div>
      {error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginTop: '5px', paddingLeft: '4px' }}>
          <AlertCircle size={12} color="#EF4444" />
          <span style={{ color: '#EF4444', fontSize: '11px' }}>{error}</span>
        </div>
      )}
    </div>
  );
}

export function AuthScreen({ initialMode, userRole, selectedState, onBack, onSuccess, resetToken, pendingVerificationEmail, signupsDisabled = false }: AuthScreenProps) {
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const otpInputRef = useRef<HTMLInputElement>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [signupState, setSignupState] = useState('');
  const [role, setRole] = useState<'attendee' | 'organizer' | null>(
    userRole === 'organizer' || userRole === 'organiser' ? 'organizer'
    : userRole === 'attendee' ? 'attendee'
    : null
  );
  const [showStateDropdown, setShowStateDropdown] = useState(false);
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  // Raw national-number digits only — the country dial code is tracked
  // separately so the selector can change without re-parsing the input.
  const [phone, setPhone] = useState<string>('');
  const [phoneCountryCode, setPhoneCountryCode] = useState<string>(REGION.phoneCountryCode);
  // NIGERIA_STATES only makes sense for a Nigerian phone/account — every
  // other country falls back to a free-text region field rather than a
  // fabricated or incorrect subdivision list (no per-country states/
  // provinces data exists yet for the other ~189 countries).
  const isNigeriaSelected = (COUNTRY_CODES.find((c) => c.code === phoneCountryCode) || DEFAULT_COUNTRY).iso === 'NG';
  const handlePhoneCountryChange = (code: string) => {
    // Switching country must not leave a stale Nigerian state (or a
    // free-text value typed for a different country) behind.
    setPhoneCountryCode(code);
    setSignupState('');
  };
  const [loading, setLoading] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const [emailTouched, setEmailTouched] = useState(false);

  const [isVerifying, setIsVerifying] = useState(false);
  const [verificationCode, setVerificationCode] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

  // Resume a signup left mid-verification: either the caller told us
  // exactly which email (arrived via the "Verify Account" email link), or
  // there's a still-fresh pending verification saved locally from a prior
  // visit (app closed/backgrounded before the OTP was entered).
  useEffect(() => {
    if (isVerifying) return;
    const existingPending = getPendingVerification();
    const resumeEmail = pendingVerificationEmail || existingPending?.email;
    if (resumeEmail) {
      setEmail(resumeEmail);
      setIsVerifying(true);
      // Carries the existing `profile` payload forward instead of dropping
      // it — this exact re-save (triggered by arriving via the "Verify
      // Account" email link) used to call savePendingVerification with only
      // the email, which wiped the signup form data this same resume path
      // depends on to complete the profile once verification succeeds.
      if (pendingVerificationEmail) savePendingVerification(pendingVerificationEmail, existingPending?.profile);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingVerificationEmail]);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setInterval(() => setResendCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [resendCooldown]);

  // Forgot-password flow: Step 1 (verification code) → Step 2 (new password),
  // two discrete screens instead of one combined form.
  const [forgotOtpStep, setForgotOtpStep] = useState(false);
  const [forgotOtpCode, setForgotOtpCode] = useState('');
  const [forgotVerifying, setForgotVerifying] = useState(false);
  const [forgotPasswordStep, setForgotPasswordStep] = useState(false);
  const [forgotExchangedToken, setForgotExchangedToken] = useState<string | null>(null);
  const [forgotNewPassword, setForgotNewPassword] = useState('');
  const [forgotConfirmPassword, setForgotConfirmPassword] = useState('');
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const forgotOtpRef = useRef<HTMLInputElement>(null);

  const resetForgotFlow = () => {
    setForgotSent(false);
    setForgotOtpStep(false);
    setForgotPasswordStep(false);
    setForgotOtpCode('');
    setForgotExchangedToken(null);
    setForgotNewPassword('');
    setForgotConfirmPassword('');
    setErrorMessage(null);
  };

  // TOTP 2FA prompt (shown after successful password auth when totp_enabled=true)
  const [totpPending, setTotpPending] = useState<null | { secret: string; profilePayload: Parameters<typeof onSuccess>[0] }>(null);
  const [totpCode, setTotpCode] = useState('');
  const [totpError, setTotpError] = useState<string | null>(null);
  const totpInputRef = useRef<HTMLInputElement>(null);

  // Ban screen (shown when status = suspended or deleted)
  const [banInfo, setBanInfo] = useState<null | { status: 'suspended' | 'deleted'; until: string | null }>(null);


  const [dob, setDob] = useState('');
  const [dobError, setDobError] = useState<string | null>(null);
  const [tosAccepted, setTosAccepted] = useState(false);

  const signupFileInputRef = useRef<HTMLInputElement>(null);
  const [signupAvatarUrl, setSignupAvatarUrl] = useState('');
  const [signupAvatarKey, setSignupAvatarKey] = useState('');
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [signupAvatarFile, setSignupAvatarFile] = useState<File | null>(null);
  const [signupAvatarPreview, setSignupAvatarPreview] = useState('');
  const [cropImageSrc, setCropImageSrc] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  // Revoke whichever blob URLs are still outstanding when this screen finally
  // unmounts (signup/login normally happens once per session, but a user
  // backing out of signup entirely would otherwise leak these for the rest
  // of the tab's lifetime). Tracked via refs, not the state values directly,
  // so the cleanup below always sees the latest URL rather than a stale
  // closure over whatever was current on first render.
  const cropImageSrcRef = useRef(cropImageSrc);
  cropImageSrcRef.current = cropImageSrc;
  const signupAvatarPreviewRef = useRef(signupAvatarPreview);
  signupAvatarPreviewRef.current = signupAvatarPreview;
  useEffect(() => {
    return () => {
      if (cropImageSrcRef.current) URL.revokeObjectURL(cropImageSrcRef.current);
      if (signupAvatarPreviewRef.current) URL.revokeObjectURL(signupAvatarPreviewRef.current);
    };
  }, []);

  const processSignupAvatarFile = (file: File) => {
    setErrorMessage(null);

    // accept="image/*" is only a picker hint — the user can switch the dialog
    // to "All files" and choose anything, so the type must be checked here.
    // Match on the real MIME type rather than the extension.
    if (!ALLOWED_AVATAR_TYPES.includes(file.type)) {
      setAvatarError('Please choose an image file (JPG, PNG, WebP, GIF or HEIC).');
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setAvatarError(`Image is ${formatBytes(file.size)} — the maximum is ${formatBytes(MAX_AVATAR_BYTES)}.`);
      return;
    }

    setAvatarError(null);
    setCropImageSrc((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(file); });
  };
  const handleUploadSignupAvatar = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input so picking the same file twice still fires onChange
    // (otherwise a rejected file can't be re-selected after fixing nothing).
    e.target.value = '';
    if (file) processSignupAvatarFile(file);
  };
  const openSignupAvatarPicker = async () => {
    const native = await pickImage();
    if (native) { processSignupAvatarFile(native); return; }
    signupFileInputRef.current?.click();
  };

  const handleCropComplete = (croppedBlob: Blob) => {
    const croppedFile = new File([croppedBlob], 'avatar.jpg', { type: 'image/jpeg' });
    setSignupAvatarFile(croppedFile);
    setSignupAvatarPreview((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(croppedBlob); });
    setCropImageSrc((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
  };

  const uploadAvatarIfPending = async (): Promise<string> => {
    if (!signupAvatarFile) return signupAvatarUrl;
    setAvatarUploading(true);
    try {
      // Supabase's storage client has no InsForge-style uploadAuto() that
      // generates its own key — the object path/key must be supplied
      // explicitly. signupAvatarFile is always a freshly cropped JPEG (see
      // handleCropComplete), so a random key with a fixed extension is
      // sufficient; there's no pre-existing naming convention to match
      // since this was the only avatars-bucket upload call in the codebase.
      const key = `${crypto.randomUUID()}.jpg`;
      const { error } = await supabase.storage.from('avatars').upload(key, signupAvatarFile, {
        contentType: 'image/jpeg',
        upsert: false,
      });
      if (error) throw error;
      const { data: urlData } = supabase.storage.from('avatars').getPublicUrl(key);
      if (urlData?.publicUrl) {
        setSignupAvatarUrl(urlData.publicUrl);
        setSignupAvatarKey(key);
        return urlData.publicUrl;
      }
    } catch (err: any) {
      console.error("Failed to upload avatar:", err);
      Sentry.captureException(err);
      setErrorMessage(err.message || "Failed to upload photo. Proceeding without avatar.");
    } finally {
      setAvatarUploading(false);
    }
    return '';
  };

  // Single source of truth for password strength, shared by the live checklist
  // and the inline field error so the two can never disagree.
  const passwordRules = [
    { met: password.length >= 10, label: 'At least 10 characters' },
    { met: /[a-z]/.test(password) && /[A-Z]/.test(password), label: 'Upper and lower case letters' },
    { met: /\d/.test(password), label: 'At least one number' },
  ];
  const isSettingPassword = mode === 'signup' || mode === 'reset';
  const unmetRuleCount = passwordRules.filter(r => !r.met).length;
  // Only surface errors once the user has actually typed — an empty field on a
  // freshly opened form is not a mistake yet.
  const passwordError = isSettingPassword && password.length > 0 && unmetRuleCount > 0
    ? `Password is missing ${unmetRuleCount} requirement${unmetRuleCount > 1 ? 's' : ''} below.`
    : undefined;
  const confirmPasswordError = isSettingPassword && confirmPassword.length > 0 && password !== confirmPassword
    ? 'Passwords do not match.'
    : undefined;

  const isEmailOrUsernameValid = (val: string) => {
    if (mode === 'login') {
      return val.trim().length >= 3;
    }
    return isValidEmail(val);
  };

  const emailError = emailTouched && email.length > 0 && !isEmailOrUsernameValid(email)
    ? (mode === 'login' ? 'Please enter a valid username or email' : 'Please enter a valid email address (e.g. name@gmail.com)')
    : undefined;

  const canSubmit = !emailError && (
    mode === 'forgot'
      ? email.length > 0
      : mode === 'signup'
      ? (!signupsDisabled &&
         email.length > 0 &&
         password.length > 0 &&
         confirmPassword.length > 0 &&
         password === confirmPassword &&
         username.trim().length > 0 &&
         phone.trim().length > 0 &&
         name.trim().length > 0 &&
         !!signupState &&
         !!role &&
         !!dob && !dobError &&
         tosAccepted)
      : mode === 'reset'
      ? (password.length > 0 && confirmPassword.length > 0 && password === confirmPassword)
      : (email.length > 0 && password.length > 0)
  );

  const handleEmailBlur = () => setEmailTouched(true);

  // Pressing Enter in any auth field should do exactly what tapping the primary
  // button does — including doing nothing when that button is disabled, so a
  // stray Enter can't bypass validation the button already enforces.
  const submitOnEnter = () => {
    if (loading || !canSubmit) return;
    handleSubmit();
  };

  const fetchProfileAndSucceed = async (userId: string, userEmail: string, avatarUrl?: string) => {
    for (let i = 0; i < 20; i++) {
      const { data: profile } = await supabase
        .from('users')
        .select('*')
        .eq('id', userId)
        .maybeSingle();

      if (profile) {
        const strictRole = role === 'organizer' ? 'organizer' : 'attendee';

        // Role changes must go through this SECURITY DEFINER RPC —
        // check_user_role_update() rejects a plain UPDATE/upsert touching
        // `role` from an authenticated-role caller. Awaited and checked so
        // a rejected role change is visible instead of silently reverting
        // to the trigger-assigned default on next login.
        const { error: roleError } = await supabase.rpc('set_signup_role' as any, { p_role: strictRole });
        if (roleError) console.error('Signup Failure Trace — role set:', roleError);

        // Component state (name/username/phone/dob/signupState) is blank
        // whenever this screen was reached via a fresh mount rather than a
        // continuous fill-form-then-verify session — e.g. the user resumed
        // from the "Verify Account" email link (?verify_email=...), which
        // only pre-fills the email. Fall back to what was persisted at
        // signup time so a fresh mount doesn't overwrite already-entered
        // data with blanks.
        const pending = getPendingVerification();
        const pendingProfile = pending?.email === userEmail.toLowerCase() ? pending.profile : undefined;
        const payload: Record<string, any> = {
          full_name: name.trim() || pendingProfile?.full_name || '',
          username: (username.trim() || pendingProfile?.username || '').toLowerCase(),
          phone_number: phone ? buildE164(phone, phoneCountryCode) : (pendingProfile?.phone_number || ''),
          state: (signupState || selectedState || pendingProfile?.state || '').trim(),
          avatar_url: avatarUrl || signupAvatarUrl || pendingProfile?.avatar_url,
        };
        const effectiveDob = dob || pendingProfile?.date_of_birth;
        if (effectiveDob) payload.date_of_birth = effectiveDob;

        // Only write fields that actually have a value — an update payload
        // of all-blank strings (e.g. this ran with neither live state nor a
        // pending fallback available) would clobber a profile that a prior,
        // successful write already completed correctly.
        const writablePayload = Object.fromEntries(
          Object.entries(payload).filter(([, v]) => v !== '' && v != null)
        );
        if (Object.keys(writablePayload).length > 0) {
          const { error: updateError } = await supabase.from('users').update(writablePayload).eq('id', userId);
          if (updateError) { console.error('Signup Failure Trace — profile completion update:', updateError); Sentry.captureException(updateError); }
        }

        const { data: verifiedProfile } = await supabase
          .from('users')
          .select('*')
          .eq('id', userId)
          .maybeSingle();

        const finalProfile = verifiedProfile || profile;
        // Reflect whatever role actually landed in the DB, not the client's
        // pre-write guess — if set_signup_role failed above, this correctly
        // shows the trigger-assigned 'attendee' rather than masking it.
        const verifiedRole = (finalProfile.role === 'organizer' || finalProfile.role === 'organiser') ? 'organizer' : 'attendee';

        // Apply referral code if user signed up via ?ref= link. Awaited and
        // only cleared from sessionStorage once we get a definitive
        // response — a transient failure now leaves the code in place to
        // retry on the next load, instead of being silently lost forever.
        const pendingRef = sessionStorage.getItem('vents_ref_code');
        if (pendingRef) {
          try {
            const { error: refError } = await supabase.rpc('complete_referral' as any, { p_referrer_code: pendingRef });
            if (refError) console.error('Referral completion failed:', refError);
            else sessionStorage.removeItem('vents_ref_code');
          } catch (e) {
            console.error('Referral completion threw:', e);
            Sentry.captureException(e);
          }
        }

        onSuccess({
          id: userId,
          email: userEmail,
          full_name: finalProfile.full_name || payload.full_name,
          role: verifiedRole,
          username: finalProfile.username || payload.username,
          phone_number: finalProfile.phone_number || payload.phone_number,
          state: finalProfile.state || payload.state,
          avatar_url: finalProfile.avatar_url || payload.avatar_url,
          cover_url: finalProfile.cover_url,
          isOrganizer: verifiedRole === 'organizer',
          is_verified: finalProfile.is_verified === true,
          vc_badge: finalProfile.vc_badge,
        });
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error("User profile creation is taking longer than expected. Please try signing in.");
  };

  const MAX_AUTH_ATTEMPTS = 5;
  const AUTH_LOCKOUT_MS = 5 * 60 * 1000;

  const handleSubmit = async () => {
    setEmailTouched(true);
    setErrorMessage(null);
    // reset mode doesn't use the email field — skip the email validation gate
    if (mode !== 'reset' && !isEmailOrUsernameValid(email)) return;

    // Client-side rate limiting for login and signup
    if (mode === 'login' || mode === 'signup') {
      const stored = JSON.parse(localStorage.getItem('auth_attempts') || '{"count":0,"timestamp":0}');
      const now = Date.now();
      if (stored.count >= MAX_AUTH_ATTEMPTS && now - stored.timestamp < AUTH_LOCKOUT_MS) {
        const minutesLeft = Math.ceil((AUTH_LOCKOUT_MS - (now - stored.timestamp)) / 60000);
        setErrorMessage(`Too many attempts. Please wait ${minutesLeft} minute(s) before trying again.`);
        return;
      }
    }

    setLoading(true);

    try {
      if (mode === 'forgot') {
        if (!email.trim() || !isValidEmail(email)) throw new Error('Please enter a valid email address.');
        await checkAuthRateLimit('password_reset', email.trim().toLowerCase());
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase());
        if (error) throw error;
        analytics.passwordResetRequested();
        setForgotSent(true);
        setForgotOtpStep(true);

      } else if (mode === 'reset') {
        // Legacy InsForge deep-link recovery — superseded by the in-app OTP
        // flow above (mode === 'forgot': verifyOtp + updateUser). Supabase's
        // recovery email now sends a 6-digit code, not a link carrying a
        // token these params could consume, so this mode is unreachable via
        // any link Supabase's own email templates actually produce.
        setMode('forgot');
        setPassword('');
        setConfirmPassword('');
      } else if (mode === 'signup') {
        if (signupsDisabled) throw new Error('New sign-ups are temporarily paused. Please check back shortly.');
        if (!name.trim()) throw new Error('Full name is required.');
        if (!username.trim()) throw new Error('Username is required.');
        if (!validateUsername(username.trim())) throw new Error('Username must be 3-30 characters, letters numbers and underscores only.');
        if (!email.trim() || !isValidEmail(email)) throw new Error('Please enter a valid email address.');
        if (!phone.trim()) throw new Error('Phone number is required.');
        const normalizedPhone = buildE164(phone, phoneCountryCode);
        const isNigerianPhone = phoneCountryCode === REGION.phoneCountryCode;
        if (isNigerianPhone && !REGION.phoneRegex.test(normalizedPhone)) {
          throw new Error('Phone number must be in +234XXXXXXXXXX format, e.g., +2348012345678');
        }
        // Every other country: no hand-authored exact pattern (VENTS
        // supports all ~195 countries in src/lib/countries.ts, not just
        // Nigeria — SMS delivery and CAC business verification remain
        // genuinely Nigeria-only features, but they're best-effort/opt-in,
        // not signup requirements), so validate against a plausible
        // digit-count range for the selected country instead.
        if (!isNigerianPhone) {
          const selectedCountry = COUNTRY_CODES.find((c) => c.code === phoneCountryCode) || DEFAULT_COUNTRY;
          if (!isPlausibleNationalNumber(phone.replace(/\D/g, ''), selectedCountry)) {
            throw new Error(`Please enter a valid ${selectedCountry.name} phone number.`);
          }
        }
        if (!password) throw new Error('Password is required.');
        if (!validatePassword(password)) throw new Error('Password must be at least 10 characters and include an uppercase letter, a lowercase letter, and a number.');
        if (password !== confirmPassword) throw new Error('Passwords do not match.');
        if (!signupState && !selectedState) throw new Error('State is required.');
        if (!role) throw new Error('Role is required.');
        if (!dob) throw new Error('Date of birth is required.');
        const dobDate = new Date(dob);
        const ageDiff = Date.now() - dobDate.getTime();
        const ageYears = Math.floor(ageDiff / (365.25 * 24 * 60 * 60 * 1000));
        if (ageYears < 13) throw new Error('You must be at least 13 years old to create an account.');

        // Boundary-layer schema validation — rejects malformed/malicious
        // payloads before any DB call is made.
        const signupCheck = signupSchema.safeParse({
          name: name.trim(),
          username: username.trim(),
          email: email.trim(),
          phone: normalizedPhone,
          password,
          state: (signupState || selectedState || '').trim(),
        });
        if (!signupCheck.success) throw new Error(firstValidationError(signupCheck));

        // Block re-signup with a previously deleted email
        const { data: deletedRow } = await supabase
          .from('deleted_emails')
          .select('email')
          .eq('email', email.trim().toLowerCase())
          .maybeSingle();
        if (deletedRow) {
          throw new Error('This email address was used on a deleted account and cannot be re-registered. Contact support@getvents.com if you believe this is an error.');
        }

        // Block re-signup with a previously deleted phone number
        if (normalizedPhone) {
          const { data: deletedPhoneRow } = await supabase
            .from('deleted_phones')
            .select('phone')
            .eq('phone', normalizedPhone)
            .maybeSingle();
          if (deletedPhoneRow) {
            throw new Error('This phone number was used on a deleted account and cannot be re-registered. Contact support@getvents.com if you believe this is an error.');
          }
        }

        const strictRole = role === 'organizer' ? 'organizer' : 'attendee';
        const userMetaPayload = {
          full_name: name.trim(),
          username: username.trim().toLowerCase(),
          phone_number: normalizedPhone,
          state: (signupState || selectedState || '').trim(),
          role: strictRole,
          avatar_url: signupAvatarUrl
        };

        const normalizedEmail = email.trim().toLowerCase();
        const normalizedUsername = username.trim().toLowerCase();

        const { data: existsResult, error: lookupError } = await supabase.rpc('check_user_exists', {
          p_email: normalizedEmail,
          p_phone: normalizedPhone,
          p_username: normalizedUsername,
        });
        if (lookupError) throw lookupError;
        if (existsResult?.email_taken) throw new Error('Email already exists');
        if (existsResult?.phone_taken) throw new Error('Phone number already exists');
        if (existsResult?.username_taken) throw new Error('Username already exists');

        // check_user_exists only flags VERIFIED accounts, so an abandoned,
        // unverified signup sharing this email/phone/username can still be
        // sitting in the database — which would make the signUp() call below
        // fail on the platform's own uniqueness constraint. Reclaim (delete)
        // any such stale, unconfirmed row first so this signup can proceed.
        // No-op if nothing matches; never touches a verified account.
        try {
          await supabase.rpc('reclaim_unverified_signup', {
            p_email: normalizedEmail,
            p_phone: normalizedPhone,
            p_username: normalizedUsername,
          });
        } catch { /* best-effort — a real collision still surfaces via signUp()'s own error below */ }

        await checkAuthRateLimit('signup', normalizedEmail);
        // Server-side re-check, not just the client-side signupsDisabled
        // gate above — catches any caller hitting this RPC layer directly.
        const { error: flagError } = await supabase.rpc('check_signups_enabled');
        if (flagError && String((flagError as any)?.message || flagError).includes('signups_disabled')) {
          throw new Error('New sign-ups are temporarily paused. Please check back shortly.');
        }
        // Passed as signUp()'s own options.data (-> auth.users.raw_user_meta_data)
        // rather than relying solely on the follow-up client-side write
        // below: this is captured atomically as part of signUp() itself,
        // before any session exists and regardless of which browser/device
        // the user later confirms their email in. handle_new_user() (the
        // auth.users insert trigger, supabase/migrations/0025) reads this
        // to populate the profile row at creation time, so the data isn't
        // lost even if a confirmation link is opened somewhere the original
        // signup form's state/localStorage was never present.
        const { data, error } = await supabase.auth.signUp({
          email: normalizedEmail,
          password,
          options: {
            data: {
              full_name: userMetaPayload.full_name,
              username: userMetaPayload.username,
              phone_number: userMetaPayload.phone_number,
              state: userMetaPayload.state,
              date_of_birth: dob || undefined,
            },
          },
        });
        if (error) throw error;

        // No manual token rehydration needed here (unlike the old InsForge
        // path) — supabase.auth.signUp() sets the client's session
        // internally, and every supabase.from()/rpc() call below
        // automatically carries that session's JWT, so the profile upsert
        // (gated by auth.uid() = id under RLS) just works.

        // Write profile fields directly to the users table after the auth
        // record is created. `role` is deliberately NOT included here —
        // check_user_role_update() rejects any direct role write from an
        // authenticated caller; the actual role change happens via the
        // set_signup_role() RPC in fetchProfileAndSucceed below, which runs
        // as SECURITY DEFINER.
        if (data?.user?.id) {
          await supabase.from('users').upsert({
            id: data.user.id,
            email: normalizedEmail,
            full_name: userMetaPayload.full_name,
            username: userMetaPayload.username,
            phone_number: userMetaPayload.phone_number,
            state: userMetaPayload.state,
            avatar_url: userMetaPayload.avatar_url || null,
            date_of_birth: dob || null,
          }, { onConflict: 'id' }).then(() => {}, (e: any) => { console.error('Signup Failure Trace — profile upsert:', e); Sentry.captureException(e); });
        }

        // Session persistence across reloads is handled automatically by
        // the Supabase client's storage adapter (see src/lib/supabase.ts) —
        // no manual refresh-token save needed here (unlike the old InsForge
        // path, which had to persist it by hand).

        // Supabase's signUp() returns session === null when email
        // confirmation is required (mailer_autoconfirm is off on this
        // project) — the direct equivalent of InsForge's
        // requireEmailVerification flag. A non-null session means
        // confirmation isn't required and the user is already signed in.
        if (data?.user && !data.session) {
          analytics.signedUp(strictRole);
          setIsVerifying(true);
          // Persist the full form, not just the email — the immediate
          // upsert above has no session yet (email confirmation pending)
          // and is RLS-rejected, so this is the only place this data
          // survives a reload or a fresh page load reached via the
          // confirmation link, for the completion write in
          // fetchProfileAndSucceed / hydrateAuth to pick back up.
          savePendingVerification(normalizedEmail, {
            full_name: userMetaPayload.full_name,
            username: userMetaPayload.username,
            phone_number: userMetaPayload.phone_number,
            state: userMetaPayload.state,
            date_of_birth: dob || undefined,
            avatar_url: userMetaPayload.avatar_url || undefined,
          });
          // Supabase's own "Confirm signup" email (mailer_templates_confirmation_content)
          // is now the single, fully VENTS-branded email for this step -- it
          // already contains both the OTP code and a "Verify Account" button
          // pointing back at this app. sendVerifyAccountEmail() used to send
          // a second, separate email here with no code at all, which is what
          // caused the "two emails" / "where's my code" confusion.
        } else if (data?.session && data?.user) {
          analytics.signedUp(strictRole);
          const avatarUrl = await uploadAvatarIfPending();
          await fetchProfileAndSucceed(data.user.id, data.user.email!, avatarUrl);
        }

      } else if (mode === 'login') {
        // Boundary-layer schema validation — rejects malformed/malicious
        // payloads before any DB call is made.
        const loginCheck = loginSchema.safeParse({ identifier: email.trim(), password });
        if (!loginCheck.success) throw new Error(firstValidationError(loginCheck));

        await checkAuthRateLimit('login', email.trim().toLowerCase());

        let loginEmail = email.trim();
        if (!isValidEmail(loginEmail)) {
          // No manual token-clearing needed here (unlike the old InsForge
          // path) — this RPC runs before signInWithPassword below, so the
          // Supabase client is already unauthenticated (anon) at this point;
          // it only carries a session once one has actually been
          // established.
          const { data: resolvedEmail, error: resolveError } = await supabase.rpc('resolve_username_to_email', { p_username: loginEmail.toLowerCase() });
          if (resolveError) throw resolveError;
          if (!resolvedEmail) throw new Error('No account found with this username.');
          loginEmail = resolvedEmail;
        }

        // supabase.auth.signInWithPassword() replaces the old raw fetch to
        // InsForge's /api/auth/sessions?client_type=mobile endpoint (that
        // manual call existed only to get a refresh token back in the
        // response body for cross-origin localhost use — Supabase's client
        // persists its own session via the storage adapter in
        // src/lib/supabase.ts, so none of that manual plumbing is needed).
        const { data, error } = await supabase.auth.signInWithPassword({ email: loginEmail, password });
        if (error) throw error;

        if (data?.user) {
          // Explicit column list, NOT select('*') -- deliberately excludes
          // totp_secret. The TOTP 2FA prompt below used to read the raw
          // secret straight into client state and verify it entirely
          // client-side (src/lib/totp.ts's verifyTOTP()), which means the
          // permanent secret was shipped to the browser on every login for
          // any 2FA-enabled account, before the 2FA challenge was even
          // shown -- password alone would have been enough to also receive
          // the secret. No account currently has totp_enabled=true (no
          // enrollment UI exists to turn it on), so this had zero live
          // exposure, but it's a real defect if the column is ever set.
          // Fixed at the source: the secret is never fetched here at all.
          // A safe re-enable of 2FA needs a SECURITY DEFINER RPC that
          // verifies the code server-side and returns only a boolean --
          // not attempted here since shipping unverified crypto is worse
          // than leaving the feature (currently unused by anyone) inert.
          //
          // Also wrapped in withTimeoutFallback, matching every other
          // network call in this file -- previously the only one that
          // could hang the "Signing in..." button forever on a stalled
          // connection, with no timeout to recover from it.
          const { data: profile } = await withTimeoutFallback(
            Promise.resolve(
              supabase
                .from('users')
                .select('status, banned_until, full_name, username, phone_number, state, avatar_url, cover_url, role, is_verified, vc_badge')
                .eq('id', data.user.id)
                .maybeSingle()
            ),
            { timeoutMs: 10000, timeoutMessage: 'This is taking longer than expected. Please check your connection and try again.' }
          );

          // 3.5: Block banned / deleted accounts immediately after auth
          if (profile?.status === 'suspended' || profile?.status === 'deleted') {
            await supabase.auth.signOut().catch(() => {});
            setBanInfo({ status: profile.status, until: profile.banned_until ?? null });
            setLoading(false);
            return;
          }

          // Reflect the real role from the DB as-is — narrowing this to only
          // 'admin'/'organizer'/'attendee' silently demoted every other real
          // role (e.g. 'sub-admin', or the legacy 'user' default) to
          // 'attendee' on every single login.
          const dbRole = profile?.role || 'attendee';
          const profilePayload = {
            id: data.user.id,
            email: data.user.email || '',
            full_name: profile?.full_name || data.user.user_metadata?.full_name || (data.user.email || '').split('@')[0],
            role: dbRole,
            username: profile?.username || data.user.user_metadata?.username,
            phone_number: profile?.phone_number || data.user.user_metadata?.phone_number,
            state: profile?.state || data.user.user_metadata?.state,
            avatar_url: profile?.avatar_url || data.user.user_metadata?.avatar_url,
            cover_url: profile?.cover_url,
            isOrganizer: dbRole === 'organizer' || dbRole === 'organiser',
            is_verified: profile?.is_verified === true,
            vc_badge: profile?.vc_badge,
          };

          // 3.1: TOTP 2FA prompt removed from here -- it used to read
          // profile.totp_secret straight into client state and verify it
          // entirely client-side (src/lib/totp.ts's verifyTOTP()), meaning
          // the permanent secret was shipped to the browser on every login
          // for any 2FA-enabled account, before the challenge was even
          // shown. The users.select() above deliberately no longer fetches
          // totp_secret at all, closing that leak at the source. No
          // account currently has totp_enabled=true (there's no enrollment
          // UI to turn it on), so this had zero live exposure -- but
          // re-enabling 2FA needs a SECURITY DEFINER RPC that verifies the
          // code server-side and returns only a boolean, not a client-side
          // secret round-trip. See totpPending/verifyTOTP/generateTOTPSecret
          // in src/lib/totp.ts, still present but now unused from here.

          localStorage.removeItem('auth_attempts');
          analytics.loggedIn('password');
          onSuccess(profilePayload);
        }
      }
    } catch (err: any) {
      // Increment rate-limit counter on auth failure
      if (mode === 'login' || mode === 'signup') {
        const stored = JSON.parse(localStorage.getItem('auth_attempts') || '{"count":0,"timestamp":0}');
        localStorage.setItem('auth_attempts', JSON.stringify({ count: stored.count + 1, timestamp: Date.now() }));
      }
      // Always log the raw error — the friendly-message mapping below can
      // otherwise swallow the real cause with zero diagnostic trail.
      console.error(`${mode === 'signup' ? 'Signup' : mode === 'login' ? 'Login' : 'Auth'} Failure Trace:`, err);
      Sentry.captureException(err);
      const msg = (typeof err?.message === 'string' ? err.message : '') + ' ' +
        (typeof err?.error_description === 'string' ? err.error_description : '');
      const msgL = msg.toLowerCase();

      if (mode === 'signup') {
        // Signup-specific error messages — never show login-focused text during signup
        const safe = (msgL.includes('email already') || msgL.includes('email exists') || msgL.includes('already registered') || msgL.includes('already in use') || (msgL.includes('duplicate') && msgL.includes('email')))
          ? 'Email already in use. Try logging in instead.'
          : (msgL.includes('username already') || msgL.includes('username exists') || msgL.includes('username taken') || (msgL.includes('duplicate') && msgL.includes('username')))
          ? 'Username already taken. Please choose another.'
          : (msgL.includes('phone') && (msgL.includes('already') || msgL.includes('exists') || msgL.includes('taken')))
          ? 'Phone number already registered. Try logging in instead.'
          : (msgL.includes('password') && (msgL.includes('weak') || msgL.includes('short') || msgL.includes('simple') || msgL.includes('strength')))
          ? 'Password is too weak. Use at least 10 characters with uppercase, lowercase, and a number.'
          : msgL.includes('rate limit') || msgL.includes('too many')
          ? 'Too many attempts. Please wait a few minutes and try again.'
          : msgL.includes('network') || msgL.includes('fetch')
          ? 'Network error. Check your connection and try again.'
          // Fall back to the real backend message instead of a dead-end
          // generic string — this is what made the last outage undiagnosable.
          // But never show a raw DB-shaped error (constraint names, column
          // names, SQL keywords) straight to the user — those are still
          // fully captured above via console.error/Sentry for diagnosis;
          // the user just needs an honest "something went wrong", not
          // `duplicate key value violates unique constraint "users_username_key"`.
          : /constraint|duplicate key|violates|relation "|column "|syntax error|null value in column/i.test(msg)
          ? 'Signup failed. Please check your details and try again.'
          : (msg.trim() || 'Signup failed. Please check your details and try again.');
        setErrorMessage(safe);
        return;
      }

      // On login failure, check if the account is suspended/deleted so we can
      // show the ban screen instead of a generic "Invalid credentials" message.
      if (mode === 'login') {
        // checkAuthRateLimit() (called before signInWithPassword above)
        // throws its own clear "Too many attempts" message on an actual
        // rate-limit hit -- previously that was unconditionally discarded
        // below in favor of "Incorrect email or password", which could
        // make a correctly-rate-limited user think their password was
        // wrong and keep retrying (or reset a password that was never the
        // problem) instead of just waiting.
        if (msgL.includes('too many attempts')) {
          setErrorMessage(msg.trim());
          return;
        }
        try {
          let checkEmail = email.trim();
          if (!isValidEmail(checkEmail)) {
            // Try to resolve username to email for the status check
            const { data: resolved } = await supabase.rpc('resolve_username_to_email', { p_username: checkEmail.toLowerCase() });
            if (resolved) checkEmail = resolved;
          }
          if (checkEmail && isValidEmail(checkEmail)) {
            const { data: statusRows } = await supabase.rpc('get_account_status', { p_email: checkEmail });
            const row = Array.isArray(statusRows) ? statusRows[0] : statusRows;
            if (row?.status === 'suspended' || row?.status === 'deleted') {
              setBanInfo({ status: row.status, until: row.banned_until ?? null });
              return;
            }
          }
        } catch { /* ignore status check failure — fall through to normal error */ }
        // Login always shows generic message — never reveal whether email/password is the issue
        setErrorMessage('Incorrect email or password.');
        return;
      }
      // Specific, user-friendly error messages for forgot/reset
      const safe = msgL.includes('email not confirmed') || msgL.includes('not confirmed')
        ? 'Please verify your email before logging in.'
        : msgL.includes('rate limit') || msgL.includes('too many')
        ? 'Too many attempts. Please wait a few minutes and try again.'
        : msgL.includes('network') || msgL.includes('fetch')
        ? 'Network error. Check your connection and try again.'
        : 'Incorrect email/username or password.';
      setErrorMessage(safe);
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async () => {
    if (verificationCode.length !== EMAIL_OTP_LENGTH) return;
    setLoading(true);
    setErrorMessage(null);
    try {
      const { data, error } = await supabase.auth.verifyOtp({
        email: email.trim().toLowerCase(),
        token: verificationCode,
        type: 'signup',
      });
      if (error) throw error;

      if (data?.user) {
        // Cleared AFTER fetchProfileAndSucceed, not before — it reads the
        // persisted signup payload as a fallback when this screen's own
        // component state is blank (a fresh mount reached via the
        // "Verify Account" email link). Clearing first would erase that
        // fallback before it could ever be used.
        const avatarUrl = await uploadAvatarIfPending();
        await fetchProfileAndSucceed(data.user.id, data.user.email!, avatarUrl);
        clearPendingVerification();
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Verification failed. Please check the code and try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleResendCode = async () => {
    if (resending || resendCooldown > 0) return;
    setResending(true);
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      const { error: resendError } = await supabase.auth.resend({
        type: 'signup',
        email: email.trim().toLowerCase(),
        options: { emailRedirectTo: `${window.location.origin}/` },
      });
      if (resendError) throw resendError;
      setSuccessMessage('A new code is on its way — check your inbox.');
      setResendCooldown(30);
    } catch (err: any) {
      setErrorMessage(err.message || 'Could not resend the code. Please try again shortly.');
    } finally {
      setResending(false);
    }
  };

  const handleChangeEmail = () => {
    clearPendingVerification();
    setIsVerifying(false);
    setVerificationCode('');
    setErrorMessage(null);
    setSuccessMessage(null);
    // Leave name/username/phone/etc. filled in — only the email needs to change.
    setEmail('');
  };

  // 3.5: Ban screen
  if (banInfo) {
    const isSuspended = banInfo.status === 'suspended';
    const untilStr = banInfo.until ? new Date(banInfo.until).toLocaleDateString('en-NG', { dateStyle: 'long' }) : null;
    return (
      <div style={{ background: '#020005', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '32px 24px', textAlign: 'center' }}>
        <div style={{ width: '72px', height: '72px', borderRadius: '50%', background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '24px' }}>
          <AlertCircle size={32} color="#EF4444" />
        </div>
        <h2 style={{ color: '#F0F0FF', fontSize: '20px', fontWeight: 800, marginBottom: '12px', fontFamily: 'Space Grotesk, sans-serif' }}>
          {isSuspended ? 'Account Suspended' : 'Account Deleted'}
        </h2>
        <p style={{ color: '#C4C9E0', fontSize: '14px', lineHeight: 1.6, marginBottom: '8px' }}>
          {isSuspended
            ? untilStr
              ? `Your account has been suspended until ${untilStr}.`
              : 'Your account has been permanently suspended.'
            : 'Your account has been removed from VENTS.'}
        </p>
        <p style={{ color: '#8B8FA8', fontSize: '13px', lineHeight: 1.6, marginBottom: '28px' }}>
          If you believe this is a mistake, please reach out to us to appeal.
        </p>
        <div style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '16px', padding: '18px 20px', width: '100%', maxWidth: '320px', display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '24px' }}>
          <a href="https://wa.me/2349030737368" style={{ display: 'flex', alignItems: 'center', gap: '12px', textDecoration: 'none' }}>
            <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: 'rgba(37,211,102,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <span style={{ fontSize: '18px' }}>💬</span>
            </div>
            <div style={{ textAlign: 'left' }}>
              <p style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 600, margin: 0 }}>WhatsApp</p>
              <p style={{ color: '#8B8FA8', fontSize: '12px', margin: 0 }}>+234 903 073 7368</p>
            </div>
          </a>
          <div style={{ height: '1px', background: 'rgba(255,255,255,0.05)' }} />
          <a href="mailto:support@getvents.com" style={{ display: 'flex', alignItems: 'center', gap: '12px', textDecoration: 'none' }}>
            <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: 'rgba(79,70,229,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <span style={{ fontSize: '18px' }}>✉️</span>
            </div>
            <div style={{ textAlign: 'left' }}>
              <p style={{ color: '#F0F0FF', fontSize: '13px', fontWeight: 600, margin: 0 }}>Email</p>
              <p style={{ color: '#8B8FA8', fontSize: '12px', margin: 0 }}>support@getvents.com</p>
            </div>
          </a>
        </div>
        <button onClick={() => setBanInfo(null)} style={{ background: 'none', border: 'none', color: '#A78BFA', fontSize: '13px', cursor: 'pointer' }}>
          ← Back to login
        </button>
      </div>
    );
  }

  // 3.1: TOTP 2FA prompt
  if (totpPending) {
    const handleTotpVerify = async () => {
      setTotpError(null);
      if (totpCode.length !== 6) { setTotpError('Enter the 6-digit code from your authenticator.'); return; }
      const valid = await verifyTOTP(totpPending.secret, totpCode);
      if (valid) {
        setTotpPending(null);
        setTotpCode('');
        analytics.loggedIn('2fa');
        onSuccess(totpPending.profilePayload);
      } else {
        setTotpError('Incorrect code. Try again — codes refresh every 30 seconds.');
        setTotpCode('');
        setTimeout(() => totpInputRef.current?.focus(), 50);
      }
    };
    return (
      <div style={{ background: '#020005', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '32px 24px' }}>
        {/* Themed to the app's purple, not the stock indigo it shipped with. */}
        <div style={{ width: '72px', height: '72px', borderRadius: '50%', background: 'rgba(167,139,250,0.12)', border: '1px solid rgba(167,139,250,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '24px' }}>
          <ShieldCheck size={32} color="#A78BFA" />
        </div>
        <h2 style={{ color: '#F0F0FF', fontSize: '20px', fontWeight: 800, marginBottom: '8px', fontFamily: 'Space Grotesk, sans-serif', textAlign: 'center' }}>
          Two-Factor Authentication
        </h2>
        <p style={{ color: '#8B8FA8', fontSize: '13px', textAlign: 'center', marginBottom: '28px', lineHeight: 1.5 }}>
          Enter the 6-digit code from your authenticator app.
        </p>
        <div style={{ position: 'relative', marginBottom: '8px' }}>
          <div style={{ display: 'flex', gap: '10px', cursor: 'text' }}>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} style={{ width: '44px', height: '54px', background: '#090514', border: `1px solid ${totpCode.length > i ? 'rgba(167,139,250,0.6)' : 'rgba(255,255,255,0.08)'}`, borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ color: '#F0F0FF', fontSize: '22px', fontWeight: 700 }}>{totpCode[i] ?? ''}</span>
              </div>
            ))}
          </div>
          <input
            ref={totpInputRef}
            type="text"
            inputMode="numeric"
            pattern="\d*"
            autoComplete="one-time-code"
            maxLength={6}
            value={totpCode}
            onChange={e => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            onKeyDown={e => e.key === 'Enter' && handleTotpVerify()}
            autoFocus
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, background: 'transparent', border: 'none', outline: 'none', fontSize: '16px', cursor: 'text', caretColor: 'transparent' }}
          />
        </div>
        {totpError && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px', marginBottom: '4px' }}>
            <AlertCircle size={14} color="#EF4444" />
            <span style={{ color: '#EF4444', fontSize: '12px' }}>{totpError}</span>
          </div>
        )}
        <button
          onClick={handleTotpVerify}
          style={{ marginTop: '20px', width: '100%', maxWidth: '320px', background: totpCode.length === 6 ? 'linear-gradient(135deg, #7B2FBE, #4F46E5)' : '#1A1D2E', border: 'none', borderRadius: '14px', padding: '14px', color: totpCode.length === 6 ? '#fff' : '#8B8FA8', fontSize: '15px', fontWeight: 700, cursor: totpCode.length === 6 ? 'pointer' : 'not-allowed' }}
        >
          Verify
        </button>
        <button onClick={() => { setTotpPending(null); setTotpCode(''); }} style={{ marginTop: '14px', background: 'none', border: 'none', color: '#8B8FA8', fontSize: '13px', cursor: 'pointer' }}>
          ← Back
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        background: 'radial-gradient(ellipse at 50% 0%, rgba(123,47,190,0.12) 0%, #050010 40%, #020005 100%)',
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        overscrollBehavior: 'none',
        touchAction: 'pan-y',
      }}
    >
      <style>{`
        ::-webkit-scrollbar { display: none; }
        input::placeholder { color: #94A3B8; }
        input:-webkit-autofill { -webkit-box-shadow: 0 0 0 1000px ${FIELD_BG} inset !important; -webkit-text-fill-color: #FFFFFF !important; }
        .auth-input-row:focus-within { border-color: #7B2FBE !important; }
        .auth-input-field:focus { border-color: #7B2FBE !important; outline: none; }
      `}</style>
      {/* Inner scroll wrapper — keyboard cannot push this screen */}
      <div style={{ height: '100%', overflowY: 'auto', WebkitOverflowScrolling: 'touch' as any, scrollbarWidth: 'none' as any, display: 'flex', flexDirection: 'column' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', padding: 'calc(20px + env(safe-area-inset-top)) 20px 0' }}>
        <button
          onClick={() => {
            if (mode === 'forgot') {
              setMode('login');
              resetForgotFlow();
            } else {
              onBack();
            }
          }}
          style={{
            background: '#090514',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '50%',
            width: '36px',
            height: '36px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          }}
        >
          <ArrowLeft size={16} color="#C4C9E0" />
        </button>
      </div>

      <div style={{ flex: 1, padding: '20px 24px 48px' }}>
        <div style={{ marginBottom: '22px' }}>
          <VentsLogo size={34} />
        </div>

        {mode === 'forgot' && forgotSent && forgotOtpStep && !forgotPasswordStep ? (
          /* ── Step 1: Verification Code ── */
          <div style={{ paddingTop: '20px' }}>
            <div style={{ textAlign: 'center', marginBottom: '24px' }}>
              <div style={{ fontSize: '52px', marginBottom: '16px' }}>🔐</div>
              <h2
                style={{
                  color: '#F0F0FF',
                  fontSize: '22px',
                  fontWeight: 700,
                  fontFamily: 'Space Grotesk, sans-serif',
                  marginBottom: '10px',
                }}
              >
                Enter Verification Code
              </h2>
              <p style={{ color: '#8B8FA8', fontSize: '14px', lineHeight: 1.65 }}>
                We've sent a verification code to{' '}
                <span style={{ color: '#A78BFA' }}>{email}</span>.
              </p>
            </div>

            {errorMessage && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '12px', padding: '12px 16px', marginBottom: '20px' }}>
                <AlertCircle size={18} color="#EF4444" style={{ flexShrink: 0 }} />
                <span style={{ color: '#EF4444', fontSize: '13px', lineHeight: 1.4 }}>{errorMessage}</span>
              </div>
            )}

            {/* Overlay input at inset:0 over the full box row (same pattern as
                the signup OTP screen below) rather than a 1px pointer-events:none
                field relying solely on the wrapper's onClick -- makes every box,
                including the first, directly tappable/focusable, and lets native
                typing/paste/backspace work without any manual per-box logic. */}
            <div style={{ position: 'relative', marginBottom: '20px' }}>
              <div style={{ display: 'flex', justifyContent: 'center', gap: '6px', cursor: 'text' }}>
                {Array.from({ length: EMAIL_OTP_LENGTH }).map((_, i) => (
                  <div
                    key={i}
                    style={{
                      width: '32px', height: '52px', background: FIELD_BG,
                      border: `1.5px solid ${forgotOtpCode.length > i ? '#A78BFA' : 'rgba(255,255,255,0.08)'}`,
                      borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                  >
                    <span style={{ color: '#F0F0FF', fontSize: '17px', fontWeight: 700 }}>{forgotOtpCode[i] ?? ''}</span>
                  </div>
                ))}
              </div>
              <input
                ref={forgotOtpRef}
                type="text"
                inputMode="numeric"
                pattern="\d*"
                autoComplete="one-time-code"
                maxLength={EMAIL_OTP_LENGTH}
                value={forgotOtpCode}
                onChange={(e) => setForgotOtpCode(e.target.value.replace(/\D/g, '').slice(0, EMAIL_OTP_LENGTH))}
                style={{
                  position: 'absolute', inset: 0, width: '100%', height: '100%',
                  opacity: 0, background: 'transparent', border: 'none', outline: 'none',
                  fontSize: '16px', cursor: 'text', caretColor: 'transparent',
                }}
                autoFocus
              />
            </div>

            <button
              onClick={async () => {
                if (forgotOtpCode.length !== EMAIL_OTP_LENGTH) { setErrorMessage(`Please enter the ${EMAIL_OTP_LENGTH}-digit code.`); return; }
                setForgotVerifying(true);
                setErrorMessage(null);
                try {
                  // Validate the code against the backend — this is the ONLY
                  // thing Step 1 does. Unlike InsForge's separate "exchange
                  // code for a reset token" call, Supabase's verifyOtp() IS
                  // the verification step: on success it establishes a
                  // short-lived recovery session on the client directly, and
                  // Step 2's updateUser() call below uses that session
                  // rather than needing an explicit token argument.
                  const { data: verifyData, error: exchangeErr } = await supabase.auth.verifyOtp({
                    email: email.trim().toLowerCase(),
                    token: forgotOtpCode,
                    type: 'recovery',
                  });
                  if (exchangeErr) throw exchangeErr;
                  if (!verifyData?.session) throw new Error('Incorrect or expired code. Please try again.');
                  setForgotExchangedToken('verified');
                  setForgotPasswordStep(true);
                } catch (err: any) {
                  setErrorMessage(err.message || 'Incorrect or expired code. Please try again.');
                } finally {
                  setForgotVerifying(false);
                }
              }}
              disabled={forgotVerifying || forgotOtpCode.length !== EMAIL_OTP_LENGTH}
              style={{
                ...BTN_PRIMARY,
                opacity: (forgotVerifying || forgotOtpCode.length !== EMAIL_OTP_LENGTH) ? 0.6 : 1,
                cursor: (forgotVerifying || forgotOtpCode.length !== EMAIL_OTP_LENGTH) ? 'not-allowed' : 'pointer',
                marginBottom: '16px',
              }}
            >
              {forgotVerifying ? 'Verifying...' : 'Verify Code'}
            </button>
            <button
              onClick={() => { setMode('login'); resetForgotFlow(); }}
              style={{ background: 'none', border: 'none', color: '#8B8FA8', fontSize: '14px', cursor: 'pointer', display: 'block', margin: '0 auto' }}
            >
              Back to Sign In
            </button>
          </div>
        ) : mode === 'forgot' && forgotPasswordStep ? (
          /* ── Step 2: New Password (only reachable after a valid code) ── */
          <div style={{ paddingTop: '20px' }}>
            <div style={{ textAlign: 'center', marginBottom: '24px' }}>
              <div style={{ fontSize: '52px', marginBottom: '16px' }}>🔑</div>
              <h2
                style={{
                  color: '#F0F0FF',
                  fontSize: '22px',
                  fontWeight: 700,
                  fontFamily: 'Space Grotesk, sans-serif',
                  marginBottom: '10px',
                }}
              >
                Set New Password
              </h2>
              <p style={{ color: '#8B8FA8', fontSize: '14px', lineHeight: 1.65 }}>
                Code verified. Choose a new password for your account.
              </p>
            </div>

            {errorMessage && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '12px', padding: '12px 16px', marginBottom: '20px' }}>
                <AlertCircle size={18} color="#EF4444" style={{ flexShrink: 0 }} />
                <span style={{ color: '#EF4444', fontSize: '13px', lineHeight: 1.4 }}>{errorMessage}</span>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '20px' }}>
              <InputRow
                icon={Lock}
                placeholder="New password"
                value={forgotNewPassword}
                onChange={setForgotNewPassword}
                type={showForgotPassword ? 'text' : 'password'}
                right={
                  <button onClick={() => setShowForgotPassword(!showForgotPassword)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                    {showForgotPassword ? <EyeOff size={16} color="#8B8FA8" /> : <Eye size={16} color="#8B8FA8" />}
                  </button>
                }
              />
              <InputRow
                icon={Lock}
                placeholder="Confirm new password"
                value={forgotConfirmPassword}
                onChange={setForgotConfirmPassword}
                type={showForgotPassword ? 'text' : 'password'}
                error={forgotConfirmPassword.length > 0 && forgotNewPassword !== forgotConfirmPassword ? 'Passwords do not match.' : undefined}
              />
            </div>

            <button
              onClick={async () => {
                if (!forgotExchangedToken) { setErrorMessage('Your session expired. Please request a new code.'); return; }
                if (!forgotNewPassword) { setErrorMessage('Password is required.'); return; }
                if (!validatePassword(forgotNewPassword)) { setErrorMessage('Password must be at least 10 characters and include an uppercase letter, a lowercase letter, and a number.'); return; }
                if (forgotNewPassword !== forgotConfirmPassword) { setErrorMessage('Passwords do not match.'); return; }
                setLoading(true);
                setErrorMessage(null);
                try {
                  // Uses the recovery session verifyOtp() established in Step
                  // 1 — no explicit token needed, unlike InsForge's
                  // token-carrying resetPassword() call.
                  const { error } = await supabase.auth.updateUser({ password: forgotNewPassword });
                  if (error) throw error;
                  // The recovery session must not linger as a "signed in"
                  // state after a password reset — the user is about to be
                  // sent to the normal login screen and should authenticate
                  // there like anyone else, not be silently left signed in
                  // under the temporary recovery session.
                  await supabase.auth.signOut().catch(() => {});
                  setSuccessMessage('Password reset successfully! Please sign in.');
                  setMode('login');
                  resetForgotFlow();
                  setPassword('');
                } catch (err: any) {
                  setErrorMessage(err.message || 'Reset failed. Please try again.');
                } finally {
                  setLoading(false);
                }
              }}
              disabled={loading || !forgotNewPassword || forgotNewPassword !== forgotConfirmPassword}
              style={{
                ...BTN_PRIMARY,
                opacity: (loading || !forgotNewPassword || forgotNewPassword !== forgotConfirmPassword) ? 0.6 : 1,
                cursor: (loading || !forgotNewPassword || forgotNewPassword !== forgotConfirmPassword) ? 'not-allowed' : 'pointer',
                marginBottom: '16px',
              }}
            >
              {loading ? 'Resetting...' : 'Reset Password'}
            </button>
            <button
              onClick={() => { setMode('login'); resetForgotFlow(); }}
              style={{ background: 'none', border: 'none', color: '#8B8FA8', fontSize: '14px', cursor: 'pointer', display: 'block', margin: '0 auto' }}
            >
              Back to Sign In
            </button>
          </div>
        ) : isVerifying ? (
          <div style={{ textAlign: 'center', paddingTop: '20px' }}>
            <div style={{ fontSize: '52px', marginBottom: '16px' }}>✉️</div>
            <h2
              style={{
                color: '#F0F0FF',
                fontSize: '22px',
                fontWeight: 700,
                fontFamily: 'Space Grotesk, sans-serif',
                marginBottom: '10px',
              }}
            >
              Verify your email
            </h2>
            <p style={{ color: '#8B8FA8', fontSize: '14px', lineHeight: 1.65, marginBottom: '24px' }}>
              We've sent a {EMAIL_OTP_LENGTH}-digit verification code to<br />
              <span style={{ color: '#A78BFA', fontWeight: 600 }}>{email}</span>
            </p>

            {errorMessage && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  background: 'rgba(239, 68, 68, 0.1)',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  borderRadius: '12px',
                  padding: '12px 16px',
                  marginBottom: '20px',
                  textAlign: 'left',
                }}
              >
                <AlertCircle size={18} color="#EF4444" style={{ flexShrink: 0 }} />
                <span style={{ color: '#EF4444', fontSize: '13px', lineHeight: 1.4 }}>{errorMessage}</span>
              </div>
            )}

            {successMessage && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  background: 'rgba(34, 197, 94, 0.1)',
                  border: '1px solid rgba(34, 197, 94, 0.3)',
                  borderRadius: '12px',
                  padding: '12px 16px',
                  marginBottom: '20px',
                  textAlign: 'left',
                }}
              >
                <Check size={18} color="#22C55E" style={{ flexShrink: 0 }} />
                <span style={{ color: '#22C55E', fontSize: '13px', lineHeight: 1.4 }}>{successMessage}</span>
              </div>
            )}

            {/* The boxes are decoration; the real field is a transparent input
                laid over them. It used to be a 1px, pointer-events:none element
                focused only via this onClick — which meant taps never reached
                it and browsers could refuse focus on a zero-area invisible
                control, so the keyboard never opened. */}
            <div
              style={{ position: 'relative', marginBottom: '24px' }}
            >
            <div
              style={{ display: 'flex', justifyContent: 'center', gap: '6px', cursor: 'text' }}
            >
              {Array.from({ length: EMAIL_OTP_LENGTH }).map((_, i) => (
                <div
                  key={i}
                  style={{
                    width: '32px',
                    height: '52px',
                    background: FIELD_BG,
                    border: `1.5px solid ${
                      verificationCode.length > i
                        ? '#A78BFA'
                        : errorMessage
                        ? 'rgba(239,68,68,0.4)'
                        : 'rgba(255,255,255,0.08)'
                    }`,
                    borderRadius: '12px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <span style={{ color: '#F0F0FF', fontSize: '17px', fontWeight: 700 }}>
                    {verificationCode[i] ?? ''}
                  </span>
                </div>
              ))}
            </div>

            <input
              ref={otpInputRef}
              type="text"
              inputMode="numeric"
              pattern="\d*"
              autoComplete="one-time-code"
              maxLength={EMAIL_OTP_LENGTH}
              value={verificationCode}
              onChange={(e) => {
                const val = e.target.value.replace(/\D/g, '');
                setVerificationCode(val.slice(0, EMAIL_OTP_LENGTH));
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && verificationCode.length === EMAIL_OTP_LENGTH) handleVerifyOtp();
              }}
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                opacity: 0,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                // 16px keeps iOS from zooming the page when the field focuses.
                fontSize: '16px',
                cursor: 'text',
                // Caret would otherwise show at the far left of the overlay.
                caretColor: 'transparent',
              }}
              autoFocus
            />
            </div>

            <button
              onClick={handleVerifyOtp}
              disabled={loading || verificationCode.length !== EMAIL_OTP_LENGTH}
              style={{
                ...BTN_PRIMARY,
                opacity: (loading || verificationCode.length !== EMAIL_OTP_LENGTH) ? 0.6 : 1,
                cursor: loading || verificationCode.length !== EMAIL_OTP_LENGTH ? 'not-allowed' : 'pointer',
                marginBottom: '20px',
              }}
            >
              {loading ? 'Verifying...' : 'Verify Code'}
            </button>

            <button
              onClick={handleResendCode}
              disabled={resending || resendCooldown > 0}
              style={{
                background: 'none',
                border: 'none',
                color: (resending || resendCooldown > 0) ? '#555C7A' : '#A78BFA',
                fontSize: '14px',
                cursor: (resending || resendCooldown > 0) ? 'not-allowed' : 'pointer',
                fontWeight: 600,
                display: 'block',
                margin: '0 auto 14px',
              }}
            >
              {resending ? 'Sending…' : resendCooldown > 0 ? `Resend Code (${resendCooldown}s)` : 'Resend Code'}
            </button>

            <button
              onClick={handleChangeEmail}
              style={{
                background: 'none',
                border: 'none',
                color: '#8B8FA8',
                fontSize: '14px',
                cursor: 'pointer',
                fontWeight: 500,
              }}
            >
              Change Email
            </button>
          </div>
        ) : (
          <>
            {(mode === 'login' || mode === 'signup') && (
              <>
                {/* Segmented Sign Up / Log In tab */}
                <div
                  style={{
                    display: 'flex',
                    background: '#090514',
                    border: '1px solid rgba(255,255,255,0.07)',
                    borderRadius: '100px',
                    padding: '4px',
                    marginBottom: '24px',
                    position: 'relative',
                  }}
                >
                  {(['signup', 'login'] as const).map((tab) => {
                    const active = mode === tab;
                    return (
                      <button
                        key={tab}
                        onClick={() => { setMode(tab); setErrorMessage(null); setSuccessMessage(null); }}
                        style={{
                          flex: 1,
                          padding: '10px',
                          borderRadius: '100px',
                          border: 'none',
                          cursor: 'pointer',
                          background: active ? 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)' : 'transparent',
                          color: active ? '#FFFFFF' : '#94A3B8',
                          fontSize: '14px',
                          fontWeight: 700,
                          fontFamily: 'Space Grotesk, sans-serif',
                          boxShadow: active ? '0 0 20px rgba(123,47,190,0.5)' : 'none',
                          transition: 'background 0.3s ease, box-shadow 0.3s ease, color 0.3s ease',
                        }}
                      >
                        {tab === 'signup' ? 'Sign Up' : 'Log In'}
                      </button>
                    );
                  })}
                </div>

              </>
            )}

            <h2
              style={{
                color: '#FFFFFF',
                fontSize: '24px',
                fontWeight: 700,
                fontFamily: 'Space Grotesk, sans-serif',
                marginBottom: '6px',
              }}
            >
              {mode === 'login' ? 'Welcome Back' : mode === 'signup' ? 'Create Account' : mode === 'forgot' ? 'Forgot Password' : 'Reset Password'}
            </h2>
            <p style={{ color: '#94A3B8', fontSize: '14px', marginBottom: '28px' }}>
              {mode === 'login'
                ? 'Sign in to continue your Vents experience'
                : mode === 'signup'
                ? 'Join thousands of event lovers on Vents'
                : mode === 'forgot'
                ? 'Enter your email to receive a verification code'
                : 'Enter your new password below'}
            </p>

            {mode === 'signup' && signupsDisabled && (
              <div style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: '12px', padding: '12px 14px', marginBottom: '16px' }}>
                <p style={{ margin: 0, color: '#F59E0B', fontSize: '13px', fontWeight: 600 }}>New sign-ups are temporarily paused. Please check back shortly.</p>
              </div>
            )}

            {errorMessage && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  background: 'rgba(239, 68, 68, 0.1)',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  borderRadius: '12px',
                  padding: '12px 16px',
                  marginBottom: '20px',
                }}
              >
                <AlertCircle size={18} color="#EF4444" style={{ flexShrink: 0 }} />
                <span style={{ color: '#EF4444', fontSize: '13px', lineHeight: 1.4 }}>{errorMessage}</span>
              </div>
            )}

            {successMessage && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  background: 'rgba(16, 185, 129, 0.1)',
                  border: '1px solid rgba(16, 185, 129, 0.25)',
                  borderRadius: '12px',
                  padding: '12px 14px',
                  marginBottom: '20px',
                }}
              >
                <Check size={18} color="#10B981" style={{ flexShrink: 0 }} />
                <span style={{ color: '#10B981', fontSize: '13px', lineHeight: 1.4 }}>{successMessage}</span>
              </div>
            )}



            {/* Form fields */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '20px' }}>
              {mode === 'signup' && (
                <>
                  {/* Profile Picture Upload */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: '16px' }}>
                    <div style={{ width: '70px', height: '70px', borderRadius: '20px', background: 'linear-gradient(135deg, #7B2FBE, #4F46E5)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', marginBottom: '8px', boxShadow: '0 6px 20px rgba(123,47,190,0.3)' }}>
                      {signupAvatarPreview || signupAvatarUrl ? (
                        <img src={signupAvatarPreview || signupAvatarUrl} alt="Avatar" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      ) : (
                        <span style={{ color: '#fff', fontSize: '24px', fontWeight: 800 }}>
                          {name ? name.charAt(0).toUpperCase() : '?'}
                        </span>
                      )}
                    </div>
                    <input
                      type="file"
                      ref={signupFileInputRef}
                      onChange={handleUploadSignupAvatar}
                      style={{ display: 'none' }}
                      accept={ALLOWED_AVATAR_TYPES.join(',')}
                    />
                    <button
                      type="button"
                      onClick={openSignupAvatarPicker}
                      disabled={avatarUploading}
                      style={{ background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.2)', borderRadius: '10px', padding: '6px 12px', color: '#A78BFA', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
                    >
                      {avatarUploading ? 'Uploading...' : 'Upload Photo'}
                    </button>
                    {avatarError ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginTop: '6px', maxWidth: '260px' }}>
                        <AlertCircle size={12} color="#EF4444" style={{ flexShrink: 0 }} />
                        <span style={{ color: '#EF4444', fontSize: '11px', textAlign: 'center' }}>{avatarError}</span>
                      </div>
                    ) : (
                      <span style={{ color: '#8B8FA8', fontSize: '10px', marginTop: '6px' }}>
                        JPG, PNG, WebP or GIF · max {formatBytes(MAX_AVATAR_BYTES)}
                      </span>
                    )}
                  </div>

                  <InputRow icon={User} placeholder="Full name" value={name} onChange={setName} onEnter={submitOnEnter} />
                  <InputRow icon={User} placeholder="Username" value={username} onChange={setUsername} onEnter={submitOnEnter} />
                </>
              )}
              {mode !== 'reset' && (
                <div onBlur={handleEmailBlur}>
                  <InputRow
                    icon={Mail}
                    placeholder={mode === 'login' ? "Email address or username" : "Email address (e.g. name@gmail.com)"}
                    value={email}
                    onChange={(v) => { setEmail(v); if (emailTouched) setEmailTouched(true); setSuccessMessage(null); }}
                    type={mode === 'login' ? 'text' : 'email'}
                    error={emailError}
                    onEnter={submitOnEnter}
                  />
                </div>
              )}
              {mode === 'signup' && (
                <PhoneInput
                  countryCode={phoneCountryCode}
                  onCountryCodeChange={handlePhoneCountryChange}
                  value={phone}
                  onChange={setPhone}
                  height={52}
                  background={FIELD_BG}
                  borderColor={FIELD_BORDER}
                  radius={FIELD_RADIUS}
                />
              )}
              {mode === 'signup' && (
                <div style={{ width: '100%', maxWidth: '100%' }}>
                  <label style={{ display: 'block', color: '#94A3B8', fontSize: '12px', fontWeight: 600, marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    DATE OF BIRTH
                  </label>
                  <input
                    type="date"
                    value={dob}
                    max={new Date(Date.now() - 13 * 365.25 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]}
                    onChange={(e) => {
                      const v = e.target.value;
                      setDob(v);
                      if (v) {
                        const age = Math.floor((Date.now() - new Date(v).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
                        setDobError(age < 13 ? 'You must be at least 13 years old.' : null);
                      } else {
                        setDobError(null);
                      }
                    }}
                    className="auth-input-field"
                    style={{
                      width: '100%', maxWidth: '320px', height: '52px', background: FIELD_BG,
                      border: `1px solid ${dobError ? 'rgba(239,68,68,0.6)' : FIELD_BORDER}`,
                      borderRadius: FIELD_RADIUS, padding: '0 16px',
                      color: dob ? '#FFFFFF' : '#94A3B8', fontSize: '15px',
                      outline: 'none', boxSizing: 'border-box',
                      colorScheme: 'dark',
                    }}
                  />
                  {dobError && <p style={{ color: '#EF4444', fontSize: '11px', marginTop: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}>{dobError}</p>}
                </div>
              )}
              {mode !== 'forgot' && (
                <InputRow
                  icon={Lock}
                  placeholder={mode === 'signup' ? "Create password" : mode === 'reset' ? "New password" : "Password"}
                  value={password}
                  onChange={setPassword}
                  type={showPassword ? 'text' : 'password'}
                  error={passwordError}
                  onEnter={submitOnEnter}
                  right={
                    <button
                      onClick={() => setShowPassword(!showPassword)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                    >
                      {showPassword ? <EyeOff size={16} color="#8B8FA8" /> : <Eye size={16} color="#8B8FA8" />}
                    </button>
                  }
                />
              )}
              {(mode === 'signup' || mode === 'reset') && password.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '-4px', padding: '2px 4px' }}>
                  {passwordRules.map(({ met, label }) => (
                    <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      {met ? <Check size={12} color="#10B981" /> : <X size={12} color="#EF4444" />}
                      {/* Unmet rules read as errors, not as neutral hints — grey
                          made a blocking requirement look optional. */}
                      <span style={{ fontSize: '11px', color: met ? '#10B981' : '#EF4444' }}>{label}</span>
                    </div>
                  ))}
                </div>
              )}
              {(mode === 'signup' || mode === 'reset') && (
                <InputRow
                  icon={Lock}
                  placeholder={mode === 'reset' ? "Confirm new password" : "Confirm password"}
                  value={confirmPassword}
                  onChange={setConfirmPassword}
                  type={showPassword ? 'text' : 'password'}
                  error={confirmPasswordError}
                  onEnter={submitOnEnter}
                />
              )}
              {mode === 'signup' && (
                <>
                  
                  {/* State selector — Nigerian users get the existing
                      NIGERIA_STATES picker; every other country falls back
                      to a free-text State/Region field (see
                      isNigeriaSelected above). */}
                  {isNigeriaSelected ? (
                    <div
                      onClick={() => setShowStateDropdown(true)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        background: FIELD_BG,
                        border: `1px solid ${FIELD_BORDER}`,
                        borderRadius: FIELD_RADIUS,
                        padding: '14px 16px',
                        gap: '12px',
                        position: 'relative',
                        cursor: 'pointer',
                      }}
                    >
                      <MapPin size={18} color="#8B8FA8" />
                      <div
                        style={{
                          flex: 1,
                          color: signupState ? '#F0F0FF' : '#8B8FA8',
                          fontSize: '14px',
                          fontFamily: 'Inter, sans-serif',
                          textAlign: 'left',
                        }}
                      >
                        {signupState || 'Select State'}
                      </div>
                      <ChevronDown
                        size={16}
                        color="#8B8FA8"
                        style={{
                          pointerEvents: 'none',
                          position: 'absolute',
                          right: '16px',
                        }}
                      />
                    </div>
                  ) : (
                    <InputRow
                      icon={MapPin}
                      placeholder="State / Region / Province"
                      value={signupState}
                      onChange={setSignupState}
                      onEnter={submitOnEnter}
                    />
                  )}

                  {/* Role picker — hidden if role was pre-selected from RoleSelectScreen */}
                  {!userRole && <div style={{ marginTop: '4px' }}>
                    <label style={{ color: '#8B8FA8', fontSize: '12px', fontWeight: 600, display: 'block', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      Select Role
                    </label>
                    <div style={{ display: 'flex', gap: '10px' }}>
                      {(['attendee', 'organizer'] as const).map((r) => (
                        <button
                          key={r}
                          type="button"
                          onClick={() => setRole(r)}
                          style={{
                            flex: 1,
                            background: role === r ? 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)' : '#131629',
                            border: role === r ? 'none' : '1px solid rgba(255,255,255,0.08)',
                            borderRadius: '12px',
                            padding: '12px',
                            color: '#fff',
                            fontSize: '14px',
                            fontWeight: 700,
                            cursor: 'pointer',
                            boxShadow: role === r ? '0 4px 12px rgba(123,47,190,0.3)' : 'none',
                            transition: 'all 0.2s ease',
                          }}
                        >
                          {r === 'attendee' ? 'Attendee' : 'Organiser'}
                        </button>
                      ))}
                    </div>
                  </div>}
                </>
              )}
            </div>

            {mode === 'login' && (
              <button
                onClick={() => setMode('forgot')}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#C084FC',
                  fontSize: '13px',
                  cursor: 'pointer',
                  marginBottom: '24px',
                  padding: 0,
                  display: 'block',
                }}
              >
                Forgot password?
              </button>
            )}

            <button
              onClick={handleSubmit}
              disabled={loading || !canSubmit}
              style={{
                ...BTN_PRIMARY,
                opacity: (loading || !canSubmit) ? 0.6 : 1,
                cursor: loading || !canSubmit ? 'not-allowed' : 'pointer',
                marginBottom: '20px',
              }}
            >
              {loading
                ? 'Please wait...'
                : mode === 'login'
                ? 'Sign In'
                : mode === 'signup'
                ? 'Create Account'
                : mode === 'forgot'
                ? 'Send Verification Code'
                : 'Reset Password'}
            </button>

            {mode === 'signup' && (
              <div style={{ marginTop: '-8px', marginBottom: '14px' }}>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer' }}>
                  <div
                    onClick={() => setTosAccepted(v => !v)}
                    style={{
                      width: '18px', height: '18px', borderRadius: '5px', flexShrink: 0, marginTop: '1px',
                      border: tosAccepted ? 'none' : '2px solid rgba(123,47,190,0.5)',
                      background: tosAccepted ? '#7B2FBE' : 'transparent',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                    }}
                  >
                    {tosAccepted && <span style={{ color: '#fff', fontSize: '11px', fontWeight: 800, lineHeight: 1 }}>✓</span>}
                  </div>
                  <span style={{ color: '#94A3B8', fontSize: '12px', lineHeight: 1.55 }}>
                    I agree to the{' '}
                    <a href="https://getvents.com/terms" onClick={(e) => { e.preventDefault(); openExternalUrl('https://getvents.com/terms'); }} style={{ color: '#C084FC', textDecoration: 'underline' }}>Terms of Service</a>
                    {' '}and{' '}
                    <a href="https://getvents.com/privacy" onClick={(e) => { e.preventDefault(); openExternalUrl('https://getvents.com/privacy'); }} style={{ color: '#C084FC', textDecoration: 'underline' }}>Privacy Policy</a>.
                    {' '}You must be at least 13 years old to use Vents.
                  </span>
                </label>
              </div>
            )}


            {mode === 'reset' && (
              <p style={{ textAlign: 'center', color: '#8B8FA8', fontSize: '14px' }}>
                <button
                  onClick={() => { setMode('login'); setSuccessMessage(null); }}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#C084FC',
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontSize: '14px',
                    fontFamily: 'Inter, sans-serif',
                  }}
                >
                  Back to Sign In
                </button>
              </p>
            )}

          </>
        )}
      </div>
      
      {showStateDropdown && isNigeriaSelected && (
        <PickerSheet
          title="Select State"
          searchPlaceholder="Search state..."
          value={signupState}
          options={NIGERIA_STATES.map((st) => ({ value: st.name, label: st.name }))}
          onSelect={(v) => {
            setSignupState(v);
            setShowStateDropdown(false);
          }}
          onClose={() => setShowStateDropdown(false)}
        />
      )}

      {cropImageSrc && (
        <ImageCropperModal
          imageSrc={cropImageSrc}
          onCropComplete={handleCropComplete}
          onClose={() => setCropImageSrc((prev) => { if (prev) URL.revokeObjectURL(prev); return null; })}
        />
      )}
      </div>{/* end inner scroll wrapper */}
    </div>
  );
}
