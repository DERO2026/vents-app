import { useState, useRef } from 'react';
import { ArrowLeft, Eye, EyeOff, Mail, Lock, User, Phone, AlertCircle, MapPin, Search, X, ChevronRight, ChevronDown, Check } from 'lucide-react';
import { AuthMode } from './types';
import { VentsLogo } from './VentsLogo';
import { insforge, saveRefreshToken } from '../../lib/insforge';
import { NIGERIA_STATES } from './StateSelectScreen';
import { ImageCropperModal } from './ImageCropperModal';

interface AuthScreenProps {
  initialMode: AuthMode;
  userRole?: string;
  selectedState?: string;
  onBack: () => void;
  onSuccess: (userProfile: { id: string; email: string; full_name: string | null; role: string; username?: string; phone_number?: string; state?: string; avatar_url?: string; isOrganizer?: boolean }) => void;
  resetToken?: string;
}

const INPUT_STYLE: React.CSSProperties = {
  flex: 1,
  background: 'none',
  border: 'none',
  outline: 'none',
  color: '#F0F0FF',
  fontSize: '14px',
  fontFamily: 'Inter, sans-serif',
};

const BTN_PRIMARY: React.CSSProperties = {
  width: '100%',
  background: 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)',
  border: 'none',
  borderRadius: '16px',
  padding: '16px',
  color: '#fff',
  fontSize: '16px',
  fontWeight: 700,
  fontFamily: 'Space Grotesk, sans-serif',
  cursor: 'pointer',
  boxShadow: '0 8px 32px rgba(123,47,190,0.4), 0 0 0 1px rgba(168,85,247,0.4), 0 0 24px rgba(168,85,247,0.3)',
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
        style={{
          display: 'flex',
          alignItems: 'center',
          background: '#131629',
          border: `1px solid ${error ? 'rgba(239,68,68,0.5)' : 'rgba(255,255,255,0.08)'}`,
          borderRadius: '14px',
          padding: '14px 16px',
          gap: '12px',
        }}
      >
        <Icon size={18} color={error ? '#EF4444' : '#8B8FA8'} />
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
  const [role, setRole] = useState<'attendee' | 'organizer' | null>(null);
  const [showStateDropdown, setShowStateDropdown] = useState(false);
  const [stateSearchQuery, setStateSearchQuery] = useState('');
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const [emailTouched, setEmailTouched] = useState(false);

  const [isVerifying, setIsVerifying] = useState(false);
  const [verificationCode, setVerificationCode] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Forgot-password OTP step (after code is sent)
  const [forgotOtpStep, setForgotOtpStep] = useState(false);
  const [forgotOtpCode, setForgotOtpCode] = useState('');
  const [forgotNewPassword, setForgotNewPassword] = useState('');
  const [forgotConfirmPassword, setForgotConfirmPassword] = useState('');
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const forgotOtpRef = useRef<HTMLInputElement>(null);


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
         !!role)
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
        const payload = {
          full_name: name.trim(),
          username: username.trim().toLowerCase(),
          phone_number: phone.trim(),
          state: (signupState || selectedState || '').trim(),
          role: strictRole,
          avatar_url: avatarUrl || signupAvatarUrl
        };

        await insforge.database.from('users').update(payload).eq('id', userId);

        const { data: verifiedProfile } = await insforge.database
          .from('users')
          .select('*')
          .eq('id', userId)
          .maybeSingle();

        const finalProfile = verifiedProfile || profile;
        
        onSuccess({
          id: userId,
          email: userEmail,
          full_name: finalProfile.full_name || payload.full_name,
          role: strictRole, 
          username: finalProfile.username || payload.username,
          phone_number: finalProfile.phone_number || payload.phone_number,
          state: finalProfile.state || payload.state,
          avatar_url: finalProfile.avatar_url || payload.avatar_url,
          isOrganizer: strictRole === 'organizer'
        });
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error("User profile creation is taking longer than expected. Please try signing in.");
  };

  const handleSubmit = async () => {
    setEmailTouched(true);
    setErrorMessage(null);
    // reset mode doesn't use the email field — skip the email validation gate
    if (mode !== 'reset' && !isEmailOrUsernameValid(email)) return;
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
        if (!email.trim() || !isValidEmail(email)) throw new Error('Please enter a valid email address.');
        if (!phone.trim()) throw new Error('Phone number is required.');
        const rawDigits = phone.replace(/\D/g, '');
        const normalizedPhone = rawDigits.startsWith('234') ? '+' + rawDigits : rawDigits.startsWith('0') ? '+234' + rawDigits.slice(1) : '+234' + rawDigits;
        const NIGERIAN_PHONE_REGEX = /^\+234[789][01]\d{8}$/;
        if (!NIGERIAN_PHONE_REGEX.test(normalizedPhone)) {
          throw new Error('Please enter a valid Nigerian phone number (+234 format).');
        }
        if (!password) throw new Error('Password is required.');
        if (password !== confirmPassword) throw new Error('Passwords do not match.');
        if (!signupState && !selectedState) throw new Error('State is required.');
        if (!role) throw new Error('Role is required.');

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

        const { data, error } = await insforge.auth.signUp({
          email,
          password,
          options: { data: userMetaPayload }
        });
        if (error) throw error;

        if (data?.requireEmailVerification) {
          setIsVerifying(true);
        } else if (data?.accessToken && data?.user) {
          const avatarUrl = await uploadAvatarIfPending();
          await fetchProfileAndSucceed(data.user.id, data.user.email, avatarUrl);
        }

      } else if (mode === 'login') {
        let loginEmail = email.trim();
        if (!isValidEmail(loginEmail)) {
          // Clear any stale token so anon key is used for this unauthenticated lookup
          (insforge as any).getHttpClient().userToken = null;
          const { data: resolvedEmail, error: resolveError } = await insforge.database.rpc('resolve_username_to_email', { p_username: loginEmail.toLowerCase() });
          console.log('[auth] resolve_username_to_email:', { resolvedEmail, resolveError });
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
        // Save refresh token for session persistence across reloads
        if (loginJson.refreshToken) {
          const hc = (insforge as any).getHttpClient?.();
          if (hc) hc.refreshToken = loginJson.refreshToken;
          saveRefreshToken(loginJson.refreshToken);
        }
        if (loginJson.accessToken) {
          const hc = (insforge as any).getHttpClient?.();
          if (hc) hc.userToken = loginJson.accessToken;
        }
        const data = loginJson;
        const error = null;

        if (data?.user) {
          const { data: profile } = await insforge.database.from('users').select('*').eq('id', data.user.id).maybeSingle();
          const dbRole = (profile?.role === 'admin') ? 'admin' : (profile?.role === 'organizer' || profile?.role === 'organiser') ? 'organizer' : 'attendee';
          
          onSuccess({
            id: data.user.id,
            email: data.user.email,
            full_name: profile?.full_name || data.user.user_metadata?.full_name || data.user.email.split('@')[0],
            role: dbRole,
            username: profile?.username || data.user.user_metadata?.username,
            phone_number: profile?.phone_number || data.user.user_metadata?.phone_number,
            state: profile?.state || data.user.user_metadata?.state,
            avatar_url: profile?.avatar_url || data.user.user_metadata?.avatar_url,
            isOrganizer: dbRole === 'organizer'
          });
        }
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'An error occurred during authentication.');
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
        email,
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

  return (
    <div
      style={{
        background: '#060A12',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
        scrollbarWidth: 'none',
        msOverflowStyle: 'none',
        position: 'relative',
      }}
    >
      <style>{`
        ::-webkit-scrollbar { display: none; }
        input::placeholder { color: #8B8FA8; }
        input:-webkit-autofill { -webkit-box-shadow: 0 0 0 1000px #131629 inset !important; -webkit-text-fill-color: #F0F0FF !important; }
      `}</style>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', padding: 'calc(20px + env(safe-area-inset-top)) 20px 0' }}>
        <button
          onClick={() => {
            if (mode === 'forgot') {
              setMode('login');
              setErrorMessage(null);
            } else {
              onBack();
            }
          }}
          style={{
            background: '#131629',
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

        {mode === 'forgot' && forgotSent && forgotOtpStep ? (
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
                Enter Reset Code
              </h2>
              <p style={{ color: '#8B8FA8', fontSize: '14px', lineHeight: 1.65 }}>
                We've sent a 6-digit code to{' '}
                <span style={{ color: '#A78BFA' }}>{email}</span>.
                Enter the code and your new password below.
              </p>
            </div>

            {errorMessage && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '12px', padding: '12px 14px', marginBottom: '20px' }}>
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
                    width: '42px', height: '52px', background: '#131629',
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
                if (forgotOtpCode.length !== 6) { setErrorMessage('Please enter the 6-digit code.'); return; }
                if (!forgotNewPassword) { setErrorMessage('Password is required.'); return; }
                if (forgotNewPassword !== forgotConfirmPassword) { setErrorMessage('Passwords do not match.'); return; }
                setLoading(true);
                setErrorMessage(null);
                try {
                  // Step 1: exchange 6-digit code for a reset token
                  const { data: tokenData, error: exchangeErr } = await insforge.auth.exchangeResetPasswordToken({
                    email: email.trim().toLowerCase(),
                    code: forgotOtpCode,
                  });
                  if (exchangeErr) throw exchangeErr;
                  const resetOtp = tokenData?.token;
                  if (!resetOtp) throw new Error('Failed to exchange code. Please try again.');
                  // Step 2: set the new password using the token
                  const { error } = await insforge.auth.resetPassword({ newPassword: forgotNewPassword, otp: resetOtp });
                  if (error) throw error;
                  setSuccessMessage('Password reset successfully! Please sign in.');
                  setMode('login');
                  setForgotSent(false);
                  setForgotOtpStep(false);
                  setForgotOtpCode('');
                  setForgotNewPassword('');
                  setForgotConfirmPassword('');
                  setPassword('');
                } catch (err: any) {
                  setErrorMessage(err.message || 'Reset failed. Please check the code and try again.');
                } finally {
                  setLoading(false);
                }
              }}
              disabled={loading || forgotOtpCode.length !== 6 || !forgotNewPassword || forgotNewPassword !== forgotConfirmPassword}
              style={{
                ...BTN_PRIMARY,
                background: (loading || forgotOtpCode.length !== 6 || !forgotNewPassword || forgotNewPassword !== forgotConfirmPassword)
                  ? 'rgba(123,47,190,0.35)'
                  : 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)',
                cursor: (loading || forgotOtpCode.length !== 6 || !forgotNewPassword || forgotNewPassword !== forgotConfirmPassword) ? 'not-allowed' : 'pointer',
                marginBottom: '16px',
              }}
            >
              {loading ? 'Resetting...' : 'Reset Password'}
            </button>
            <button
              onClick={() => { setMode('login'); setForgotSent(false); setForgotOtpStep(false); setForgotOtpCode(''); setForgotNewPassword(''); setForgotConfirmPassword(''); setErrorMessage(null); }}
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
                  border: '1px solid rgba(239, 68, 68, 0.25)',
                  borderRadius: '12px',
                  padding: '12px 14px',
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
                    background: '#131629',
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
                background:
                  loading || verificationCode.length !== 6
                    ? 'rgba(123,47,190,0.35)'
                    : 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)',
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
                color: '#F0F0FF',
                fontSize: '26px',
                fontWeight: 800,
                fontFamily: 'Space Grotesk, sans-serif',
                marginBottom: '6px',
              }}
            >
              {mode === 'login' ? 'Welcome back' : mode === 'signup' ? 'Create account' : mode === 'forgot' ? 'Forgot Password' : 'Reset Password'}
            </h2>
            <p style={{ color: '#8B8FA8', fontSize: '14px', marginBottom: '28px' }}>
              {mode === 'login'
                ? 'Sign in to your VENTS account'
                : mode === 'signup'
                ? 'Join thousands discovering Nigerian events'
                : mode === 'forgot'
                ? 'Enter your email to receive a reset link'
                : 'Enter your new password below'}
            </p>

            {errorMessage && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  background: 'rgba(239, 68, 68, 0.1)',
                  border: '1px solid rgba(239, 68, 68, 0.25)',
                  borderRadius: '12px',
                  padding: '12px 14px',
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
                      background: '#131629',
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

                  {/* Role picker */}
                  <div style={{ marginTop: '4px' }}>
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
                  </div>
                </>
              )}
            </div>

            {mode === 'login' && (
              <button
                onClick={() => setMode('forgot')}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#A78BFA',
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
                background: loading || !canSubmit
                  ? 'rgba(123,47,190,0.35)'
                  : 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)',
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
                ? 'Send Reset Link'
                : 'Reset Password'}
            </button>

            {mode !== 'forgot' && mode !== 'reset' && (
              <p style={{ textAlign: 'center', color: '#8B8FA8', fontSize: '14px' }}>
                {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
                <button
                  onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setSuccessMessage(null); }}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#A78BFA',
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
                    color: '#A78BFA',
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

            {mode === 'signup' && (
              <p style={{ textAlign: 'center', color: '#8B8FA8', fontSize: '11px', marginTop: '16px', lineHeight: 1.55 }}>
                By creating an account, you agree to our{' '}
                <span style={{ color: '#A78BFA' }}>Terms of Service</span> and{' '}
                <span style={{ color: '#A78BFA' }}>Privacy Policy</span>
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
            background: '#060A12',
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
              style={{ background: '#131629', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '50%', width: '32px', height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
            >
              <X size={16} color="#C4C9E0" />
            </button>
          </div>

          {/* Search bar */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              background: '#131629',
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
    </div>
  );
}
