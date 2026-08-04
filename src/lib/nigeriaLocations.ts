// Single source of truth for Nigerian state → city/LGA data, shared by
// CreateEventScreen (organizer create/edit) and the Admin Import flow.
// Keyed by the exact `name` string used in StateSelectScreen's
// NIGERIA_STATES (including the FCT's full "Federal Capital Territory
// (Abuja)" name — a prior local copy of this data used the short key
// 'Abuja', which never matched that name and silently left FCT without a
// city dropdown).
export const NIGERIA_STATE_NAMES = [
  'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue',
  'Borno', 'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu',
  'Federal Capital Territory (Abuja)', 'Gombe', 'Imo', 'Jigawa', 'Kaduna',
  'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa', 'Niger',
  'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto', 'Taraba',
  'Yobe', 'Zamfara',
] as const;

export const NIGERIA_CITIES: Record<string, string[]> = {
  'Abia': ['Umuahia', 'Aba', 'Ohafia', 'Arochukwu', 'Isiala Ngwa', 'Bende'],
  'Adamawa': ['Yola', 'Mubi', 'Numan', 'Ganye', 'Jimeta', 'Girei'],
  'Akwa Ibom': ['Uyo', 'Eket', 'Ikot Ekpene', 'Abak', 'Oron', 'Ikot Abasi'],
  'Anambra': ['Awka', 'Onitsha', 'Nnewi', 'Ekwulobia', 'Aguata', 'Ogidi', 'Nkpor'],
  'Bauchi': ['Bauchi', 'Azare', 'Misau', 'Ningi', 'Jama\'are', 'Dass'],
  'Bayelsa': ['Yenagoa', 'Sagbama', 'Ogbia', 'Kolokuma', 'Ekeremor', 'Brass'],
  'Benue': ['Makurdi', 'Gboko', 'Otukpo', 'Katsina-Ala', 'Vandeikya', 'Adikpo'],
  'Borno': ['Maiduguri', 'Biu', 'Gwoza', 'Dikwa', 'Monguno', 'Bama'],
  'Cross River': ['Calabar', 'Ikom', 'Ogoja', 'Obudu', 'Akamkpa', 'Ugep'],
  'Delta': ['Warri', 'Asaba', 'Ughelli', 'Sapele', 'Agbor', 'Abraka', 'Kwale'],
  'Ebonyi': ['Abakaliki', 'Afikpo', 'Onueke', 'Ezza', 'Ishieke', 'Ikwo'],
  'Edo': ['Benin City', 'Auchi', 'Ekpoma', 'Uromi', 'Igarra', 'Ubiaja'],
  'Ekiti': ['Ado Ekiti', 'Ikere Ekiti', 'Ilawe Ekiti', 'Oye Ekiti', 'Ise Ekiti', 'Efon Alaaye'],
  'Enugu': ['Enugu', 'Nsukka', 'Agbani', 'Oji River', 'Udi', 'Awgu'],
  'Federal Capital Territory (Abuja)': ['Garki', 'Maitama', 'Wuse', 'Wuse 2', 'Asokoro', 'Gwarinpa', 'Jabi', 'Utako', 'Life Camp', 'Katampe', 'Central Area', 'Guzape', 'Gwagwalada', 'Kubwa', 'Bwari', 'Kuje', 'Abaji', 'Lugbe', 'Apo', 'Lokogoma', 'Dawaki', 'Karu', 'Nyanya', 'Gudu'],
  'Gombe': ['Gombe', 'Kaltungo', 'Billiri', 'Dukku', 'Kumo', 'Deba'],
  'Imo': ['Owerri', 'Orlu', 'Okigwe', 'Mbaise', 'Oguta', 'Nkwerre'],
  'Jigawa': ['Dutse', 'Hadejia', 'Gumel', 'Ringim', 'Birnin Kudu', 'Kazaure'],
  'Kaduna': ['Kaduna', 'Zaria', 'Kafanchan', 'Soba', 'Jema\'a', 'Lere'],
  'Kano': ['Kano Municipal', 'Fagge', 'Gwale', 'Tarauni', 'Ungogo', 'Nassarawa', 'Kumbotso'],
  'Katsina': ['Katsina', 'Funtua', 'Daura', 'Malumfashi', 'Kankia', 'Dutsin-Ma'],
  'Kebbi': ['Birnin Kebbi', 'Argungu', 'Yauri', 'Zuru', 'Jega', 'Bagudo'],
  'Kogi': ['Lokoja', 'Okene', 'Idah', 'Kabba', 'Ankpa', 'Anyigba'],
  'Kwara': ['Ilorin', 'Offa', 'Erin-Ile', 'Omu-Aran', 'Patigi', 'Jebba'],
  'Lagos': ['Lagos Island', 'Lagos Mainland', 'Ikeja', 'Lekki', 'Victoria Island', 'Ajah', 'Ikorodu', 'Surulere', 'Yaba', 'Badagry'],
  'Nasarawa': ['Lafia', 'Keffi', 'Akwanga', 'Nasarawa', 'Doma', 'Karu'],
  'Niger': ['Minna', 'Bida', 'Kontagora', 'Suleja', 'Zungeru', 'New Bussa'],
  'Ogun': ['Abeokuta', 'Sagamu', 'Ijebu-Ode', 'Ota', 'Ifo', 'Ilaro'],
  'Ondo': ['Akure', 'Ondo City', 'Owo', 'Ikare Akoko', 'Okitipupa', 'Ore'],
  'Osun': ['Osogbo', 'Ile-Ife', 'Ilesa', 'Ede', 'Iwo'],
  'Oyo': ['Ibadan', 'Ogbomosho', 'Oyo', 'Iseyin', 'Saki', 'Eruwa', 'Fiditi'],
  'Plateau': ['Jos', 'Bukuru', 'Pankshin', 'Shendam', 'Wase'],
  'Rivers': ['Port Harcourt', 'Obio-Akpor', 'Eleme', 'Bonny', 'Okrika', 'Oyigbo', 'Degema'],
  'Sokoto': ['Sokoto', 'Wurno', 'Gwadabawa', 'Binji', 'Tambuwal'],
  'Taraba': ['Jalingo', 'Wukari', 'Bali', 'Gembu', 'Zing', 'Ibi'],
  'Yobe': ['Damaturu', 'Potiskum', 'Gashua', 'Nguru', 'Geidam', 'Buni Yadi'],
  'Zamfara': ['Gusau', 'Kaura Namoda', 'Talata Mafara', 'Anka', 'Zurmi', 'Shinkafi'],
};

export function isKnownState(name: string | null | undefined): boolean {
  return !!name && (NIGERIA_STATE_NAMES as readonly string[]).includes(name);
}

export function isKnownCity(state: string | null | undefined, city: string | null | undefined): boolean {
  if (!state || !city) return false;
  return (NIGERIA_CITIES[state] || []).includes(city);
}

// Google Places' addressComponents return a state's long_name in whatever
// form Google's geocoding data has it in (e.g. "Lagos", "Lagos State",
// "Abuja", "Federal Capital Territory") — never guaranteed to exactly match
// this app's canonical NIGERIA_STATE_NAMES strings. Used to normalize a
// Places result into a state CreateEventScreen's picker/dropdown actually
// recognizes, so LocationPicker's auto-fill doesn't silently produce an
// unselected state. Returns null (never guesses) if nothing matches.
export function matchNigeriaState(input: string | null | undefined): string | null {
  if (!input) return null;
  const norm = input.trim().toLowerCase().replace(/\s+state$/, '').trim();
  if (!norm) return null;
  if (norm === 'fct' || norm === 'abuja' || norm.includes('federal capital')) {
    return 'Federal Capital Territory (Abuja)';
  }
  const found = NIGERIA_STATE_NAMES.find((s) => {
    const sNorm = s.toLowerCase().replace(/\s+state$/, '');
    return sNorm === norm || s.toLowerCase() === norm;
  });
  return found || null;
}
