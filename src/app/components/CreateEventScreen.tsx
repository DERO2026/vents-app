import React, { useState, useRef, useCallback, useEffect } from 'react';
import { ArrowLeft, Camera, Plus, Check, Phone, AlertCircle, X } from 'lucide-react';
import { OrganizerEvent } from './types';
import { supabase } from '../../lib/supabase';
import { sanitize } from '../../lib/sanitize';
import { eventCreateSchema, firstValidationError } from '../../lib/schemas';
import confetti from 'canvas-confetti';
import { haptics } from '../../lib/haptics';
import { NIGERIA_STATES } from './StateSelectScreen';
import { ImageCropperModal } from './ImageCropperModal';
import { EVENT_CARD_ASPECT } from '../../lib/eventCardAspect';
import { CATEGORIES as CATEGORY_LIST } from './categories';
import { uploadImage } from '../../lib/mediaPipeline';
import { PhoneInput, DEFAULT_COUNTRY } from './PhoneInput';
import { withTimeoutFallback } from '../../lib/withTimeoutFallback';
import { hasCapability } from '../../lib/permissions';
import { LocationPicker } from './LocationPicker';
import { NIGERIA_CITIES } from '../../lib/nigeriaLocations';
import { REGION } from '../../lib/regionConfig';
import { PickerField, PickerSheet } from './shared/PickerSheet';
import { pickImage } from '../../lib/pickImage';
import { Sentry } from '../../lib/sentry';

interface CreateEventScreenProps {
  currentUser: { id: string; email: string; full_name: string | null; role: string } | null;
  onBack: () => void;
  onCreated: (event: OrganizerEvent) => void;
  /** When set, the screen loads this event's data and edits it in place instead of creating a new one. */
  editEventId?: string;
  onUpdated?: (event: OrganizerEvent) => void;
}

const MAX_GALLERY_FLIERS = 4;
const ACCEPTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

type Step = 1 | 2 | 3 | 4;

const CATEGORIES = CATEGORY_LIST.map(c => c.id);

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

export function CreateEventScreen({ currentUser, onBack, onCreated, editEventId, onUpdated }: CreateEventScreenProps) {
  const [step, setStep] = useState<Step>(1);
  const [title, setTitle] = useState('');
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const category = selectedCategories[0] || ''; // backward compat for single-value fields
  const [description, setDescription] = useState('');
  
  // Venue / Date states
  const [date, setDate] = useState('');
  // Optional — only set for events that span into a later calendar day.
  // A same-day closing time is still just endTime; endDate stays empty for
  // the common single-day case.
  const [endDate, setEndDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [venue, setVenue] = useState('');
  const [address, setAddress] = useState('');
  const [latitude, setLatitude] = useState<number | null>(null);
  const [longitude, setLongitude] = useState<number | null>(null);
  const [placeId, setPlaceId] = useState<string | null>(null);
  const [city, setCity] = useState('');
  const [stateName, setStateName] = useState('');
  const [showStateModal, setShowStateModal] = useState(false);
  const [showCityModal, setShowCityModal] = useState(false);
  const [capacity, setCapacity] = useState('');
  
  // Tickets states
  interface TicketFormType {
    name: string;
    price: string;
    quantity: string;
    description: string;
  }
  const [ticketTypes, setTicketTypes] = useState<TicketFormType[]>([
    { name: '', price: '', quantity: '', description: '' }
  ]);
  const [contactPhone, setContactPhone] = useState('');
  const [contactPhoneCountryCode, setContactPhoneCountryCode] = useState<string>(DEFAULT_COUNTRY.code);
  const [showPhone, setShowPhone] = useState(false);
  const [is18Plus, setIs18Plus] = useState(false);
  
  // Image states
  const [imageUrl, setImageUrl] = useState('');
  const [imageKey, setImageKey] = useState('');
  const [uploadingImage, setUploadingImage] = useState(false);
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [cropTarget, setCropTarget] = useState<'cover' | 'gallery'>('cover');
  // Holds the already-cropped blob after a failed upload so "Retry" can
  // re-attempt the same processed image instead of forcing the organizer
  // back through picking and cropping from scratch.
  const [pendingFlierUpload, setPendingFlierUpload] = useState<{ blob: Blob; target: 'cover' | 'gallery' } | null>(null);
  // Additional fliers beyond the primary cover (see migrations/20260713160000_event-gallery-urls.sql)
  const [galleryUrls, setGalleryUrls] = useState<string[]>([]);
  const [uploadingGallery, setUploadingGallery] = useState(false);

  // Payout destination for this event — auto-populated with the organizer's
  // default bank account, but they can pick any of their linked accounts.
  const [payoutAccounts, setPayoutAccounts] = useState<{ id: string; bank_name: string; account_number: string; is_default: boolean }[]>([]);
  const [payoutAccountId, setPayoutAccountId] = useState<string | null>(null);

  // General states
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [published, setPublished] = useState(false);
  const publishedEventRef = useRef<OrganizerEvent | null>(null);

  // Edit-mode state — populated from the DB when editEventId is provided
  const [loadingEdit, setLoadingEdit] = useState(!!editEventId);
  const originalStatusRef = useRef<string>('live');
  const originalCreatedAtRef = useRef<number>(Date.now());

  const fileInputRef = useRef<HTMLInputElement>(null);
  const galleryFileInputRef = useRef<HTMLInputElement>(null);
  const stepContentRef = useRef<HTMLDivElement>(null);

  // The step-content scroll container is one persistent DOM node shared by
  // all four steps (only its children swap) — without this, moving between
  // a long step and a short one left the new step rendered mid-scroll or
  // jumped as the browser clamped the stale scrollTop to the new (shorter)
  // scrollHeight, reading as a jittery/unstable layout.
  useEffect(() => {
    stepContentRef.current?.scrollTo({ top: 0 });
  }, [step]);

  // The event's own payout_account_id as loaded from the DB — kept separate
  // from `payoutAccountId` (the actual selection) because it needs to be
  // reconciled against the organizer's currently-active accounts, which can
  // load in either order relative to the event fetch below.
  const [loadedEventPayoutAccountId, setLoadedEventPayoutAccountId] = useState<string | null>(null);

  // Load the organizer's linked, ACTIVE payout accounts. Re-runs on every
  // mount of this screen (i.e. every time Edit Event is opened), so a
  // newly-added or newly-deactivated account is never stale.
  useEffect(() => {
    if (!currentUser?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase
          .from('organizer_bank_accounts')
          .select('id, bank_name, account_number, is_default')
          .eq('organizer_id', currentUser.id)
          .eq('is_active', true)
          .order('is_default', { ascending: false });
        if (cancelled) return;
        setPayoutAccounts((data as any[]) || []);
      } catch { /* non-blocking — the DB trigger still auto-fills the default */ }
    })();
    return () => { cancelled = true; };
  }, [currentUser?.id, editEventId]);

  // Reconcile the selected payout account whenever either the active-accounts
  // list or the loaded event's stored payout_account_id changes, regardless
  // of which resolves first. Prefers the event's own account if it's still
  // active; falls back to the organizer's default active account if it was
  // soft-deleted/deactivated (or no event is loaded, i.e. create mode).
  useEffect(() => {
    if (payoutAccounts.length === 0) return;
    setPayoutAccountId(prev => {
      const preferred = loadedEventPayoutAccountId || prev;
      return preferred && payoutAccounts.some(a => a.id === preferred)
        ? preferred
        : (payoutAccounts.find(a => a.is_default)?.id ?? payoutAccounts[0].id);
    });
  }, [payoutAccounts, loadedEventPayoutAccountId]);

  useEffect(() => {
    if (!editEventId) return;
    let cancelled = false;
    (async () => {
      setLoadingEdit(true);
      try {
        // Failsafe: a hung fetch must never leave the user stuck on the
        // "Loading event…" spinner forever.
        const { data, error } = await withTimeoutFallback(
          Promise.resolve(
            supabase
              .from('events')
              .select('*')
              .eq('id', editEventId)
              .single()
          ),
          { timeoutMs: 8000, timeoutMessage: 'Loading this event is taking too long. Please check your connection and try again.' }
        );
        if (error) throw error;
        if (cancelled || !data) return;
        const row = data as any;
        setTitle(row.title || '');
        // Don't set payoutAccountId directly here — the event's stored
        // payout_account_id may point at a since-soft-deleted/deactivated
        // bank account. The reconciliation effect above validates it against
        // the organizer's current active accounts and falls back to the
        // default if it's no longer valid.
        setLoadedEventPayoutAccountId(row.payout_account_id || null);
        const cats: string[] = Array.isArray(row.categories) && row.categories.length
          ? row.categories
          : (row.category ? [row.category] : []);
        setSelectedCategories(cats);
        setDescription(row.description || '');
        setImageUrl(row.image_url || '');
        setGalleryUrls(Array.isArray(row.gallery_urls) ? row.gallery_urls : []);
        if (row.event_date) setDate(String(row.event_date).split('T')[0]);
        if (row.end_date) setEndDate(String(row.end_date).split('T')[0]);
        setStartTime(row.start_time || '');
        setEndTime(row.end_time || '');
        // location was assembled as "venue, state, city[, address]" on create —
        // parsed back in the same order (see submitEvent's locationString).
        const parts = String(row.location || '').split(', ');
        setVenue(parts[0] || '');
        setStateName(parts[1] || '');
        setCity(parts[2] || '');
        setAddress(parts[3] || '');
        setLatitude(row.latitude != null ? Number(row.latitude) : null);
        setLongitude(row.longitude != null ? Number(row.longitude) : null);
        setPlaceId(row.place_id || null);
        setCapacity(row.ticket_goal != null ? String(row.ticket_goal) : '');
        const tts: TicketFormType[] = Array.isArray(row.ticket_types) && row.ticket_types.length
          ? row.ticket_types.map((t: any) => ({
              name: t.name || '',
              price: t.price != null ? String(t.price) : '',
              quantity: t.quantity != null ? String(t.quantity) : '',
              description: t.description || '',
            }))
          : [{ name: '', price: row.price != null ? String(row.price) : '', quantity: row.ticket_goal != null ? String(row.ticket_goal) : '', description: '' }];
        setTicketTypes(tts);
        setIs18Plus(!!row.is_18_plus);
        setShowPhone(!!row.show_phone);
        setContactPhone(row.show_phone && row.contact_phone ? row.contact_phone : '');
        originalStatusRef.current = row.status || 'live';
        originalCreatedAtRef.current = row.created_at ? new Date(row.created_at).getTime() : Date.now();
      } catch (err: any) {
        setErrorMessage(err.message || 'Failed to load event for editing.');
      } finally {
        if (!cancelled) setLoadingEdit(false);
      }
    })();
    return () => { cancelled = true; };
  }, [editEventId]);

  // Session guard — a null currentUser here is a dropped/expired session (the
  // navigation gate already required an organizer to get this far), NOT an
  // authorization verdict. Show an honest session message instead of the
  // misleading "Access Denied". Creation stays blocked either way — and the
  // server's RLS (organizer_id = auth.uid()) is the real authority.
  if (!currentUser) {
    return (
      <div style={{ background: '#020005', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '24px', textAlign: 'center' }}>
        <div style={{ fontSize: '64px', marginBottom: '20px' }}>⏳</div>
        <h2 style={{ color: '#F0F0FF', fontSize: '22px', fontWeight: 700, fontFamily: 'Space Grotesk, sans-serif', marginBottom: '10px' }}>
          Session Expired
        </h2>
        <p style={{ color: '#8B8FA8', fontSize: '14px', lineHeight: 1.6, marginBottom: '32px' }}>
          Your session needs a quick refresh. Go back and sign in again to continue creating your event.
        </p>
        <button onClick={onBack} style={{ background: 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)', border: 'none', borderRadius: '14px', padding: '12px 28px', color: '#fff', fontSize: '15px', fontWeight: 700, cursor: 'pointer' }}>
          Go Back
        </button>
      </div>
    );
  }

  // Capability-based guard (src/lib/permissions.ts) — mirrors the app-wide
  // navigation gate exactly, off the SAME source of truth, so this can never
  // drift out of sync with it again. (It previously hardcoded its own role
  // list that was missing 'sub-admin' — present in the nav gate's list — so
  // a sub-admin could navigate here only to hit this screen's own, stricter,
  // stale check and see "Access Denied".) Unauthorized users remain blocked
  // here AND by the events INSERT RLS server-side.
  if (!hasCapability(currentUser, 'create_event')) {
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

  const closeCropper = useCallback(() => {
    setCropSrc((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, []);

  // Object URLs created in handleImageChange/handleGalleryFileChange are
  // normally revoked by closeCropper once the crop finishes/cancels — but if
  // the screen unmounts while the cropper is still open (e.g. the user
  // navigates away via onBack from underneath it), that revoke never runs
  // and the blob stays pinned in memory for the life of the page. Tracked
  // via a ref (rather than depending on cropSrc directly) so this only
  // revokes once, on unmount, using whatever URL was current at the time.
  const cropSrcRef = useRef<string | null>(null);
  cropSrcRef.current = cropSrc;
  useEffect(() => {
    return () => { if (cropSrcRef.current) URL.revokeObjectURL(cropSrcRef.current); };
  }, []);

  const uploadFlierBlob = useCallback(async (croppedBlob: Blob): Promise<{ url: string; key: string | null }> => {
    // Production media pipeline: compresses the flier, generates a responsive
    // thumbnail, uploads BOTH directly to the S3-compatible `events` bucket
    // (JWT-signed), and records metadata (dimensions, size, mime, thumbnail) in
    // media_assets. Returns the full-image {url,key} so the rest of the create/
    // edit flow is unchanged; the thumbnail + metadata are captured behind it.
    const asset = await uploadImage(croppedBlob, {
      bucket: 'events',
      userId: currentUser?.id ?? null,
      eventId: editEventId ?? null,
      filenameBase: 'flier',
    });
    return { url: asset.url, key: asset.storageKey };
  }, [currentUser?.id, editEventId]);

  const handleCroppedFlier = useCallback(async (croppedBlob: Blob, isRetry = false) => {
    if (!isRetry) closeCropper();
    const target = cropTarget;
    // Kept for the duration of the attempt so a failure can offer "Retry"
    // against this exact already-cropped image instead of forcing the
    // organizer back through picking and cropping again.
    setPendingFlierUpload({ blob: croppedBlob, target });
    if (target === 'cover') setUploadingImage(true); else setUploadingGallery(true);
    setErrorMessage(null);
    try {
      const { url, key } = await uploadFlierBlob(croppedBlob);
      if (target === 'cover') {
        setImageUrl(url);
        if (key) setImageKey(key);
      } else {
        setGalleryUrls((prev) => [...prev, url]);
      }
      setPendingFlierUpload(null);
    } catch (err: any) {
      setErrorMessage(err.message || 'Image upload failed. Please try again.');
    } finally {
      if (target === 'cover') setUploadingImage(false); else setUploadingGallery(false);
    }
  }, [closeCropper, cropTarget, uploadFlierBlob]);

  const processCoverImageFile = (file: File) => {
    if (uploadingImage) return;

    // Previously only checked file size — a HEIC (common on iPhone camera
    // rolls) or PDF picked from Files would sail past this and only fail
    // deep inside the crop pipeline as an opaque "Could not crop this
    // image", with no indication of what was actually wrong with the file.
    if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
      setErrorMessage('Please choose a JPG, PNG, or WEBP image.');
      return;
    }

    if (file.size > 15 * 1024 * 1024) {
      setErrorMessage('Image file must be under 15MB');
      return;
    }

    // An object URL avoids loading a full-size camera photo (often several
    // MB) into React state as a base64 string, which is heavier to hold
    // and re-decode on lower-end Android WebViews than a lightweight blob
    // reference. Revoked in closeCropper() once the crop is done/cancelled.
    setCropTarget('cover');
    setCropSrc(URL.createObjectURL(file));
  };
  const handleImageChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = '';
    if (file) processCoverImageFile(file);
  };
  const openCoverImagePicker = async () => {
    if (uploadingImage || submitting) return;
    const native = await pickImage();
    if (native) { processCoverImageFile(native); return; }
    fileInputRef.current?.click();
  };

  const processGalleryImageFile = (file: File) => {
    if (uploadingGallery || galleryUrls.length >= MAX_GALLERY_FLIERS) return;
    if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
      setErrorMessage('Please choose a JPG, PNG, or WEBP image.');
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setErrorMessage('Image file must be under 15MB');
      return;
    }
    setCropTarget('gallery');
    setCropSrc(URL.createObjectURL(file));
  };
  const handleGalleryFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = '';
    if (file) processGalleryImageFile(file);
  };
  const openGalleryImagePicker = async () => {
    if (uploadingGallery || submitting || galleryUrls.length >= MAX_GALLERY_FLIERS) return;
    const native = await pickImage();
    if (native) { processGalleryImageFile(native); return; }
    galleryFileInputRef.current?.click();
  };

  const removeGalleryImage = (index: number) => {
    setGalleryUrls((prev) => prev.filter((_, i) => i !== index));
  };

  const submitEvent = async (eventStatus: 'live' | 'draft') => {
    setSubmitting(true);
    setErrorMessage(null);
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
      const eventTimestamp = new Date(`${date}T${startTime}:00${REGION.timezoneOffset}`).toISOString();
      // Optional — only present for a multi-day event. Falls back to the
      // end time on the same calendar day as the start when no end date
      // was set, so a same-day closing time never needs one.
      const endTimestamp = endDate
        ? new Date(`${endDate}T${endTime || startTime}:00${REGION.timezoneOffset}`).toISOString()
        : null;

      // No manual token rehydration needed here (unlike the old InsForge
      // path) — the Supabase client attaches the current session to every
      // request automatically, so auth.uid() resolves in RLS as soon as
      // the user is signed in.

      // withTimeoutFallback below only abandons the WAIT, not the underlying
      // request — a genuinely slow insert can still land server-side after
      // the client has already shown "taking too long, try again." If the
      // user then retries (this same submitEvent call again), that used to
      // insert a second copy of the event. There's no payment_ref-style
      // idempotency key here (unlike ticket purchases), so instead check
      // for an event this organizer just created with this exact
      // title/date/venue in the last 2 minutes — if the earlier "failed"
      // attempt actually went through, treat it as the successful publish
      // rather than inserting again.
      const { data: recentDupe } = await supabase
        .from('events')
        .select('id')
        .eq('organizer_id', currentUser.id)
        .eq('title', sanitize(title))
        .eq('location', locationString)
        .eq('event_date', eventTimestamp)
        .gte('created_at', new Date(Date.now() - 2 * 60 * 1000).toISOString())
        .order('created_at', { ascending: false })
        .limit(1);

      if (recentDupe && recentDupe[0]?.id) {
        const createdEvent: OrganizerEvent = {
          id: recentDupe[0].id,
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
        };
        if (eventStatus === 'live') {
          haptics.success();
          confetti({ particleCount: 150, spread: 75, origin: { y: 0.6 } });
          publishedEventRef.current = createdEvent;
          setPublished(true);
        } else {
          setTimeout(() => onCreated(createdEvent), 500);
        }
        return;
      }

      // Failsafe: a hung insert (flaky connection) must never leave the
      // user stuck on the publish button forever.
      const { data, error } = await withTimeoutFallback(
        Promise.resolve(
          supabase
            .from('events')
            .insert([{
              title: sanitize(title),
              description: sanitize(description),
              image_url: imageUrl,
              gallery_urls: galleryUrls,
              location: locationString,
              latitude,
              longitude,
              place_id: placeId,
              event_date: eventTimestamp,
              end_date: endTimestamp,
              start_time: startTime || null,
              end_time: endTime || null,
              price: Math.min(...ticketTypes.map(t => Number(t.price || 0))),
              category: selectedCategories[0] || '',
              categories: selectedCategories,
              organizer_id: currentUser.id,
              // Explicit payout destination; when null the DB trigger fills in
              // the organizer's default account.
              payout_account_id: payoutAccountId || null,
              status: eventStatus,
              is_18_plus: is18Plus,
              contact_phone: showPhone ? contactPhone : null,
              show_phone: showPhone,
              ticket_types: ticketTypes.map((t, idx) => ({
                id: `t_${idx}`,
                name: t.name.trim(),
                price: Number(t.price),
                quantity: Number(t.quantity),
                description: t.description.trim()
              }))
            }])
            .select('id')
        ),
        { timeoutMs: 8000, timeoutMessage: 'Publishing is taking too long. Please check your connection and try again.' }
      );

      if (error) throw error;

      const createdEvent: OrganizerEvent = {
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
      };

      if (eventStatus === 'live') {
        // Published events get a dedicated success state — no more silent
        // auto-redirect. The user explicitly chooses when to leave via the
        // "Return to Home Page" button (handleReturnHome).
        haptics.success();
        confetti({ particleCount: 150, spread: 75, origin: { y: 0.6 } });
        publishedEventRef.current = createdEvent;
        setPublished(true);
      } else {
        setTimeout(() => onCreated(createdEvent), 500);
      }

    } catch (err: any) {
      console.error('Failed to save event:', err);
      Sentry.captureException(err);
      setErrorMessage(err.message || 'Failed to save event. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const saveEditedEvent = async () => {
    if (!editEventId) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
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

      // A lowered ticket-type quantity or event capacity must never drop
      // below what's already sold -- the server (purchase_ticket) only
      // blocks *future* oversell against whatever cap is in place at
      // purchase time; it has no way to know tickets already existed
      // before this edit. Checked here, not just relying on a DB
      // constraint, so the organizer gets a clear error instead of a
      // silently-inconsistent progress bar (sold > capacity) afterward.
      const newCapacity = Number(capacity) || 0;
      if (newCapacity > 0) {
        const { count: totalSold, error: soldErr } = await supabase
          .from('tickets')
          .select('id', { count: 'exact', head: true })
          .eq('event_id', editEventId)
          .eq('status', 'active');
        if (soldErr) throw soldErr;
        if ((totalSold || 0) > newCapacity) {
          throw new Error(`Capacity can't be set below ${totalSold} -- that many tickets are already sold.`);
        }
      }
      for (const t of ticketTypes) {
        const newQty = Number(t.quantity) || 0;
        if (newQty <= 0) continue;
        const { count: typeSold, error: typeSoldErr } = await supabase
          .from('tickets')
          .select('id', { count: 'exact', head: true })
          .eq('event_id', editEventId)
          .eq('ticket_type', t.name.trim())
          .eq('status', 'active');
        if (typeSoldErr) throw typeSoldErr;
        if ((typeSold || 0) > newQty) {
          throw new Error(`"${t.name.trim()}" quantity can't be set below ${typeSold} -- that many are already sold.`);
        }
      }

      const locationString = `${venue.trim()}, ${stateName.trim()}, ${city.trim()}` + (address ? `, ${address.trim()}` : '');
      const eventTimestamp = new Date(`${date}T${startTime}:00${REGION.timezoneOffset}`).toISOString();
      // Optional — only present for a multi-day event. Falls back to the
      // end time on the same calendar day as the start when no end date
      // was set, so a same-day closing time never needs one.
      const endTimestamp = endDate
        ? new Date(`${endDate}T${endTime || startTime}:00${REGION.timezoneOffset}`).toISOString()
        : null;

      // Failsafe: a hung update must never leave the user stuck on "Save
      // Changes" forever.
      const { error } = await withTimeoutFallback(
        Promise.resolve(
          supabase
            .from('events')
            .update({
              title: sanitize(title),
              description: sanitize(description),
              image_url: imageUrl,
              gallery_urls: galleryUrls,
              location: locationString,
              latitude,
              longitude,
              place_id: placeId,
              event_date: eventTimestamp,
              end_date: endTimestamp,
              start_time: startTime || null,
              end_time: endTime || null,
              price: Math.min(...ticketTypes.map(t => Number(t.price || 0))),
              category: selectedCategories[0] || '',
              categories: selectedCategories,
              ...(payoutAccountId ? { payout_account_id: payoutAccountId } : {}),
              is_18_plus: is18Plus,
              contact_phone: showPhone ? contactPhone : null,
              show_phone: showPhone,
              ticket_types: ticketTypes.map((t, idx) => ({
                id: `t_${idx}`,
                name: t.name.trim(),
                price: Number(t.price),
                quantity: Number(t.quantity),
                description: t.description.trim()
              })),
              ticket_goal: Number(capacity) || 0,
            })
            .eq('id', editEventId)
        ),
        { timeoutMs: 8000, timeoutMessage: 'Saving is taking too long. Please check your connection and try again.' }
      );

      if (error) throw error;

      const updatedEvent: OrganizerEvent = {
        id: editEventId,
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
        status: originalStatusRef.current as any,
        createdAt: originalCreatedAtRef.current,
      };
      onUpdated?.(updatedEvent);
    } catch (err: any) {
      console.error('Failed to update event:', err);
      Sentry.captureException(err);
      setErrorMessage(err.message || 'Failed to update event. Please try again.');
    } finally {
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
      // Nothing previously rejected a date in the past. Every public feed
      // filters on event_date >= today, so a fat-fingered year silently
      // published an event that was instantly invisible everywhere, with
      // no error telling the organizer why.
      if (date < new Date().toISOString().split('T')[0]) {
        setErrorMessage('Event date can\'t be in the past.');
        return;
      }
      if (endDate && endDate < date) {
        setErrorMessage('End date can\'t be before the start date.');
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
      // Field is marked required (label has a *) but was never actually
      // checked -- an empty/non-numeric value silently coerced to 0 on
      // save, which purchase_ticket treats as "unlimited capacity"
      // (ticket_goal > 0 gate), disabling the sold-out check entirely.
      if (!capacity || Number(capacity) <= 0) {
        setErrorMessage('Please enter a valid total capacity.');
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
      // A flyer wasn't required at all — a published event could carry no
      // image_url and fall back to a generic stock photo on every card.
      // Drafts are private and unpublished, so this only gates going live.
      if (!imageUrl) {
        setErrorMessage('Please add a flyer before publishing.');
        return;
      }
      if (editEventId) await saveEditedEvent();
      else await submitEvent('live');
    }
  };

  const handleSaveAsDraft = async () => {
    await submitEvent('draft');
  };

  const handleReturnHome = () => {
    if (publishedEventRef.current) onCreated(publishedEventRef.current);
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
          position: 'relative',
        }}
      >
        {/* No way back once the event is published — there's nothing left
            to navigate back to (it's already live). */}
        {!published ? (
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
              flexShrink: 0,
              position: 'relative',
              zIndex: 1,
            }}
          >
            <ArrowLeft size={16} color="#C4C9E0" />
          </button>
        ) : <div style={{ width: '36px', flexShrink: 0 }} />}
        <h1
          style={{
            color: '#F0F0FF', fontSize: '18px', fontWeight: 700,
            position: 'absolute', left: 0, right: 0, textAlign: 'center', pointerEvents: 'none',
          }}
        >
          {published ? 'Event Published' : editEventId ? 'Edit Event' : 'Create Event'}
        </h1>
        <div style={{ width: '36px', flexShrink: 0 }} />
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
        ref={stepContentRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: `4px 16px ${step === 4 ? '200px' : '120px'}`,
          scrollbarWidth: 'none',
          WebkitOverflowScrolling: 'touch',
          overscrollBehavior: 'contain',
          touchAction: 'pan-y',
        }}
      >
        {errorMessage && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              background: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid rgba(239, 68, 68, 0.25)',
              borderRadius: '12px',
              padding: '12px 14px',
              marginBottom: '16px',
            }}
          >
            <AlertCircle size={18} color="#EF4444" style={{ flexShrink: 0 }} />
            <span style={{ color: '#EF4444', fontSize: '13px', lineHeight: 1.4, flex: 1 }}>{errorMessage}</span>
            {pendingFlierUpload && (
              <button
                onClick={() => handleCroppedFlier(pendingFlierUpload.blob, true)}
                disabled={uploadingImage || uploadingGallery}
                style={{ flexShrink: 0, background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.4)', borderRadius: '8px', padding: '6px 14px', color: '#EF4444', fontSize: '12px', fontWeight: 700, cursor: (uploadingImage || uploadingGallery) ? 'not-allowed' : 'pointer' }}
              >
                {(uploadingImage || uploadingGallery) ? 'Retrying…' : 'Retry'}
              </button>
            )}
          </div>
        )}

        {loadingEdit && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '80px 0', gap: '12px' }}>
            <div style={{ width: '28px', height: '28px', borderRadius: '50%', border: '2px solid rgba(255,255,255,0.15)', borderTopColor: '#A78BFA', animation: 'spin 0.8s linear infinite' }} />
            <p style={{ color: '#8B8FA8', fontSize: '13px' }}>Loading event…</p>
          </div>
        )}

        {!loadingEdit && step === 1 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {/* Image upload */}
            {cropSrc && (
              <ImageCropperModal
                imageSrc={cropSrc}
                onCropComplete={handleCroppedFlier}
                onClose={closeCropper}
                aspect={EVENT_CARD_ASPECT}
                cropShape="rect"
                title="Upload Event Flyer"
                variant="flyer"
              />
            )}
            <div
              onClick={openCoverImagePicker}
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

            {/* Additional fliers — image_url above stays the primary cover
                shown everywhere else in the app; these are extra pages/looks
                an attendee can browse on the event details screen. */}
            <div>
              <Label>Additional Fliers (optional, up to {MAX_GALLERY_FLIERS})</Label>
              <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '2px' }}>
                {galleryUrls.map((url, i) => (
                  <div
                    key={url + i}
                    style={{ position: 'relative', width: '72px', height: '96px', flexShrink: 0, borderRadius: '10px', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)' }}
                  >
                    <img src={url} alt={`Flier ${i + 2}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    <button
                      type="button"
                      onClick={() => removeGalleryImage(i)}
                      style={{ position: 'absolute', top: '3px', right: '3px', background: 'rgba(0,0,0,0.65)', border: 'none', borderRadius: '50%', width: '20px', height: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
                    >
                      <X size={11} color="#fff" />
                    </button>
                  </div>
                ))}
                {galleryUrls.length < MAX_GALLERY_FLIERS && (
                  <button
                    type="button"
                    onClick={openGalleryImagePicker}
                    disabled={uploadingGallery || submitting}
                    style={{
                      width: '72px',
                      height: '96px',
                      flexShrink: 0,
                      borderRadius: '10px',
                      border: '1.5px dashed rgba(167,139,250,0.3)',
                      background: '#090514',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: (uploadingGallery || submitting) ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {uploadingGallery ? (
                      <div style={{ width: '16px', height: '16px', borderRadius: '50%', border: '2px solid rgba(255,255,255,0.2)', borderTopColor: '#A78BFA', animation: 'spin 0.8s linear infinite' }} />
                    ) : (
                      <Plus size={18} color="#A78BFA" />
                    )}
                  </button>
                )}
              </div>
            </div>

            <input
              ref={galleryFileInputRef}
              type="file"
              accept="image/*"
              onChange={handleGalleryFileChange}
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

        {!loadingEdit && step === 2 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ display: 'flex', gap: '10px' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Label>Start Date *</Label>
                <input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  style={INPUT_STYLE}
                />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Label>End Date</Label>
                <input
                  type="date"
                  value={endDate}
                  min={date || undefined}
                  onChange={(e) => setEndDate(e.target.value)}
                  style={INPUT_STYLE}
                />
              </div>
            </div>
            {endDate && endDate !== date && (
              <p style={{ fontSize: '11px', color: '#8B8FA8', marginTop: '-8px' }}>
                This is a multi-day event — it'll show as running from {date} to {endDate}.
              </p>
            )}
            <div style={{ display: 'flex', gap: '10px' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Label>Start Time *</Label>
                <input
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  style={INPUT_STYLE}
                />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
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
              <LocationPicker
                value={{ address, lat: latitude, lng: longitude }}
                onChange={(v) => {
                  setAddress(v.address);
                  setLatitude(v.lat);
                  setLongitude(v.lng);
                  if (v.placeId) setPlaceId(v.placeId);
                  // venue/city/state only arrive on an actual place
                  // selection or pin drag (never on free-typed fallback
                  // text — see LocationValue's doc comment), so this never
                  // clobbers a manual edit mid-keystroke. Still an
                  // auto-fill, not a lock: every field below stays a plain
                  // editable input/dropdown the organizer can override
                  // immediately after picking a place.
                  if (v.venue) setVenue(v.venue);
                  if (v.city) setCity(v.city);
                  if (v.state) setStateName(v.state);
                }}
              />
            </div>
            <div style={{ display: 'flex', gap: '10px' }}>
              <div style={{ flex: 1, position: 'relative' }}>
                <Label>City *</Label>
                {stateName && NIGERIA_CITIES[stateName] ? (
                  <PickerField
                    value={city}
                    placeholder="Select city"
                    onOpen={() => setShowCityModal(true)}
                  />
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
                <PickerField
                  value={stateName}
                  placeholder="Select State"
                  onOpen={() => setShowStateModal(true)}
                />
              </div>
            </div>
            <div>
              <Label>Total Capacity *</Label>
              <input
                type="number"
                min={1}
                max={1000000}
                placeholder="500"
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
                style={INPUT_STYLE}
              />
            </div>
          </div>
        )}

        {!loadingEdit && step === 3 && (
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
                        fontSize: '11px',
                        padding: '4px 8px',
                        borderRadius: '8px',
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
                  <PhoneInput
                    countryCode={contactPhoneCountryCode}
                    onCountryCodeChange={setContactPhoneCountryCode}
                    value={contactPhone}
                    onChange={setContactPhone}
                  />
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
                <div style={{ width: '44px', height: '26px', borderRadius: '13px', background: is18Plus ? '#EF4444' : '#2A2D3E', position: 'relative', transition: 'background 0.2s' }}>
                  <div style={{ position: 'absolute', top: '3px', width: '20px', height: '20px', borderRadius: '50%', background: '#fff', transition: 'left 0.2s', left: is18Plus ? '21px' : '3px' }} />
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

        {!loadingEdit && step === 4 && (
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
                <p style={{ color: '#10B981', fontSize: '14px', fontWeight: 700 }}>{editEventId ? 'Ready to save!' : 'Ready to publish!'}</p>
                <p style={{ color: '#8B8FA8', fontSize: '12px' }}>
                  {editEventId ? 'Review your changes before saving.' : 'Review your event details before publishing.'}
                </p>
              </div>
            </div>

            {[
              { label: 'Title', value: title || '(not set)' },
              { label: 'Category', value: category || '(not set)' },
              { label: 'Date', value: date ? (endDate && endDate !== date ? `${date} – ${endDate}` : date) : '(not set)' },
              { label: 'Time', value: startTime ? `${startTime}${endTime ? ` – ${endTime}` : ''}` : '(not set)' },
              { label: 'Venue', value: venue || '(not set)' },
              { label: 'City', value: city || '(not set)' },
              { label: 'Capacity', value: capacity ? `${capacity} attendees` : '(not set)' },
              { label: 'Additional Fliers', value: galleryUrls.length > 0 ? `${galleryUrls.length} attached` : 'None' },
              {
                label: 'Tickets',
                value: ticketTypes.length > 0
                  ? ticketTypes.map(t => `${t.name || 'Standard'} (₦${Number(t.price || 0).toLocaleString()})`).join(', ')
                  : '(not set)'
              },
              { label: 'Contact Number', value: showPhone && contactPhone ? `${contactPhoneCountryCode} ${contactPhone}` : 'Not shown' },
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
                <span style={{ color: '#8B8FA8', fontSize: '13px', flexShrink: 0 }}>{label}</span>
                <span
                  style={{
                    color: value.includes('not set') ? '#8B8FA8' : '#F0F0FF',
                    fontSize: '13px',
                    fontWeight: 600,
                    textAlign: 'right',
                    maxWidth: '180px',
                    display: 'inline-block',
                    wordBreak: 'break-word',
                  }}
                >
                  {value}
                </span>
              </div>
            ))}

            {/* Payout destination — auto-set to the organizer's default; can be
                changed to any of their linked accounts. */}
            {payoutAccounts.length > 0 && (
              <div style={{ marginTop: '4px' }}>
                <p style={{ color: '#8B8FA8', fontSize: '13px', fontWeight: 600, margin: '0 0 8px' }}>Ticket sales pay out to</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {payoutAccounts.map(acct => {
                    const selected = (payoutAccountId || payoutAccounts.find(a => a.is_default)?.id) === acct.id;
                    return (
                      <button
                        key={acct.id}
                        type="button"
                        onClick={() => setPayoutAccountId(acct.id)}
                        style={{ display: 'flex', alignItems: 'center', gap: '10px', textAlign: 'left', background: selected ? 'rgba(168,85,247,0.12)' : '#090514', border: `1px solid ${selected ? 'rgba(168,85,247,0.5)' : 'rgba(255,255,255,0.06)'}`, borderRadius: '12px', padding: '12px 14px', cursor: 'pointer' }}
                      >
                        <div style={{ width: '16px', height: '16px', borderRadius: '50%', border: `2px solid ${selected ? '#A855F7' : '#555'}`, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {selected && <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#A855F7' }} />}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p style={{ margin: 0, fontSize: '13px', color: '#F0F0FF', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{acct.bank_name}{acct.is_default ? ' · Default' : ''}</p>
                          <p style={{ margin: '1px 0 0', fontSize: '11px', color: '#8B8FA8' }}>{acct.account_number}</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom CTA — unmounted entirely while the flyer cropper is open. The
          wizard's own step navigation must never be reachable (visible or
          tappable) underneath a modal that owns the full screen; the crop
          modal only ever returns an uploaded image and dismisses itself. */}
      {!cropSrc && (
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          background: 'rgba(6,10,18,0.95)',
          backdropFilter: 'blur(20px)',
          borderTop: '1px solid rgba(255,255,255,0.08)',
          padding: '14px 16px calc(28px + env(safe-area-inset-bottom))',
        }}
      >
        <button
          onClick={published ? undefined : handleNext}
          disabled={submitting || uploadingImage || published}
          style={{
            width: '100%',
            background: published
              ? 'linear-gradient(135deg, #059669 0%, #10B981 100%)'
              : (submitting || uploadingImage)
              ? 'rgba(123,47,190,0.4)'
              : 'linear-gradient(135deg, #7B2FBE 0%, #4F46E5 100%)',
            border: 'none',
            borderRadius: '16px',
            padding: '15px',
            color: '#fff',
            fontSize: '16px',
            fontWeight: 700,
            fontFamily: 'Space Grotesk, sans-serif',
            cursor: (submitting || uploadingImage || published) ? 'not-allowed' : 'pointer',
            boxShadow: published ? '0 6px 24px rgba(16,185,129,0.4)' : (submitting || uploadingImage) ? 'none' : '0 6px 24px rgba(123,47,190,0.45)',
          }}
        >
          {published
            ? '✓ Published'
            : submitting
            ? 'Saving...'
            : step === 4
            ? (editEventId ? 'Save Changes' : 'Publish Event')
            : `Next: ${STEPS[step].label}`}
        </button>
        {step === 4 && !submitting && !editEventId && (
          published ? (
            <button
              onClick={handleReturnHome}
              style={{
                width: '100%',
                background: 'transparent',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: '14px',
                padding: '12px',
                color: '#C4C9E0',
                fontSize: '14px',
                fontWeight: 600,
                fontFamily: 'Space Grotesk, sans-serif',
                cursor: 'pointer',
                marginTop: '10px',
              }}
            >
              Return to Home Page
            </button>
          ) : (
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
          )
        )}
      </div>
      )}

      {showStateModal && (
        <PickerSheet
          title="Select State"
          searchPlaceholder="Search state..."
          value={stateName}
          options={NIGERIA_STATES.map((st) => ({ value: st.name, label: st.name }))}
          onSelect={(v) => {
            setStateName(v);
            // A state change can invalidate a previously-picked city that
            // doesn't belong to it.
            if (!NIGERIA_CITIES[v]?.includes(city)) setCity('');
            setShowStateModal(false);
          }}
          onClose={() => setShowStateModal(false)}
        />
      )}

      {showCityModal && stateName && NIGERIA_CITIES[stateName] && (
        <PickerSheet
          title="Select City"
          searchPlaceholder="Search or type a city/area..."
          value={city}
          options={NIGERIA_CITIES[stateName].map((c) => ({ value: c, label: c }))}
          allowCustom
          onSelect={(v) => {
            setCity(v);
            setShowCityModal(false);
          }}
          onClose={() => setShowCityModal(false)}
        />
      )}
    </div>
  );
}
