import { useState, useRef } from 'react';
import { ArrowLeft, Eye, EyeOff, Mail, Lock, User, Phone, AlertCircle, MapPin, Search, X, ChevronRight, ChevronDown, Check, ShieldCheck } from 'lucide-react';
import { AuthMode } from './types';
import { VentsLogo } from './VentsLogo';
import { insforge, saveRefreshToken, clearRefreshToken } from '../../lib/insforge';
import { NIGERIA_STATES } from './StateSelectScreen';
import { ImageCropperModal } from './ImageCropperModal';
import { verifyTOTP } from '../../lib/totp';
import { trackEvent } from '../../lib/analytics';
import { validateUsername, validatePassword } from '../../lib/sanitize';
import { signupSchema, loginSchema, firstValidationError } from '../../lib/schemas';

interface AuthScreenProps {
  initialMode: AuthMode;
  userRole?: string;
  selectedState?: string;
  onBack: () => void;
  onSuccess: (userProfile: { id: string; email: string; full_name: string | null; role: string; username?: string; phone_number?: string; state?: string; avatar_url?: string; isOrganizer?: boolean; is_verified?: boolean }) => void;
  resetToken?: string;
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

const BTN_PRIMARY: React.CSSProperties = {
  width: '100%',
  height: '52px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)',
  border: 'none',
  borderRadius: '100px',
  padding: '0 24px',
  color: '#fff',
  fontSize: '16px',
  fontWeight: 700,
  fontFamily: 'Space Grotesk, sans-serif',
  cursor: 'pointer',
  boxShadow: '0 8px 24px rgba(123,47,190,0.35)',
};

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
}: {
  icon: React.ElementType;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  right?: React.ReactNode;
  error?: string;
}) {
  return (
    <div>
      <div
        className="auth-input-row"
        style={{
          display: 'flex',
          alignItems: 'center',
          background: '#090514',
          border: `1px solid ${error ? 'rgba(239,68,68,0.5)' : 'rgba(255,255,255,0.1)'}`,
          borderRadius: '16px',
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

export function AuthScreen({ initialMode, userRole, selectedState, onBack, onSuccess, resetToken }: AuthScreenProps) {
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
  const [stateSearchQuery, setStateSearchQuery] = useState('');
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [phone, setPhone] = useState('+234');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const [emailTouched, setEmailTouched] = useState(false);

  const [isVerifying, setIsVerifying] = useState(false);
  const [verificationCode, setVerificationCode] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

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

  const handleUploadSignupAvatar = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErrorMessage(null);
    setCropImageSrc(URL.createObjectURL(file));
  };

  const handleCropComplete = (croppedBlob: Blob) => {
    const croppedFile = new File([croppedBlob], 'avatar.jpg', { type: 'image/jpeg' });
    setSignupAvatarFile(croppedFile);
    setSignupAvatarPreview(URL.createObjectURL(croppedBlob));
    setCropImageSrc(null);
  };

  const uploadAvatarIfPending = async (): Promise<string> => {
    if (!signupAvatarFile) return signupAvatarUrl;
    setAvatarUploading(true);
    try {
      const { data, error } = await insforge.storage.from('avatars').uploadAuto(signupAvatarFile);
      if (error) throw error;
      if (data?.url) {
        setSignupAvatarUrl(data.url);
        setSignupAvatarKey(data.key);
        return data.url;
      }
    } catch (err: any) {
      console.error("Failed to upload avatar:", err);
      setErrorMessage(err.message || "Failed to upload photo. Proceeding without avatar.");
    } finally {
      setAvatarUploading(false);
    }
    return '';
  };

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
      ? (email.length > 0 &&
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

  const fetchProfileAndSucceed = async (userId: string, userEmail: string, avatarUrl?: string) => {
    for (let i = 0; i < 20; i++) {
      const { data: profile } = await insforge.database
        .from('users')
        .select('*')
        .eq('id', userId)
        .maybeSingle();

      if (profile) {
        const strictRole = role === 'organizer' ? 'organizer' : 'attendee';
        const payload: Record<string, any> = {
          full_name: name.trim(),
          username: username.trim().toLowerCase(),
          phone_number: phone.trim(),
          state: (signupState || selectedState || '').trim(),
          role: strictRole,
          avatar_url: avatarUrl || signupAvatarUrl
        };
        if (dob) payload.date_of_birth = dob;

        await insforge.database.from('users').update(payload).eq('id', userId);

        const { data: verifiedProfile } = await insforge.database
          .from('users')
          .select('*')
          .eq('id', userId)
          .maybeSingle();

        const finalProfile = verifiedProfile || profile;

        // Apply referral code if user signed up via ?ref= link
        const pendingRef = sessionStorage.getItem('vents_ref_code');
        if (pendingRef) {
          sessionStorage.removeItem('vents_ref_code');
          insforge.database.rpc('complete_referral' as any, { p_referrer_code: pendingRef }).catch(() => {});
        }

        onSuccess({
          id: userId,
          email: userEmail,
          full_name: finalProfile.full_name || payload.full_name,
          role: strictRole, 
          username: finalProfile.username || payload.username,
          phone_number: finalProfile.phone_number || payload.phone_number,
          state: finalProfile.state || payload.state,
          avatar_url: finalProfile.avatar_url || payload.avatar_url,
          isOrganizer: strictRole === 'organizer',
          is_verified: finalProfile.is_verified === true,
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
        const { error } = await insforge.auth.sendResetPasswordEmail({
          email: email.trim().toLowerCase(),
        });
        if (error) throw error;
        setForgotSent(true);
        setForgotOtpStep(true);

      } else if (mode === 'reset') {
        if (!password) throw new Error('Password is required.');
        if (password !== confirmPassword) throw new Error('Passwords do not match.');
        if (!resetToken) throw new Error('Reset token is missing or invalid. Please request a new link.');
        
        const { error } = await insforge.auth.resetPassword({
          newPassword: password,
          otp: resetToken
        });
        if (error) throw error;
        
        setSuccessMessage('Password reset successfully! Please sign in with your new password.');
        setMode('login');
        setPassword('');
        setConfirmPassword('');
      } else if (mode === 'signup') {
        if (!name.trim()) throw new Error('Full name is required.');
        if (!username.trim()) throw new Error('Username is required.');
        if (!validateUsername(username.trim())) throw new Error('Username must be 3-30 characters, letters numbers and underscores only.');
        if (!email.trim() || !isValidEmail(email)) throw new Error('Please enter a valid email address.');
        if (!phone.trim()) throw new Error('Phone number is required.');
        const rawDigits = phone.replace(/\D/g, '');
        const normalizedPhone = rawDigits.startsWith('234') ? '+' + rawDigits : rawDigits.startsWith('0') ? '+234' + rawDigits.slice(1) : '+234' + rawDigits;
        const NIGERIAN_PHONE_REGEX = /^\+234[789][01]\d{8}$/;
        if (!NIGERIAN_PHONE_REGEX.test(normalizedPhone)) {
          throw new Error('Please enter a valid Nigerian phone number (+234 format).');
        }
        if (!password) throw new Error('Password is required.');
        if (!validatePassword(password)) throw new Error('Password must be at least 8 characters.');
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
        const { data: deletedRow } = await insforge.database
          .from('deleted_emails')
          .select('email')
          .eq('email', email.trim().toLowerCase())
          .maybeSingle();
        if (deletedRow) {
          throw new Error('This email address was used on a deleted account and cannot be re-registered. Contact support@getvents.com if you believe this is an error.');
        }

        // Block re-signup with a previously deleted phone number
        if (normalizedPhone) {
          const { data: deletedPhoneRow } = await insforge.database
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

        const { data: existsResult, error: lookupError } = await insforge.database.rpc('check_user_exists', {
          p_email: normalizedEmail,
          p_phone: normalizedPhone,
          p_username: normalizedUsername,
        });
        if (lookupError) throw lookupError;
        if (existsResult?.email_taken) throw new Error('Email already exists');
        if (existsResult?.phone_taken) throw new Error('Phone number already exists');
        if (existsResult?.username_taken) throw new Error('Username already exists');

        const { data, error } = await insforge.auth.signUp({ email: normalizedEmail, password });
        if (error) throw error;

        // InsForge does not support raw_user_meta_data in signUp options.
        // Write profile fields directly to the users table after auth record is created.
        if (data?.user?.id) {
          await insforge.database.from('users').upsert({
            id: data.user.id,
            email: normalizedEmail,
            full_name: userMetaPayload.full_name,
            username: userMetaPayload.username,
            phone_number: userMetaPayload.phone_number,
            state: userMetaPayload.state,
            role: userMetaPayload.role,
            avatar_url: userMetaPayload.avatar_url || null,
          }, { onConflict: 'id' }).catch((e: any) => console.warn('Profile upsert after signup:', e?.message));
        }

        // Persist refresh token immediately after signup so session survives reload.
        // The SDK sets hc.refreshToken internally — also check data for it.
        {
          const signupRt = (data as any)?.refreshToken || (data as any)?.refresh_token;
          const hcNow = (insforge as any).getHttpClient?.();
          const rtToSave = signupRt || hcNow?.refreshToken;
          if (rtToSave) saveRefreshToken(rtToSave);
        }

        if (data?.requireEmailVerification) {
          trackEvent('user_signed_up', { role: strictRole });
          setIsVerifying(true);
        } else if (data?.accessToken && data?.user) {
          trackEvent('user_signed_up', { role: strictRole });
          const avatarUrl = await uploadAvatarIfPending();
          await fetchProfileAndSucceed(data.user.id, data.user.email, avatarUrl);
        }

      } else if (mode === 'login') {
        // Boundary-layer schema validation — rejects malformed/malicious
        // payloads before any DB call is made.
        const loginCheck = loginSchema.safeParse({ identifier: email.trim(), password });
        if (!loginCheck.success) throw new Error(firstValidationError(loginCheck));

        let loginEmail = email.trim();
        if (!isValidEmail(loginEmail)) {
          // Clear any stale token so anon key is used for this unauthenticated lookup
          (insforge as any).getHttpClient().userToken = null;
          const { data: resolvedEmail, error: resolveError } = await insforge.database.rpc('resolve_username_to_email', { p_username: loginEmail.toLowerCase() });
          if (resolveError) throw resolveError;
          if (!resolvedEmail) throw new Error('No account found with this username.');
          loginEmail = resolvedEmail;
        }

        // Use mobile client_type to get refresh token in response body (works cross-origin on localhost).
        const baseUrl = (insforge as any).getHttpClient?.().baseUrl || import.meta.env.VITE_INSFORGE_URL;
        const loginRes = await fetch(`${baseUrl}/api/auth/sessions?client_type=mobile`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: loginEmail, password }),
        });
        const loginJson = await loginRes.json();
        if (!loginRes.ok || loginJson.error) {
          throw new Error(loginJson.message || loginJson.error || 'Invalid email or password.');
        }
        // Save refresh token for session persistence across reloads.
        // API may return camelCase OR snake_case — check both.
        const rt = loginJson.refreshToken || loginJson.refresh_token;
        const hc = (insforge as any).getHttpClient?.();
        if (rt) {
          if (hc) hc.refreshToken = rt;
          saveRefreshToken(rt);
        }
        if (loginJson.accessToken || loginJson.access_token) {
          const at = loginJson.accessToken || loginJson.access_token;
          if (hc) hc.userToken = at;
        }
        const data = loginJson;
        const error = null;

        if (data?.user) {
          const { data: profile } = await insforge.database.from('users').select('*').eq('id', data.user.id).maybeSingle();

          // 3.5: Block banned / deleted accounts immediately after auth
          if (profile?.status === 'suspended' || profile?.status === 'deleted') {
            await insforge.auth.signOut().catch(() => {});
            clearRefreshToken();
            setBanInfo({ status: profile.status, until: profile.banned_until ?? null });
            setLoading(false);
            return;
          }

          const dbRole = (profile?.role === 'admin') ? 'admin' : (profile?.role === 'organizer' || profile?.role === 'organiser') ? 'organizer' : 'attendee';
          const profilePayload = {
            id: data.user.id,
            email: data.user.email,
            full_name: profile?.full_name || data.user.user_metadata?.full_name || data.user.email.split('@')[0],
            role: dbRole,
            username: profile?.username || data.user.user_metadata?.username,
            phone_number: profile?.phone_number || data.user.user_metadata?.phone_number,
            state: profile?.state || data.user.user_metadata?.state,
            avatar_url: profile?.avatar_url || data.user.user_metadata?.avatar_url,
            isOrganizer: dbRole === 'organizer',
            is_verified: profile?.is_verified === true,
          };

          // 3.1: If TOTP is enabled, show the 2FA prompt before completing login
          if (profile?.totp_enabled && profile?.totp_secret) {
            setTotpPending({ secret: profile.totp_secret, profilePayload });
            setTimeout(() => totpInputRef.current?.focus(), 100);
            setLoading(false);
            return;
          }

          localStorage.removeItem('auth_attempts');
          onSuccess(profilePayload);
        }
      }
    } catch (err: any) {
      // Increment rate-limit counter on auth failure
      if (mode === 'login' || mode === 'signup') {
        const stored = JSON.parse(localStorage.getItem('auth_attempts') || '{"count":0,"timestamp":0}');
        localStorage.setItem('auth_attempts', JSON.stringify({ count: stored.count + 1, timestamp: Date.now() }));
      }
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
          ? 'Password is too weak. Use at least 8 characters with letters and numbers.'
          : msgL.includes('rate limit') || msgL.includes('too many')
          ? 'Too many attempts. Please wait a few minutes and try again.'
          : msgL.includes('network') || msgL.includes('fetch')
          ? 'Network error. Check your connection and try again.'
          : 'Signup failed. Please check your details and try again.';
        setErrorMessage(safe);
        return;
      }

      // On login failure, check if the account is suspended/deleted so we can
      // show the ban screen instead of a generic "Invalid credentials" message.
      if (mode === 'login') {
        try {
          let checkEmail = email.trim();
          if (!isValidEmail(checkEmail)) {
            // Try to resolve username to email for the status check
            const { data: resolved } = await insforge.database.rpc('resolve_username_to_email', { p_username: checkEmail.toLowerCase() });
            if (resolved) checkEmail = resolved;
          }
          if (checkEmail && isValidEmail(checkEmail)) {
            const { data: statusRows } = await insforge.database.rpc('get_account_status', { p_email: checkEmail });
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
    if (verificationCode.length !== 6) return;
    setLoading(true);
    setErrorMessage(null);
    try {
      const { data, error } = await insforge.auth.verifyEmail({
        email: email.trim().toLowerCase(),
        otp: verificationCode
      });
      if (error) throw error;

      if (data?.user) {
        const avatarUrl = await uploadAvatarIfPending();
        await fetchProfileAndSucceed(data.user.id, data.user.email, avatarUrl);
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Verification failed. Please check the code and try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setGoogleLoading(true);
    setErrorMessage(null);
    try {
      await insforge.auth.signInWithOAuth('google', {
        redirectTo: window.location.origin
      });
    } catch (err: any) {
      setErrorMessage(err.message || 'OAuth sign in failed.');
      setGoogleLoading(false);
    }
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
        onSuccess(totpPending.profilePayload);
      } else {
        setTotpError('Incorrect code. Try again — codes refresh every 30 seconds.');
        setTotpCode('');
        setTimeout(() => totpInputRef.current?.focus(), 50);
      }
    };
    return (
      <div style={{ background: '#020005', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '32px 24px' }}>
        <div style={{ width: '72px', height: '72px', borderRadius: '50%', background: 'rgba(79,70,229,0.12)', border: '1px solid rgba(79,70,229,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '24px' }}>
          <ShieldCheck size={32} color="#818CF8" />
        </div>
        <h2 style={{ color: '#F0F0FF', fontSize: '20px', fontWeight: 800, marginBottom: '8px', fontFamily: 'Space Grotesk, sans-serif', textAlign: 'center' }}>
          Two-Factor Authentication
        </h2>
        <p style={{ color: '#8B8FA8', fontSize: '13px', textAlign: 'center', marginBottom: '28px', lineHeight: 1.5 }}>
          Enter the 6-digit code from your authenticator app.
        </p>
        <div style={{ display: 'flex', gap: '10px', marginBottom: '8px' }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} style={{ width: '44px', height: '54px', background: '#090514', border: `1px solid ${totpCode.length > i ? 'rgba(129,140,248,0.6)' : 'rgba(255,255,255,0.08)'}`, borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => totpInputRef.current?.focus()}>
              <span style={{ color: '#F0F0FF', fontSize: '22px', fontWeight: 700 }}>{totpCode[i] ?? ''}</span>
            </div>
          ))}
        </div>
        <input
          ref={totpInputRef}
          type="tel"
          inputMode="numeric"
          maxLength={6}
          value={totpCode}
          onChange={e => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          onKeyDown={e => e.key === 'Enter' && handleTotpVerify()}
          autoFocus
          style={{ position: 'absolute', opacity: 0, width: '1px', height: '1px', pointerEvents: 'none' }}
        />
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
        input:-webkit-autofill { -webkit-box-shadow: 0 0 0 1000px #090514 inset !important; -webkit-text-fill-color: #FFFFFF !important; }
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

            <div
              onClick={() => forgotOtpRef.current?.focus()}
              style={{ display: 'flex', justifyContent: 'center', gap: '8px', marginBottom: '20px', cursor: 'text' }}
            >
              {Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  style={{
                    width: '42px', height: '52px', background: '#090514',
                    border: `1.5px solid ${forgotOtpCode.length > i ? '#A78BFA' : 'rgba(255,255,255,0.08)'}`,
                    borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  <span style={{ color: '#F0F0FF', fontSize: '20px', fontWeight: 700 }}>{forgotOtpCode[i] ?? ''}</span>
                </div>
              ))}
            </div>
            <input
              ref={forgotOtpRef}
              type="text"
              pattern="\d*"
              maxLength={6}
              value={forgotOtpCode}
              onChange={(e) => setForgotOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              style={{ position: 'absolute', opacity: 0, width: '1px', height: '1px', pointerEvents: 'none' }}
              autoFocus
            />

            <button
              onClick={async () => {
                if (forgotOtpCode.length !== 6) { setErrorMessage('Please enter the 6-digit code.'); return; }
                setForgotVerifying(true);
                setErrorMessage(null);
                try {
                  // Validate the code against the backend and exchange it for a
                  // reset token — this is the ONLY thing Step 1 does.
                  const { data: tokenData, error: exchangeErr } = await insforge.auth.exchangeResetPasswordToken({
                    email: email.trim().toLowerCase(),
                    code: forgotOtpCode,
                  });
                  if (exchangeErr) throw exchangeErr;
                  const resetOtp = tokenData?.token;
                  if (!resetOtp) throw new Error('Incorrect or expired code. Please try again.');
                  setForgotExchangedToken(resetOtp);
                  setForgotPasswordStep(true);
                } catch (err: any) {
                  setErrorMessage(err.message || 'Incorrect or expired code. Please try again.');
                } finally {
                  setForgotVerifying(false);
                }
              }}
              disabled={forgotVerifying || forgotOtpCode.length !== 6}
              style={{
                ...BTN_PRIMARY,
                opacity: (forgotVerifying || forgotOtpCode.length !== 6) ? 0.6 : 1,
                cursor: (forgotVerifying || forgotOtpCode.length !== 6) ? 'not-allowed' : 'pointer',
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
              />
            </div>

            <button
              onClick={async () => {
                if (!forgotExchangedToken) { setErrorMessage('Your session expired. Please request a new code.'); return; }
                if (!forgotNewPassword) { setErrorMessage('Password is required.'); return; }
                if (forgotNewPassword !== forgotConfirmPassword) { setErrorMessage('Passwords do not match.'); return; }
                setLoading(true);
                setErrorMessage(null);
                try {
                  const { error } = await insforge.auth.resetPassword({ newPassword: forgotNewPassword, otp: forgotExchangedToken });
                  if (error) throw error;
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
              We've sent a 6-digit verification code to<br />
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

            <div 
              onClick={() => otpInputRef.current?.focus()}
              style={{ display: 'flex', justifyContent: 'center', gap: '8px', marginBottom: '24px', cursor: 'text' }}
            >
              {Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  style={{
                    width: '42px',
                    height: '52px',
                    background: '#090514',
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
                  <span style={{ color: '#F0F0FF', fontSize: '20px', fontWeight: 700 }}>
                    {verificationCode[i] ?? ''}
                  </span>
                </div>
              ))}
            </div>

            <input
              ref={otpInputRef}
              type="text"
              pattern="\d*"
              maxLength={6}
              value={verificationCode}
              onChange={(e) => {
                const val = e.target.value.replace(/\D/g, '');
                setVerificationCode(val.slice(0, 6));
              }}
              style={{
                position: 'absolute',
                opacity: 0,
                width: '1px',
                height: '1px',
                pointerEvents: 'none',
              }}
              autoFocus
            />

            <button
              onClick={handleVerifyOtp}
              disabled={loading || verificationCode.length !== 6}
              style={{
                ...BTN_PRIMARY,
                opacity: (loading || verificationCode.length !== 6) ? 0.6 : 1,
                cursor: loading || verificationCode.length !== 6 ? 'not-allowed' : 'pointer',
                marginBottom: '20px',
              }}
            >
              {loading ? 'Verifying...' : 'Verify Code'}
            </button>

            <button
              onClick={() => {
                setIsVerifying(false);
                setVerificationCode('');
                setErrorMessage(null);
              }}
              style={{
                background: 'none',
                border: 'none',
                color: '#8B8FA8',
                fontSize: '14px',
                cursor: 'pointer',
                fontWeight: 500,
              }}
            >
              Back to Sign Up
            </button>
          </div>
        ) : (
          <>
            <h2
              style={{
                color: '#FFFFFF',
                fontSize: '24px',
                fontWeight: 700,
                fontFamily: 'Outfit, sans-serif',
                marginBottom: '6px',
              }}
            >
              {mode === 'login' ? 'Welcome back' : mode === 'signup' ? 'Create account' : mode === 'forgot' ? 'Forgot Password' : 'Reset Password'}
            </h2>
            <p style={{ color: '#94A3B8', fontSize: '14px', marginBottom: '28px' }}>
              {mode === 'login'
                ? 'Sign in to your VENTS account'
                : mode === 'signup'
                ? (role === 'organizer'
                    ? 'Create and manage your events, sell tickets, and grow your audience'
                    : 'Join thousands discovering Nigerian events')
                : mode === 'forgot'
                ? 'Enter your email to receive a verification code'
                : 'Enter your new password below'}
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
                      accept="image/*"
                    />
                    <button
                      type="button"
                      onClick={() => signupFileInputRef.current?.click()}
                      disabled={avatarUploading}
                      style={{ background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.2)', borderRadius: '10px', padding: '6px 12px', color: '#A78BFA', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}
                    >
                      {avatarUploading ? 'Uploading...' : 'Upload Photo'}
                    </button>
                  </div>

                  <InputRow icon={User} placeholder="Full name" value={name} onChange={setName} />
                  <InputRow icon={User} placeholder="Username" value={username} onChange={setUsername} />
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
                  />
                </div>
              )}
              {mode === 'signup' && (
                <InputRow
                  icon={Phone}
                  placeholder="+234 801 234 5678"
                  value={phone}
                  onChange={(v) => {
                    let raw = v.replace(/\D/g, '');
                    if (raw.startsWith('234')) raw = raw.slice(3);
                    else if (raw.startsWith('0')) raw = raw.slice(1);
                    raw = raw.slice(0, 10);
                    let formatted = '+234';
                    if (raw.length > 0) formatted += ' ' + raw.slice(0, 3);
                    if (raw.length > 3) formatted += ' ' + raw.slice(3, 7);
                    if (raw.length > 7) formatted += ' ' + raw.slice(7);
                    setPhone(raw.length === 0 ? '' : formatted);
                  }}
                  type="tel"
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
                      width: '100%', maxWidth: '320px', height: '52px', background: '#090514',
                      border: `1px solid ${dobError ? 'rgba(239,68,68,0.5)' : 'rgba(255,255,255,0.1)'}`,
                      borderRadius: '16px', padding: '0 16px',
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
              {(mode === 'signup' || mode === 'reset') && (
                <InputRow
                  icon={Lock}
                  placeholder={mode === 'reset' ? "Confirm new password" : "Confirm password"}
                  value={confirmPassword}
                  onChange={setConfirmPassword}
                  type={showPassword ? 'text' : 'password'}
                />
              )}
              {mode === 'signup' && (
                <>
                  
                  {/* State selector */}
                  <div
                    onClick={() => setShowStateDropdown(true)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      background: '#090514',
                      border: '1px solid rgba(255,255,255,0.08)',
                      borderRadius: '14px',
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
                    <a href="https://getvents.com/terms" target="_blank" rel="noopener noreferrer" style={{ color: '#C084FC', textDecoration: 'underline' }}>Terms of Service</a>
                    {' '}and{' '}
                    <a href="https://getvents.com/privacy" target="_blank" rel="noopener noreferrer" style={{ color: '#C084FC', textDecoration: 'underline' }}>Privacy Policy</a>.
                    {' '}You must be at least 13 years old to use Vents.
                  </span>
                </label>
              </div>
            )}

            {mode !== 'forgot' && mode !== 'reset' && (
              <p style={{ textAlign: 'center', color: '#8B8FA8', fontSize: '14px' }}>
                {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
                <button
                  onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setSuccessMessage(null); }}
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
                  {mode === 'login' ? 'Sign Up' : 'Sign In'}
                </button>
              </p>
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
      
      {showStateDropdown && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: '#020005',
            zIndex: 100,
            display: 'flex',
            flexDirection: 'column',
            padding: 'calc(20px + env(safe-area-inset-top)) 24px 40px',
          }}
        >
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
            <h3 style={{ color: '#F0F0FF', fontSize: '18px', fontWeight: 800, fontFamily: 'Space Grotesk, sans-serif' }}>
              Select State
            </h3>
            <button
              onClick={() => {
                setShowStateDropdown(false);
                setStateSearchQuery('');
              }}
              style={{ background: '#090514', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '50%', width: '32px', height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
            >
              <X size={16} color="#C4C9E0" />
            </button>
          </div>

          {/* Search bar */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              background: '#090514',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '14px',
              padding: '12px 16px',
              gap: '12px',
              marginBottom: '16px',
            }}
          >
            <Search size={18} color="#8B8FA8" />
            <input
              type="text"
              placeholder="Search state..."
              value={stateSearchQuery}
              onChange={(e) => setStateSearchQuery(e.target.value)}
              style={{
                flex: 1,
                background: 'none',
                border: 'none',
                outline: 'none',
                color: '#F0F0FF',
                fontSize: '14px',
                fontFamily: 'Inter, sans-serif',
              }}
              autoFocus
            />
          </div>

          {/* States list */}
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px', scrollbarWidth: 'none' }}>
            {NIGERIA_STATES.filter(s => s.name.toLowerCase().includes(stateSearchQuery.toLowerCase())).map((st) => {
              const isSelected = signupState === st.name;
              return (
                <div
                  key={st.name}
                  onClick={() => {
                    setSignupState(st.name);
                    setShowStateDropdown(false);
                    setStateSearchQuery('');
                  }}
                  style={{
                    background: isSelected ? 'rgba(168,85,247,0.12)' : '#131629',
                    border: isSelected ? '1.5px solid rgba(168,85,247,0.45)' : '1px solid rgba(255,255,255,0.06)',
                    borderRadius: '12px',
                    padding: '14px 16px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    cursor: 'pointer',
                    color: '#F0F0FF',
                    fontSize: '14px',
                    fontWeight: isSelected ? 700 : 500,
                  }}
                >
                  <span>{st.name}</span>
                  {isSelected && <Check size={16} color="#A855F7" />}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {cropImageSrc && (
        <ImageCropperModal
          imageSrc={cropImageSrc}
          onCropComplete={handleCropComplete}
          onClose={() => setCropImageSrc(null)}
        />
      )}
      </div>{/* end inner scroll wrapper */}
    </div>
  );
}
