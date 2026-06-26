const BASE_URL = import.meta.env.VITE_SENDCHAMP_BASE_URL || 'https://api.sendchamp.com/api/v1';
const PUBLIC_KEY = import.meta.env.VITE_SENDCHAMP_PUBLIC_KEY || '';

export async function sendSMS(params: {
  to: string;
  message: string;
  senderId?: string;
}) {
  try {
    const response = await fetch(`${BASE_URL}/sms/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${PUBLIC_KEY}`,
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        to: params.to,
        message: params.message,
        sender_name: params.senderId || 'VENTS',
        route: 'dnd',
      }),
    });
    const data = await response.json();
    return { success: response.ok, data };
  } catch (error) {
    console.error('Sendchamp SMS error:', error);
    return { success: false, error };
  }
}

export async function sendOTP(phoneNumber: string): Promise<{ success: boolean; reference?: string }> {
  try {
    const response = await fetch(`${BASE_URL}/verification/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${PUBLIC_KEY}`,
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        channel: 'sms',
        sender: 'VENTS',
        token_type: 'numeric',
        token_length: 6,
        expiration_time: 10,
        phone_number: phoneNumber,
        meta_data: { app: 'vents' },
      }),
    });
    const data = await response.json();
    return {
      success: response.ok,
      reference: data?.data?.reference,
    };
  } catch (error) {
    return { success: false };
  }
}

export async function verifyOTP(reference: string, otp: string): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/verification/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${PUBLIC_KEY}`,
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        verification_reference: reference,
        verification_code: otp,
      }),
    });
    const data = await response.json();
    return response.ok && data?.data?.status === 'success';
  } catch {
    return false;
  }
}
