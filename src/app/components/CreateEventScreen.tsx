import React, { useState, useRef, useCallback } from 'react';
import { ArrowLeft, Camera, Plus, Check, Phone, AlertCircle, Search, X, ChevronDown } from 'lucide-react';
import { OrganizerEvent } from './types';
import { insforge, getAuthToken } from '../../lib/insforge';
import { sanitize } from '../../lib/sanitize';
import { eventCreateSchema, firstValidationError } from '../../lib/schemas';
import confetti from 'canvas-confetti';
import { NIGERIA_STATES } from './StateSelectScreen';
import { ImageCropperModal } from './ImageCropperModal';
import { CATEGORIES as CATEGORY_LIST } from './categories';
import { compressImage } from '../../lib/compressImage';

interface CreateEventScreenProps {
  currentUser: { id: string; email: string; full_name: string | null; role: string } | null;
  onBack: () => void;
  onCreated: (event: OrganizerEvent) => void;
}

type Step = 1 | 2 | 3 | 4;

const CATEGORIES = CATEGORY_LIST.map(c => c.id);

const NIGERIA_CITIES: Record<string, string[]> = {
  'Lagos': ['Lagos Island', 'Lagos Mainland', 'Ikeja', 'Lekki', 'Victoria Island', 'Ajah', 'Ikorodu', 'Surulere', 'Yaba', 'Badagry'],
  'Abuja': ['Garki', 'Maitama', 'Wuse', 'Asokoro', 'Gwagwalada', 'Kubwa', 'Bwari', 'Kuje', 'Abaji'],
  'Rivers': ['Port Harcourt', 'Obio-Akpor', 'Eleme', 'Bonny', 'Okrika', 'Oyigbo', 'Degema'],
  'Kano': ['Kano Municipal', 'Fagge', 'Gwale', 'Tarauni', 'Ungogo', 'Nassarawa', 'Kumbotso'],
  'Oyo': ['Ibadan', 'Ogbomosho', 'Oyo', 'Iseyin', 'Saki', 'Eruwa', 'Fiditi'],
  'Anambra': ['Awka', 'Onitsha', 'Nnewi', 'Ekwulobia', 'Aguata', 'Ogidi', 'Nkpor'],
  'Delta': ['Warri', 'Asaba', 'Ughelli', 'Sapele', 'Agbor', 'Abraka', 'Kwale'],
  'Enugu': ['Enugu', 'Nsukka', 'Agbani', 'Oji River', 'Udi', 'Awgu'],
  'Imo': ['Owerri', 'Orlu', 'Okigwe', 'Mbaise', 'Oguta', 'Nkwerre'],
  'Ogun': ['Abeokuta', 'Sagamu', 'Ijebu-Ode', 'Ota', 'Ifo', 'Ilaro'],
  'Kaduna': ['Kaduna', 'Zaria', 'Kafanchan', 'Soba', 'Jema\'a', 'Lere'],
  'Cross River': ['Calabar', 'Ikom', 'Ogoja', 'Obudu', 'Akamkpa'],
  'Akwa Ibom': ['Uyo', 'Eket', 'Ikot Ekpene', 'Abak', 'Oron'],
  'Edo': ['Benin City', 'Auchi', 'Ekpoma', 'Uromi', 'Igarra'],
  'Osun': ['Osogbo', 'Ile-Ife', 'Ilesa', 'Ede', 'Iwo'],
  'Kwara': ['Ilorin', 'Offa', 'Erin-Ile', 'Omu-Aran', 'Patigi'],
  'Bayelsa': ['Yenagoa', 'Sagbama', 'Ogbia', 'Kolokuma', 'Ekeremor'],
  'Plateau': ['Jos', 'Bukuru', 'Pankshin', 'Shendam', 'Wase'],
  'Borno': ['Maiduguri', 'Biu', 'Gwoza', 'Dikwa', 'Monguno'],
  'Sokoto': ['Sokoto', 'Wurno', 'Gwadabawa', 'Binji', 'Tambuwal'],
};

const INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  background: '#090514',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: '12px',
  padding: '12px 14px',
  color: '#F0F0FF',
  fontSize: '14px',
  fontFamily: 'Inter, sans-serif',
  outline: 'none',
  boxSizing: 'border-box',
};

function Label({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ color: '#8B8FA8', fontSize: '12px', fontWeight: 600, marginBottom: '6px' }}>
      {children}
    </p>
  );
}

export function CreateEventScreen({ currentUser, onBack, onCreated }: CreateEventScreenProps) {
  const [step, setStep] = useState<Step>(1);
  const [title, setTitle] = useState('');
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const category = selectedCategories[0] || ''; // backward compat for single-value fields
  const [description, setDescription] = useState('');
  
  // Venue / Date states
  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [venue, setVenue] = useState('');
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [stateName, setStateName] = useState('');
  const [showStateModal, setShowStateModal] = useState(false);
  const [stateSearchQuery, setStateSearchQuery] = useState('');
  const [capacity, setCapacity] = useState('');
  
  // Tickets states
  interface TicketFormType {
    name: string;
    price: string;
    quantity: string;
    description: string;
  }
  const [ticketTypes, setTicketTypes] = useState<TicketFormType[]>([
    { name: 'Standard', price: '', quantity: '', description: 'General Admission' }
  ]);
  const [contactPhone, setContactPhone] = useState('');
  const [showPhone, setShowPhone] = useState(false);
  const [is18Plus, setIs18Plus] = useState(false);
  
  // Image states
  const [imageUrl, setImageUrl] = useState('');
  const [imageKey, setImageKey] = useState('');
  const [uploadingImage, setUploadingImage] = useState(false);
  const [cropSrc, setCropSrc] = useState<string | null>(null);

  // General states
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Role permissions guard
  if (!currentUser || (currentUser.role !== 'organizer' && currentUser.role !== 'organiser' && currentUser.role !== 'admin')) {
    return (
      <div
        style={{
          background: '#020005',
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: '64px', marginBottom: '20px' }}>🔒</div>
        <h2
          style={{
            color: '#F0F0FF',
            fontSize: '22px',
            fontWeight: 700,
            fontFamily: 'Space Grotesk, sans-serif',
            marginBottom: '10px',
          }}
        >
          Access Denied
        </h2>
        <p style={{ color: '#8B8FA8', fontSize: '14px', lineHeight: 1.6, marginBottom: '32px' }}>
          Only registered event organizers are authorized to create events on VENTS.
        </p>
        <button
          onClick={onBack}
          style={{
            background: 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)',
            border: 'none',
            borderRadius: '14px',
            padding: '12px 28px',
            color: '#fff',
            fontSize: '15px',
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          Go Back
        </button>
      </div>
    );
  }

  const STEPS = [
    { num: 1, label: 'Details' },
    { num: 2, label: 'Venue' },
    { num: 3, label: 'Tickets' },
    { num: 4, label: 'Review' },
  ];

  const handleCroppedFlier = useCallback(async (croppedBlob: Blob) => {
    setCropSrc(null);
    setUploadingImage(true);
    setErrorMessage(null);
    try {
      const token = await getAuthToken();
      const { blob: compressed, mimeType, extension } = await compressImage(croppedBlob);
      const file = new File([compressed], `flier-${Date.now()}.${extension}`, { type: mimeType });
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(
        `${import.meta.env.VITE_INSFORGE_URL}/api/storage/buckets/events/objects`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formData }
      );
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new Error('Session expired. Please sign out and sign back in, then try again.');
        }
        throw new Error(`Upload failed (${res.status}). Please try again.`);
      }
      const data = await res.json();
      const key: string | null = data?.key ?? null;
      const url: string | null = data?.url ?? (key ? `${import.meta.env.VITE_INSFORGE_URL}/api/storage/buckets/events/objects/${encodeURIComponent(key)}` : null);
      if (!url) throw new Error('Upload succeeded but no URL was returned. Please try again.');
      setImageUrl(url);
      if (key) setImageKey(key);
    } catch (err: any) {
      setErrorMessage(err.message || 'Image upload failed. Please try again.');
    } finally {
      setUploadingImage(false);
    }
  }, []);

  const handleImageChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (uploadingImage) return;
    const file = e.target.files?.[0];
    if (!file) return;

    if (e.target) {
      e.target.value = '';
    }

    if (file.size > 15 * 1024 * 1024) {
      setErrorMessage('Image file must be under 15MB');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => setCropSrc(reader.result as string);
    reader.readAsDataURL(file);
  };

  const submitEvent = async (eventStatus: 'live' | 'draft') => {
    setSubmitting(true);
    setErrorMessage(null);
    const safetyTimer = setTimeout(() => setSubmitting(false), 10000);
    try {
      // Boundary-layer schema validation — rejects malformed/malicious
      // payloads before any DB call is made.
      const eventCheck = eventCreateSchema.safeParse({
        title: title.trim(),
        description: description.trim(),
        venue: venue.trim(),
        city: city.trim(),
        address: address ? address.trim() : undefined,
        ticketTypes: ticketTypes.map(t => ({
          name: t.name.trim(),
          description: t.description.trim(),
          price: Number(t.price),
          quantity: Number(t.quantity),
        })),
      });
      if (!eventCheck.success) throw new Error(firstValidationError(eventCheck));

      const locationString = `${venue.trim()}, ${stateName.trim()}, ${city.trim()}` + (address ? `, ${address.trim()}` : '');
      const eventTimestamp = new Date(`${date}T${startTime}:00`).toISOString();

      // Ensure hc.userToken is set so auth.uid() resolves in RLS policies
      await getAuthToken();

      const { data, error } = await insforge.database
        .from('events')
        .insert([{
          title: sanitize(title),
          description: sanitize(description),
          image_url: imageUrl,
          location: locationString,
          event_date: eventTimestamp,
          start_time: startTime || null,
          end_time: endTime || null,
          price: Math.min(...ticketTypes.map(t => Number(t.price || 0))),
          category: selectedCategories[0] || '',
          categories: selectedCategories,
          organizer_id: currentUser.id,
          status: eventStatus,
          is_18_plus: is18Plus,
          ticket_types: ticketTypes.map((t, idx) => ({
            id: `t_${idx}`,
            name: t.name.trim(),
            price: Number(t.price),
            quantity: Number(t.quantity),
            description: t.description.trim()
          }))
        }])
        .select('id');

      if (error) throw error;

      if (eventStatus === 'live') {
        confetti({ particleCount: 150, spread: 75, origin: { y: 0.6 } });
      }

      setTimeout(() => {
        onCreated({
          id: data?.[0]?.id || (() => { throw new Error('Event created but no ID returned from DB'); })(),
          title: title.trim(),
          category,
          description: description.trim(),
          date,
          startTime,
          venue: venue.trim(),
          city: city.trim(),
          capacity,
          ticketName: ticketTypes[0]?.name || 'Regular',
          ticketPrice: ticketTypes[0]?.price || '0',
          ticketQty: ticketTypes[0]?.quantity || '500',
          contactPhone: showPhone ? contactPhone : '',
          showPhone,
          status: eventStatus,
          createdAt: Date.now(),
        });
      }, eventStatus === 'live' ? 1500 : 500);

    } catch (err: any) {
      console.error('Failed to save event:', err);
      setErrorMessage(err.message || 'Failed to save event. Please try again.');
    } finally {
      clearTimeout(safetyTimer);
      setSubmitting(false);
    }
  };


  const handleNext = async () => {
    setErrorMessage(null);

    if (step === 1) {
      if (!title.trim()) {
        setErrorMessage('Please enter an event title.');
        return;
      }
      if (selectedCategories.length === 0) {
        setErrorMessage('Please select at least one category.');
        return;
      }
      setStep(2);
    } else if (step === 2) {
      if (!date) {
        setErrorMessage('Please select an event date.');
        return;
      }
      if (!startTime) {
        setErrorMessage('Please select a start time.');
        return;
      }
      if (!venue.trim()) {
        setErrorMessage('Please enter the venue name.');
        return;
      }
      if (!stateName.trim()) {
        setErrorMessage('Please select your state.');
        return;
      }
      if (!city.trim()) {
        setErrorMessage('Please enter the city.');
        return;
      }
      setStep(3);
    } else if (step === 3) {
      if (ticketTypes.length === 0) {
        setErrorMessage('Please add at least one ticket type.');
        return;
      }
      for (let i = 0; i < ticketTypes.length; i++) {
        const t = ticketTypes[i];
        if (!t.name.trim()) {
          setErrorMessage(`Please enter a name for ticket type #${i + 1}.`);
          return;
        }
        if (t.price === '' || Number(t.price) < 0) {
          setErrorMessage(`Please enter a valid price for ticket type "${t.name}".`);
          return;
        }
        if (!t.quantity || Number(t.quantity) <= 0) {
          setErrorMessage(`Please enter a valid quantity for ticket type "${t.name}".`);
          return;
        }
      }
      setStep(4);
    } else if (step === 4) {
      await submitEvent('live');
    }
  };

  const handleSaveAsDraft = async () => {
    await submitEvent('draft');
  };

  return (
    <div
      style={{
        background: '#020005',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <style>{`
        input::placeholder, textarea::placeholder { color: #8B8FA8; }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>

      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          padding: 'calc(20px + env(safe-area-inset-top)) 16px 14px',
        }}
      >
        <button
          onClick={step === 1 ? onBack : () => setStep((s) => (s - 1) as Step)}
          disabled={submitting}
          style={{
            background: '#090514',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '50%',
            width: '36px',
            height: '36px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: submitting ? 'not-allowed' : 'pointer',
          }}
        >
          <ArrowLeft size={16} color="#C4C9E0" />
        </button>
        <h1 style={{ color: '#F0F0FF', fontSize: '20px', fontWeight: 700 }}>Create Event</h1>
      </div>

      {/* Step indicator */}
      <div style={{ padding: '0 16px 16px' }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {STEPS.map((s, i) => {
            const isDone = step > s.num;
            const isActive = step === s.num;
            return (
              <React.Fragment key={s.num}>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '4px',
                    flex: 1,
                  }}
                >
                  <div
                    style={{
                      width: '28px',
                      height: '28px',
                      borderRadius: '50%',
                      background: isDone
                        ? '#10B981'
                        : isActive
                        ? 'linear-gradient(135deg, #7B2FBE, #4F46E5)'
                        : '#1A1D2E',
                      border: isActive ? 'none' : '1px solid rgba(255,255,255,0.1)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {isDone ? (
                      <Check size={13} color="#fff" />
                    ) : (
                      <span style={{ color: isActive ? '#fff' : '#8B8FA8', fontSize: '12px', fontWeight: 700 }}>
                        {s.num}
                      </span>
                    )}
                  </div>
                  <span style={{ color: isActive ? '#A78BFA' : '#8B8FA8', fontSize: '10px', fontWeight: isActive ? 600 : 400 }}>
                    {s.label}
                  </span>
                </div>
                {i < STEPS.length - 1 && (
                  <div
                    style={{
                      flex: 1,
                      height: '1px',
                      background: step > s.num ? '#10B981' : 'rgba(255,255,255,0.08)',
                      marginBottom: '16px',
                      transition: 'background 0.3s',
                    }}
                  />
                )}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* Form content */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: `4px 16px ${step === 4 ? '200px' : '120px'}`,
          scrollbarWidth: 'none',
        }}
      >
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
              marginBottom: '16px',
            }}
          >
            <AlertCircle size={18} color="#EF4444" style={{ flexShrink: 0 }} />
            <span style={{ color: '#EF4444', fontSize: '13px', lineHeight: 1.4 }}>{errorMessage}</span>
          </div>
        )}

        {step === 1 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {/* Image upload */}
            {cropSrc && (
              <ImageCropperModal
                imageSrc={cropSrc}
                onCropComplete={handleCroppedFlier}
                onClose={() => setCropSrc(null)}
                aspect={3 / 4}
                cropShape="rect"
                title="Upload Event Flyer"
              />
            )}
            <div
              onClick={() => { if (!uploadingImage && !submitting) fileInputRef.current?.click(); }}
              style={{
                height: '260px',
                background: '#090514',
                border: imageUrl ? '1px solid rgba(167,139,250,0.4)' : '2px dashed rgba(167,139,250,0.3)',
                borderRadius: '16px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                cursor: (uploadingImage || submitting) ? 'not-allowed' : 'pointer',
                position: 'relative',
                overflow: 'hidden',
              }}
            >
              {imageUrl ? (
                <>
                  <img
                    src={imageUrl}
                    alt="Cover preview"
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                  <div
                    style={{
                      position: 'absolute',
                      bottom: '8px',
                      right: '8px',
                      background: 'rgba(0,0,0,0.6)',
                      borderRadius: '8px',
                      padding: '4px 8px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                    }}
                  >
                    <Camera size={12} color="#fff" />
                    <span style={{ color: '#fff', fontSize: '11px', fontWeight: 600 }}>Change</span>
                  </div>
                </>
              ) : uploadingImage ? (
                <div style={{ textAlign: 'center' }}>
                  <div
                    style={{
                      width: '24px',
                      height: '24px',
                      borderRadius: '50%',
                      border: '2px solid rgba(255,255,255,0.2)',
                      borderTopColor: '#A78BFA',
                      animation: 'spin 0.8s linear infinite',
                      margin: '0 auto 8px',
                    }}
                  />
                  <p style={{ color: '#A78BFA', fontSize: '13px', fontWeight: 600 }}>Uploading image...</p>
                </div>
              ) : (
                <>
                  <div
                    style={{
                      width: '44px',
                      height: '44px',
                      borderRadius: '12px',
                      background: 'rgba(167,139,250,0.1)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Camera size={20} color="#A78BFA" />
                  </div>
                  <p style={{ color: '#A78BFA', fontSize: '13px', fontWeight: 600 }}>Upload Cover Image *</p>
                  <p style={{ color: '#8B8FA8', fontSize: '11px' }}>JPG, PNG or GIF · Max 15MB</p>
                </>
              )}
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleImageChange}
              style={{ display: 'none' }}
            />

            <div>
              <Label>Event Title *</Label>
              <input
                placeholder="e.g. Afrobeats Night 2026"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                style={INPUT_STYLE}
              />
            </div>

            <div>
              <Label>Categories * (up to 5)</Label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {CATEGORIES.map((cat) => {
                  const sel = selectedCategories.includes(cat);
                  return (
                    <button
                      key={cat}
                      onClick={() => setSelectedCategories(prev =>
                        sel ? prev.filter(c => c !== cat)
                            : prev.length < 5 ? [...prev, cat] : prev
                      )}
                      style={{
                        background: sel ? 'linear-gradient(135deg, #7B2FBE, #4F46E5)' : '#131629',
                        border: sel ? 'none' : '1px solid rgba(255,255,255,0.08)',
                        borderRadius: '20px',
                        padding: '7px 14px',
                        color: sel ? '#fff' : '#8B8FA8',
                        fontSize: '12px',
                        fontWeight: 500,
                        cursor: 'pointer',
                      }}
                    >
                      {cat}
                    </button>
                  );
                })}
              </div>
              {selectedCategories.length > 0 && (
                <p style={{ fontSize: '11px', color: '#8B8FA8', marginTop: '6px' }}>
                  Selected: {selectedCategories.join(', ')}
                </p>
              )}
            </div>

            <div>
              <Label>Description</Label>
              <textarea
                placeholder="Tell attendees what to expect..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                style={{ ...INPUT_STYLE, resize: 'none' }}
              />
            </div>
          </div>
        )}

        {step === 2 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div>
              <Label>Event Date *</Label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                style={INPUT_STYLE}
              />
            </div>
            <div style={{ display: 'flex', gap: '10px' }}>
              <div style={{ flex: 1 }}>
                <Label>Start Time *</Label>
                <input
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  style={INPUT_STYLE}
                />
              </div>
              <div style={{ flex: 1 }}>
                <Label>End Time</Label>
                <input
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  style={INPUT_STYLE}
                />
              </div>
            </div>
            <div>
              <Label>Venue Name *</Label>
              <input
                placeholder="e.g. Eko Hotel & Suites"
                value={venue}
                onChange={(e) => setVenue(e.target.value)}
                style={INPUT_STYLE}
              />
            </div>
            <div>
              <Label>Full Address</Label>
              <input
                placeholder="Street address, area"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                style={INPUT_STYLE}
              />
            </div>
            <div style={{ display: 'flex', gap: '10px' }}>
              <div style={{ flex: 1, position: 'relative' }}>
                <Label>City *</Label>
                {stateName && NIGERIA_CITIES[stateName] ? (
                  <select
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    style={{ ...INPUT_STYLE, appearance: 'none', height: '45px', cursor: 'pointer' }}
                  >
                    <option value="">Select city</option>
                    {NIGERIA_CITIES[stateName].map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    placeholder={stateName ? 'Enter city' : 'Select state first'}
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    style={INPUT_STYLE}
                  />
                )}
              </div>
              <div style={{ flex: 1 }}>
                <Label>State *</Label>
                <div
                  onClick={() => setShowStateModal(true)}
                  style={{
                    ...INPUT_STYLE,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    cursor: 'pointer',
                    height: '45px',
                  }}
                >
                  <span style={{ color: stateName ? '#F0F0FF' : '#8B8FA8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {stateName || 'Select State'}
                  </span>
                  <ChevronDown size={16} color="#8B8FA8" style={{ flexShrink: 0 }} />
                </div>
              </div>
            </div>
            <div>
              <Label>Total Capacity *</Label>
              <input
                type="number"
                placeholder="500"
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
                style={INPUT_STYLE}
              />
            </div>
          </div>
        )}

        {step === 3 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <p style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 700 }}>Ticket Types</p>

            {ticketTypes.map((ticket, index) => (
              <div
                key={index}
                style={{
                  background: '#090514',
                  border: '1px solid rgba(255,255,255,0.06)',
                  borderRadius: '16px',
                  padding: '14px',
                  position: 'relative'
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600 }}>
                    Ticket Type {index + 1}: {ticket.name || `Type ${index + 1}`}
                  </p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {ticketTypes.length > 1 && (
                      <button
                        type="button"
                        onClick={() => {
                          setTicketTypes(prev => prev.filter((_, i) => i !== index));
                        }}
                        style={{
                          background: 'rgba(239,68,68,0.1)',
                          border: 'none',
                          borderRadius: '8px',
                          color: '#EF4444',
                          fontSize: '11px',
                          fontWeight: 600,
                          padding: '4px 8px',
                          cursor: 'pointer'
                        }}
                      >
                        Remove
                      </button>
                    )}
                    <span
                      style={{
                        background: 'rgba(16,185,129,0.1)',
                        color: '#10B981',
                        fontSize: '10px',
                        padding: '3px 8px',
                        borderRadius: '5px',
                        fontWeight: 600,
                      }}
                    >
                      Active
                    </span>
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div>
                    <Label>Ticket Name</Label>
                    <input
                      placeholder="e.g. VIP, VVIP, Standard"
                      value={ticket.name}
                      onChange={(e) => {
                        const newName = e.target.value;
                        setTicketTypes(prev => prev.map((t, i) => i === index ? { ...t, name: newName } : t));
                      }}
                      style={INPUT_STYLE}
                    />
                  </div>
                  <div style={{ display: 'flex', gap: '10px' }}>
                    <div style={{ flex: 1 }}>
                      <Label>Price (₦)</Label>
                      <input
                        type="number"
                        placeholder="5000"
                        value={ticket.price}
                        onChange={(e) => {
                          const newPrice = e.target.value;
                          setTicketTypes(prev => prev.map((t, i) => i === index ? { ...t, price: newPrice } : t));
                        }}
                        style={INPUT_STYLE}
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <Label>Quantity</Label>
                      <input
                        type="number"
                        placeholder="200"
                        value={ticket.quantity}
                        onChange={(e) => {
                          const newQty = e.target.value;
                          setTicketTypes(prev => prev.map((t, i) => i === index ? { ...t, quantity: newQty } : t));
                        }}
                        style={INPUT_STYLE}
                      />
                    </div>
                  </div>
                  <div>
                    <Label>Description</Label>
                    <input
                      placeholder="e.g. General admission / VIP table access"
                      value={ticket.description}
                      onChange={(e) => {
                        const newDesc = e.target.value;
                        setTicketTypes(prev => prev.map((t, i) => i === index ? { ...t, description: newDesc } : t));
                      }}
                      style={INPUT_STYLE}
                    />
                  </div>
                </div>
              </div>
            ))}

            <button
              type="button"
              onClick={() => {
                setTicketTypes(prev => [...prev, { name: '', price: '', quantity: '', description: '' }]);
              }}
              style={{
                width: '100%',
                background: 'rgba(123,47,190,0.1)',
                border: '1px dashed rgba(123,47,190,0.4)',
                borderRadius: '12px',
                padding: '12px',
                color: '#A855F7',
                fontSize: '13px',
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'Space Grotesk, sans-serif'
              }}
            >
              + Add Ticket Type
            </button>

            {/* Contact phone toggle */}
            <div
              style={{
                background: '#090514',
                border: showPhone ? '1px solid rgba(168,85,247,0.3)' : '1px solid rgba(255,255,255,0.06)',
                borderRadius: '14px',
                padding: '14px',
              }}
            >
              <div
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
                onClick={() => { setShowPhone((v) => !v); if (showPhone) setContactPhone(''); }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div
                    style={{
                      width: '34px',
                      height: '34px',
                      borderRadius: '10px',
                      background: showPhone ? 'rgba(168,85,247,0.15)' : 'rgba(255,255,255,0.05)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Phone size={16} color={showPhone ? '#A855F7' : '#8B8FA8'} />
                  </div>
                  <div>
                    <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 500 }}>Show Contact Number</p>
                    <p style={{ color: '#8B8FA8', fontSize: '12px' }}>Ticket buyers can call or message you</p>
                  </div>
                </div>
                <div
                  style={{
                    width: '44px',
                    height: '26px',
                    borderRadius: '13px',
                    background: showPhone ? 'linear-gradient(135deg, #7B2FBE, #4F46E5)' : '#2A2D3E',
                    position: 'relative',
                    transition: 'background 0.2s',
                    flexShrink: 0,
                  }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      width: '20px',
                      height: '20px',
                      borderRadius: '50%',
                      background: '#fff',
                      top: '3px',
                      left: showPhone ? '21px' : '3px',
                      transition: 'left 0.2s',
                    }}
                  />
                </div>
              </div>

              {showPhone && (
                <div style={{ marginTop: '12px' }}>
                  <Label>Phone Number</Label>
                  <div style={{ position: 'relative' }}>
                    <span
                      style={{
                        position: 'absolute',
                        left: '12px',
                        top: '50%',
                        transform: 'translateY(-50%)',
                        color: '#8B8FA8',
                        fontSize: '14px',
                        userSelect: 'none',
                      }}
                    >
                      +234
                    </span>
                    <input
                      type="tel"
                      placeholder="8012345678"
                      value={contactPhone}
                      onChange={(e) => setContactPhone(e.target.value.replace(/\D/g, '').slice(0, 11))}
                      style={{ ...INPUT_STYLE, paddingLeft: '52px' }}
                    />
                  </div>
                  <p style={{ color: '#8B8FA8', fontSize: '11px', marginTop: '6px' }}>
                    Only visible to attendees who have purchased a ticket for this event.
                  </p>
                </div>
              )}
            </div>

            {/* 18+ toggle */}
            <div
              style={{
                background: '#090514',
                border: is18Plus ? '1px solid rgba(239,68,68,0.35)' : '1px solid rgba(255,255,255,0.06)',
                borderRadius: '14px',
                padding: '14px',
              }}
            >
              <div
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
                onClick={() => setIs18Plus((v) => !v)}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div style={{ width: '34px', height: '34px', borderRadius: '10px', background: is18Plus ? 'rgba(239,68,68,0.15)' : 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <span style={{ fontSize: '16px' }}>🔞</span>
                  </div>
                  <div>
                    <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 500 }}>18+ Event</p>
                    <p style={{ color: '#8B8FA8', fontSize: '12px' }}>Mark this event as adults only</p>
                  </div>
                </div>
                <div style={{ width: '44px', height: '24px', borderRadius: '12px', background: is18Plus ? '#EF4444' : '#2A2D3E', position: 'relative', transition: 'background 0.2s' }}>
                  <div style={{ position: 'absolute', top: '3px', width: '18px', height: '18px', borderRadius: '50%', background: '#fff', transition: 'left 0.2s', left: is18Plus ? '23px' : '3px' }} />
                </div>
              </div>
              {is18Plus && (
                <p style={{ color: '#EF4444', fontSize: '11px', marginTop: '8px', lineHeight: 1.4 }}>
                  You are marking this as an 18+ event. Attendees are responsible for verifying their own age. Vents does not verify ages.
                </p>
              )}
            </div>
          </div>
        )}

        {step === 4 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div
              style={{
                background: 'rgba(16,185,129,0.06)',
                border: '1px solid rgba(16,185,129,0.2)',
                borderRadius: '16px',
                padding: '16px',
                display: 'flex',
                gap: '12px',
                alignItems: 'center',
              }}
            >
              <div
                style={{
                  width: '40px',
                  height: '40px',
                  borderRadius: '50%',
                  background: 'rgba(16,185,129,0.15)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <Check size={20} color="#10B981" />
              </div>
              <div>
                <p style={{ color: '#10B981', fontSize: '14px', fontWeight: 700 }}>Ready to publish!</p>
                <p style={{ color: '#8B8FA8', fontSize: '12px' }}>
                  Review your event details before publishing.
                </p>
              </div>
            </div>

            {[
              { label: 'Title', value: title || '(not set)' },
              { label: 'Category', value: category || '(not set)' },
              { label: 'Date', value: date || '(not set)' },
              { label: 'Time', value: startTime || '(not set)' },
              { label: 'Venue', value: venue || '(not set)' },
              { label: 'City', value: city || '(not set)' },
              { label: 'Capacity', value: capacity ? `${capacity} attendees` : '(not set)' },
              {
                label: 'Tickets',
                value: ticketTypes.length > 0
                  ? ticketTypes.map(t => `${t.name || 'Standard'} (₦${Number(t.price || 0).toLocaleString()})`).join(', ')
                  : '(not set)'
              },
              { label: 'Contact Number', value: showPhone && contactPhone ? `+234 ${contactPhone}` : 'Not shown' },
            ].map(({ label, value }) => (
              <div
                key={label}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  padding: '10px 14px',
                  background: '#090514',
                  borderRadius: '12px',
                  border: '1px solid rgba(255,255,255,0.05)',
                }}
              >
                <span style={{ color: '#8B8FA8', fontSize: '13px' }}>{label}</span>
                <span
                  style={{
                    color: value.includes('not set') ? '#8B8FA8' : '#F0F0FF',
                    fontSize: '13px',
                    fontWeight: 600,
                    textAlign: 'right',
                    maxWidth: '180px',
                  }}
                >
                  {value}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Bottom CTA */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          background: 'rgba(6,10,18,0.95)',
          backdropFilter: 'blur(20px)',
          borderTop: '1px solid rgba(255,255,255,0.08)',
          padding: '14px 16px 28px',
        }}
      >
        <button
          onClick={handleNext}
          disabled={submitting || uploadingImage}
          style={{
            width: '100%',
            background: (submitting || uploadingImage)
              ? 'rgba(123,47,190,0.4)'
              : 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)',
            border: 'none',
            borderRadius: '16px',
            padding: '15px',
            color: '#fff',
            fontSize: '16px',
            fontWeight: 700,
            fontFamily: 'Space Grotesk, sans-serif',
            cursor: (submitting || uploadingImage) ? 'not-allowed' : 'pointer',
            boxShadow: (submitting || uploadingImage) ? 'none' : '0 6px 24px rgba(123,47,190,0.45)',
          }}
        >
          {submitting
            ? 'Saving...'
            : step === 4
            ? 'Publish Event'
            : `Next: ${STEPS[step].label}`}
        </button>
        {step === 4 && !submitting && (
          <button
            onClick={handleSaveAsDraft}
            disabled={submitting || uploadingImage}
            style={{
              width: '100%',
              background: 'transparent',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: '14px',
              padding: '12px',
              color: '#8B8FA8',
              fontSize: '14px',
              fontWeight: 600,
              fontFamily: 'Space Grotesk, sans-serif',
              cursor: 'pointer',
              marginTop: '10px',
            }}
          >
            Save as Draft
          </button>
        )}
      </div>

      {showStateModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: '#020005',
            zIndex: 1000,
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
              onClick={() => setShowStateModal(false)}
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
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {NIGERIA_STATES.filter(s => s.name.toLowerCase().includes(stateSearchQuery.toLowerCase())).map((st) => (
              <div
                key={st.name}
                onClick={() => {
                  setStateName(st.name);
                  setShowStateModal(false);
                  setStateSearchQuery('');
                }}
                style={{
                  background: stateName === st.name ? 'rgba(168,85,247,0.12)' : '#131629',
                  border: stateName === st.name ? '1.5px solid rgba(168,85,247,0.45)' : '1px solid rgba(255,255,255,0.06)',
                  borderRadius: '12px',
                  padding: '14px 16px',
                  cursor: 'pointer',
                  color: '#F0F0FF',
                  fontSize: '14px',
                  fontWeight: stateName === st.name ? 700 : 500,
                }}
              >
                {st.name}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
