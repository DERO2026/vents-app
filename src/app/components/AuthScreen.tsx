import { useState, useRef } from 'react';
import { ArrowLeft, Eye, EyeOff, Mail, Lock, User, Phone, AlertCircle } from 'lucide-react';
import { AuthMode } from './types';
import { VentsLogo } from './VentsLogo';
import { insforge } from '../../lib/insforge';

interface AuthScreenProps {
  initialMode: AuthMode;
  userRole?: string;
  selectedState?: string;
  onBack: () => void;
  onSuccess: (userProfile: { id: string; email: string; full_name: string | null; role: string; username?: string; phone_number?: string; state?: string }) => void;
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
  boxShadow: '0 8px 32px rgba(123,47,190,0.4)',
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

export function AuthScreen({ initialMode, userRole, selectedState, onBack, onSuccess }: AuthScreenProps) {
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const otpInputRef = useRef<HTMLInputElement>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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
      ? (email.length > 0 && password.length > 0 && username.trim().length > 0 && phone.trim().length > 0 && name.trim().length > 0)
      : (email.length > 0 && password.length > 0)
  );

  const handleEmailBlur = () => setEmailTouched(true);

  const fetchProfileAndSucceed = async (userId: string, userEmail: string) => {
    // Poll public.users to make sure trigger finished inserting profile
    for (let i = 0; i < 5; i++) {
      const { data: profile } = await insforge.database
        .from('users')
        .select('*')
        .eq('id', userId)
        .maybeSingle();

      if (profile) {
        let finalProfile = profile;
        const updates: any = {};
        if (name && profile.full_name !== name) {
          updates.full_name = name;
        }
        if (username.trim() && !profile.username) {
          updates.username = username.trim().toLowerCase();
        }
        if (phone.trim() && !profile.phone_number) {
          updates.phone_number = phone.trim();
        }
        if (selectedState && !profile.state) {
          updates.state = selectedState;
        }

        if (Object.keys(updates).length > 0) {
          const { error: updateError } = await insforge.database
            .from('users')
            .update(updates)
            .eq('id', userId);

          if (!updateError) {
            const { data: updated } = await insforge.database
              .from('users')
              .select('*')
              .eq('id', userId)
              .maybeSingle();
            if (updated) {
              finalProfile = updated;
            }
          }
        }

        onSuccess({
          id: userId,
          email: userEmail,
          full_name: finalProfile.full_name,
          role: finalProfile.role,
          username: finalProfile.username,
          phone_number: finalProfile.phone_number,
          state: finalProfile.state
        });
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    // Fallback if trigger is slow
    onSuccess({
      id: userId,
      email: userEmail,
      full_name: name || userEmail.split('@')[0],
      role: userRole || 'user',
      username: username.trim().toLowerCase(),
      phone_number: phone.trim(),
      state: selectedState
    });
  };

  const handleSubmit = async () => {
    setEmailTouched(true);
    setErrorMessage(null);
    if (!isEmailOrUsernameValid(email)) return;
    setLoading(true);

    try {
      if (mode === 'forgot') {
        if (!email.trim() || !isValidEmail(email)) {
          throw new Error('Please enter a valid email address.');
        }

        // Verify that the email actually exists in public.users
        const { data: existingUser, error: checkError } = await insforge.database
          .from('users')
          .select('id')
          .eq('email', email.trim().toLowerCase())
          .maybeSingle();

        if (checkError) throw checkError;
        if (!existingUser) {
          throw new Error('No account found with this email address.');
        }

        const { error } = await insforge.auth.sendResetPasswordEmail({
          email: email.trim().toLowerCase(),
          redirectTo: window.location.origin
        });
        if (error) throw error;
        setForgotSent(true);
      } else if (mode === 'signup') {
        if (!username.trim()) {
          throw new Error('Username is required.');
        }
        if (!phone.trim()) {
          throw new Error('Phone number is required.');
        }

        // Check uniqueness of email
        const { data: existingEmail, error: emailCheckError } = await insforge.database
          .from('users')
          .select('id')
          .eq('email', email.trim().toLowerCase())
          .maybeSingle();

        if (emailCheckError) throw emailCheckError;
        if (existingEmail) {
          throw new Error('Email already exists');
        }

        // Check uniqueness of phone number
        const { data: existingPhone, error: phoneCheckError } = await insforge.database
          .from('users')
          .select('id')
          .eq('phone_number', phone.trim())
          .maybeSingle();

        if (phoneCheckError) throw phoneCheckError;
        if (existingPhone) {
          throw new Error('Phone number already exists');
        }

        // Check uniqueness of username
        const { data: existingUsername, error: usernameCheckError } = await insforge.database
          .from('users')
          .select('id')
          .eq('username', username.trim().toLowerCase())
          .maybeSingle();

        if (usernameCheckError) throw usernameCheckError;
        if (existingUsername) {
          throw new Error('Username already exists');
        }

        const { data, error } = await insforge.auth.signUp({
          email,
          password,
          name: name,
          role: userRole || 'user',
          username: username.trim().toLowerCase(),
          phone_number: phone.trim(),
          state: selectedState,
          redirectTo: window.location.origin
        });
        if (error) throw error;

        if (data?.requireEmailVerification) {
          setIsVerifying(true);
        } else if (data?.accessToken && data?.user) {
          await fetchProfileAndSucceed(data.user.id, data.user.email);
        }
      } else if (mode === 'login') {
        let loginEmail = email.trim();
        if (!isValidEmail(loginEmail)) {
          // Resolve username to email
          const { data: userRecord, error: resolveError } = await insforge.database
            .from('users')
            .select('email')
            .eq('username', loginEmail.toLowerCase())
            .maybeSingle();
          
          if (resolveError) throw resolveError;
          if (!userRecord || !userRecord.email) {
            throw new Error('No account found with this username.');
          }
          loginEmail = userRecord.email;
        }

        const { data, error } = await insforge.auth.signInWithPassword({
          email: loginEmail,
          password
        });
        if (error) throw error;

        if (data?.user) {
          await fetchProfileAndSucceed(data.user.id, data.user.email);
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
        await fetchProfileAndSucceed(data.user.id, data.user.email);
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
      }}
    >
      <style>{`
        ::-webkit-scrollbar { display: none; }
        input::placeholder { color: #8B8FA8; }
        input:-webkit-autofill { -webkit-box-shadow: 0 0 0 1000px #131629 inset !important; -webkit-text-fill-color: #F0F0FF !important; }
      `}</style>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '20px 20px 0' }}>
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

        {mode === 'forgot' && forgotSent ? (
          <div style={{ textAlign: 'center', paddingTop: '30px' }}>
            <div style={{ fontSize: '52px', marginBottom: '16px' }}>📧</div>
            <h2
              style={{
                color: '#F0F0FF',
                fontSize: '22px',
                fontWeight: 700,
                fontFamily: 'Space Grotesk, sans-serif',
                marginBottom: '10px',
              }}
            >
              Check your inbox
            </h2>
            <p style={{ color: '#8B8FA8', fontSize: '14px', lineHeight: 1.65, marginBottom: '32px' }}>
              We've sent a password reset link to{' '}
              <span style={{ color: '#A78BFA' }}>{email}</span>
            </p>
            <button
              onClick={() => { setMode('login'); setForgotSent(false); }}
              style={BTN_PRIMARY}
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
              {mode === 'login' ? 'Welcome back' : mode === 'signup' ? 'Create account' : 'Reset password'}
            </h2>
            <p style={{ color: '#8B8FA8', fontSize: '14px', marginBottom: '28px' }}>
              {mode === 'login'
                ? 'Sign in to your VENTS account'
                : mode === 'signup'
                ? 'Join thousands discovering Nigerian events'
                : 'Enter your email to receive a reset link'}
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



            {/* Form fields */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '20px' }}>
              {mode === 'signup' && (
                <>
                  <InputRow icon={User} placeholder="Full name" value={name} onChange={setName} />
                  <InputRow icon={User} placeholder="Username" value={username} onChange={setUsername} />
                </>
              )}
              <div onBlur={handleEmailBlur}>
                <InputRow
                  icon={Mail}
                  placeholder={mode === 'login' ? "Email address or username" : "Email address (e.g. name@gmail.com)"}
                  value={email}
                  onChange={(v) => { setEmail(v); if (emailTouched) setEmailTouched(true); }}
                  type={mode === 'login' ? 'text' : 'email'}
                  error={emailError}
                />
              </div>
              {mode !== 'forgot' && (
                <InputRow
                  icon={Lock}
                  placeholder="Password"
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
              {mode === 'signup' && (
                <InputRow
                  icon={Phone}
                  placeholder="Phone number"
                  value={phone}
                  onChange={setPhone}
                  type="tel"
                />
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
                : 'Send Reset Link'}
            </button>

            {mode !== 'forgot' && (
              <p style={{ textAlign: 'center', color: '#8B8FA8', fontSize: '14px' }}>
                {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
                <button
                  onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}
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
    </div>
  );
}
